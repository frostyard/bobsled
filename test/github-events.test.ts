import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	GitHubEventStore,
	WebhookConflictError,
	WebhookForbiddenError,
} from '../src/control-plane/github-events.ts';

function delivery(store: GitHubEventStore, id: string, body: Record<string, unknown>, eventName = 'installation') {
	const payload = new TextEncoder().encode(JSON.stringify(body));
	return store.recordVerified({ deliveryId: id, eventName, payload, decodedPayload: body });
}

test('admits a verified delivery once and snapshots installation authority', () => {
	const store = new GitHubEventStore(':memory:', () => new Date('2026-09-01T12:00:00.000Z'));
	try {
		const body = {
			action: 'created',
			installation: {
				id: 42,
				account: { login: 'frostyard', type: 'Organization' },
				repository_selection: 'selected',
				permissions: { issues: 'write', contents: 'read' },
				events: ['issues'],
				suspended_at: null,
			},
		};
		const first = delivery(store, 'delivery-1', body);
		const repeated = delivery(store, 'delivery-1', body);
		assert.equal(first.duplicate, false);
		assert.equal(first.installationId, 42);
		assert.equal(repeated.duplicate, true);
		assert.deepEqual(store.metrics(), {
			total: 1,
			accepted: 1,
			ignored: 0,
			installationSnapshots: 1,
			lastReceivedAt: '2026-09-01T12:00:00.000Z',
		});
	} finally {
		store.close();
	}
});

test('rejects delivery ID reuse with changed verified content', () => {
	const store = new GitHubEventStore(':memory:');
	try {
		delivery(store, 'reused', { action: 'one' }, 'issues');
		assert.throws(() => delivery(store, 'reused', { action: 'two' }, 'issues'), WebhookConflictError);
	} finally {
		store.close();
	}
});

test('retains unknown valid event names as ignored deliveries', () => {
	const store = new GitHubEventStore(':memory:');
	try {
		const recorded = delivery(store, 'future-event', { action: 'new' }, 'future_event');
		assert.equal(recorded.status, 'ignored');
		assert.equal(store.metrics().ignored, 1);
	} finally {
		store.close();
	}
});

test('rejects signed deliveries for installations outside frostyard', () => {
	const store = new GitHubEventStore(':memory:');
	try {
		assert.throws(() => delivery(store, 'other-org', {
			installation: { id: 99, account: { login: 'someone-else' }, permissions: {} },
		}), WebhookForbiddenError);
		assert.equal(store.metrics().total, 0);
	} finally {
		store.close();
	}
});
