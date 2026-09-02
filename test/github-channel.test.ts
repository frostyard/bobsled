import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import { createBobsledGitHubChannel } from '../src/channels/github.ts';
import { GitHubEventStore } from '../src/control-plane/github-events.ts';

const secret = 'test-only-channel-secret';

function signedRequest(body: string, deliveryId: string, eventName = 'issues', contentType = 'application/json') {
	return new Request('https://factory.example/channels/github/webhook', {
		method: 'POST',
		headers: {
			'content-type': contentType,
			'x-github-delivery': deliveryId,
			'x-github-event': eventName,
			'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
		},
		body,
	});
}

function fixture(bodyLimit?: number) {
	const store = new GitHubEventStore(':memory:', () => new Date('2026-09-02T01:00:00.000Z'));
	const ingress = createBobsledGitHubChannel({ webhookSecret: secret, store, bodyLimit });
	const app = new Hono();
	app.use('/channels/github/webhook', ingress.captureExactBody);
	app.route('/channels/github', ingress.channel.route());
	return { app, store };
}

test('Flue verifies, types, and admits a delivery while Bobsled retains its exact bytes', async () => {
	const { app, store } = fixture();
	try {
		const body = '{\n  "action": "opened",\n  "repository": {"id": 7, "full_name": "frostyard/clix"}\n}';
		const first = await app.request(signedRequest(body, 'flue-delivery-1'));
		assert.equal(first.status, 202);
		assert.equal((await first.json() as { duplicate: boolean }).duplicate, false);
		assert.deepEqual(store.readExactPayload('flue-delivery-1'), new TextEncoder().encode(body));

		const repeated = await app.request(signedRequest(body, 'flue-delivery-1'));
		assert.equal(repeated.status, 202);
		assert.equal((await repeated.json() as { duplicate: boolean }).duplicate, true);
		assert.equal(store.metrics().total, 1);
	} finally {
		store.close();
	}
});

test('Flue rejects invalid signatures and media types before durable admission', async () => {
	const { app, store } = fixture();
	try {
		const invalid = signedRequest('{}', 'invalid-signature');
		invalid.headers.set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`);
		assert.equal((await app.request(invalid)).status, 401);
		assert.equal((await app.request(signedRequest('{}', 'wrong-media', 'issues', 'text/plain'))).status, 415);
		assert.equal(store.metrics().total, 0);
	} finally {
		store.close();
	}
});

test('Bobsled applies organization scope and delivery conflict policy after Flue verification', async () => {
	const { app, store } = fixture();
	try {
		const outside = JSON.stringify({ repository: { id: 8, full_name: 'other/repo' } });
		assert.equal((await app.request(signedRequest(outside, 'outside'))).status, 403);

		const first = JSON.stringify({ action: 'opened', repository: { id: 7, full_name: 'frostyard/clix' } });
		const changed = JSON.stringify({ action: 'closed', repository: { id: 7, full_name: 'frostyard/clix' } });
		assert.equal((await app.request(signedRequest(first, 'conflict'))).status, 202);
		assert.equal((await app.request(signedRequest(changed, 'conflict'))).status, 409);
	} finally {
		store.close();
	}
});

test('verified pings are acknowledged and retained without dispatch', async () => {
	const { app, store } = fixture();
	try {
		const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
		const response = await app.request(signedRequest(body, 'ping-1', 'ping'));
		assert.equal(response.status, 200);
		assert.equal(await response.text(), '');
		assert.equal(store.metrics().accepted, 1);
		assert.deepEqual(store.readExactPayload('ping-1'), new TextEncoder().encode(body));
	} finally {
		store.close();
	}
});

test('the shared body limit bounds both evidence capture and Flue ingress', async () => {
	const { app, store } = fixture(16);
	try {
		const response = await app.request(signedRequest(JSON.stringify({ value: 'payload larger than limit' }), 'large'));
		assert.equal(response.status, 413);
		assert.equal(store.metrics().total, 0);
	} finally {
		store.close();
	}
});
