import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import app from '../src/app.ts';
import { operatorAuthConfiguration } from '../src/control-plane/operator-auth.ts';
import { operatorSessionStore } from '../src/control-plane/operator-sessions.ts';
import { controlPlaneHtml } from '../src/control-plane/ui.ts';

const authEnvironmentKeys = [
	'BOBSLED_OPERATOR_AUTH_MODE', 'BOBSLED_GITHUB_CLIENT_ID', 'BOBSLED_GITHUB_CLIENT_SECRET',
	'BOBSLED_SESSION_SECRET', 'BOBSLED_PUBLIC_ORIGIN',
] as const;

async function withGitHubAuthEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const before = Object.fromEntries(authEnvironmentKeys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		BOBSLED_OPERATOR_AUTH_MODE: 'github',
		BOBSLED_GITHUB_CLIENT_ID: 'test-client',
		BOBSLED_GITHUB_CLIENT_SECRET: 'test-client-secret',
		BOBSLED_SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
		BOBSLED_PUBLIC_ORIGIN: 'https://factory.example',
	});
	try {
		return await run();
	} finally {
		for (const key of authEnvironmentKeys) {
			const value = before[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('lists only enrolled repositories and exposes their read-only policy', async () => {
	const response = await app.request('/api/repositories');
	assert.equal(response.status, 200);
	const repositories = await response.json() as Array<{
		id: string;
		readOnly: boolean;
		capabilities: { writeGitHub: boolean };
	}>;
	assert.equal(repositories.length, 1);
	assert.equal(repositories[0].id, 'frostyard/clix');
	assert.equal(repositories[0].readOnly, true);
	assert.equal(repositories[0].capabilities.writeGitHub, false);
});

test('serves clix dry-run fixtures and rejects unenrolled repositories', async () => {
	const fixtures = await app.request('/api/repositories/frostyard/clix/fixtures');
	assert.equal(fixtures.status, 200);
	assert.equal((await fixtures.json() as unknown[]).length, 2);

	const missing = await app.request('/api/repositories/frostyard/not-enrolled/fixtures');
	assert.equal(missing.status, 404);
});

test('serves the local factory interface', async () => {
	const response = await app.request('/');
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /BOB<span>SLED/);
	assert.match(html, /Trusted local<\/span><strong>Local operator/);
	assert.match(html, /Trusted final evidence/);
	assert.match(html, /Next safe action:/);
	assert.match(html, /Revise task from findings/);
	assert.match(html, /NEW TRIAGE DECISION · NOT YET ADMITTED/);
	assert.match(html, /Admit for human approval/);
	assert.match(html, /RUN ADMITTED · AWAITING HUMAN APPROVAL/);
	assert.match(html, /Factory board/);
	assert.match(html, /How lane assignment works/);
	assert.match(html, /Admitted run is pending authorization/);
	assert.match(html, /data-lane="attention"/);
	assert.match(html, /function openDrawer/);
	assert.match(html, /Audit timeline/);
	const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script, 'expected the control-plane module script');
	assert.doesNotThrow(() => new vm.Script(`(async () => {${script}})()`));
});

test('escapes server-rendered operator identity', () => {
	const html = controlPlaneHtml({ provider: 'github', login: '<operator&admin>' });
	assert.match(html, /@&lt;operator&amp;admin&gt;/);
	assert.doesNotMatch(html, /@<operator&admin>/);
});

test('serves a typed operator board projection', async () => {
	const response = await app.request('/api/operator-board');
	assert.equal(response.status, 200);
	const board = await response.json() as { generatedAt?: string; cards?: unknown[] };
	assert.equal(typeof board.generatedAt, 'string');
	assert.equal(Array.isArray(board.cards), true);
});

test('creates RFC 4122 UUIDs when randomUUID is unavailable over private HTTP', async () => {
	const html = await (await app.request('/')).text();
	const helper = html.match(/function browserUuid\(\) \{[\s\S]*?\n\}\n\nasync function json/)?.[0]
		.replace(/\n\nasync function json$/, '');
	assert.ok(helper, 'expected the browser UUID compatibility helper');
	const context = {
		crypto: {
			getRandomValues(bytes: Uint8Array) {
				bytes.set(Array.from({ length: 16 }, (_, index) => index));
				return bytes;
			},
		},
		result: '',
	};
	vm.runInNewContext(`${helper}\nresult = browserUuid();`, context);
	assert.equal(context.result, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('reports GitHub App readiness without exposing credential values', async () => {
	const response = await app.request('/api/github-app/status');
	assert.equal(response.status, 200);
	const status = await response.json() as Record<string, unknown>;
	assert.deepEqual(Object.keys(status).sort(), [
		'appIdConfigured',
		'installationIdConfigured',
		'privateKeyConfigured',
		'readyForApi',
		'readyForWebhooks',
		'webhookSecretConfigured',
		'webhooks',
	]);
	assert.equal(typeof status.webhooks, 'object');
	delete status.webhooks;
	assert.equal(Object.values(status).every((value) => typeof value === 'boolean'), true);
});

test('keeps the Flue GitHub channel unavailable until its protected secret is configured', async () => {
	const response = await app.request('/channels/github/webhook', { method: 'POST' });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'GitHub webhooks are not configured' });
});

test('reports aggregate observability health without exposing event content', async () => {
	const response = await app.request('/api/observability/status');
	assert.equal(response.status, 200);
	const status = await response.json() as Record<string, unknown>;
	for (const key of ['byType', 'processes', 'storedBytes', 'total']) assert.equal(key in status, true);
	assert.equal(Object.keys(status).every((key) => ['byType', 'lastObservedAt', 'processes', 'storedBytes', 'total'].includes(key)), true);
	assert.equal('payload' in status, false);
});

test('admits GitHub issue actions as blocked evidence while repository writes are disabled', async () => {
	const response = await app.request('/api/github-actions', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': 'app-test-blocked-action' },
		body: JSON.stringify({
			kind: 'set_triage_label', repositoryId: 'frostyard/clix', issueNumber: 12, label: 'bobsled:ready',
		}),
	});
	assert.equal(response.status, 201);
	const action = await response.json() as { status: string; blockedReason?: string };
	assert.equal(action.status, 'blocked');
	assert.match(action.blockedReason ?? '', /read-only/);
});

test('GitHub mode redirects the UI and rejects unauthenticated APIs', async () => {
	await withGitHubAuthEnvironment(async () => {
		const page = await app.request('https://factory.example/');
		assert.equal(page.status, 302);
		assert.equal(page.headers.get('location'), '/auth/github/login');
		const api = await app.request('https://factory.example/api/repositories');
		assert.equal(api.status, 401);
		const rawAgent = await app.request('https://factory.example/agents/bobsled');
		assert.equal(rawAgent.status, 401);
		const login = await app.request('https://factory.example/auth/github/login');
		assert.equal(login.status, 302);
		assert.match(login.headers.get('location') ?? '', /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
		assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/);
		assert.match(login.headers.get('set-cookie') ?? '', /Secure/);
	});
});

test('GitHub mode exposes only the bounded unauthenticated ingress paths', async () => {
	await withGitHubAuthEnvironment(async () => {
		assert.equal((await app.request('https://factory.example/health')).status, 200);
		assert.equal((await app.request('https://factory.example/api/github-app/status')).status, 200);
		assert.equal((await app.request('https://factory.example/api/operator-auth/status')).status, 200);
		assert.equal((await app.request('https://factory.example/auth/github/callback')).status, 400);
		assert.equal((await app.request('https://factory.example/api/observability/status')).status, 401);
		assert.equal((await app.request('https://factory.example/api/operator-board')).status, 401);
	});
});

test('authenticated principals reach protected routes and mutations enforce origin', async () => {
	await withGitHubAuthEnvironment(async () => {
		const configuration = operatorAuthConfiguration()!;
		const login = operatorSessionStore.begin(configuration);
		const fakeFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith('/access_token')) return Response.json({ access_token: 'temporary' });
			if (url.endsWith('/user')) return Response.json({ id: 999, login: 'operator' });
			return Response.json({ state: 'active', role: 'member', organization: { login: 'frostyard' } });
		};
		const completed = await operatorSessionStore.complete({
			code: 'code', state: login.state, stateCookie: login.state, configuration, fetch: fakeFetch,
		});
		const headers = { cookie: `__Host-bobsled-session=${completed.sessionCookie}` };
		const page = await app.request('https://factory.example/', { headers });
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.match(html, /GitHub<\/span><strong>@operator/);
		assert.doesNotMatch(html, /github:999|member/);
		assert.equal((await app.request('https://factory.example/api/runs', { headers })).status, 200);
		assert.equal((await app.request('https://factory.example/api/runs', { method: 'POST', headers })).status, 403);
		assert.equal((await app.request('https://factory.example/auth/logout', {
			method: 'POST', headers: { ...headers, origin: 'https://factory.example' },
		})).status, 204);
		assert.equal((await app.request('https://factory.example/api/runs', { headers })).status, 401);
	});
});
