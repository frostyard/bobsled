import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
	IntegrationInvocationConflictError,
	IntegrationInvocationForbiddenError,
	IntegrationInvocationStore,
} from '../src/control-plane/integration-invocation-store.ts';

function reservation() {
	return { integrationAttemptId: randomUUID(), assemblyId: randomUUID(), planSha256: 'a'.repeat(64), taskId: 'integration' };
}

function outcome(integrationAttemptId: string) {
	return {
		integrationAttemptId, taskId: 'integration', status: 'succeeded' as const, workerCallCount: 1 as const,
		workerChangedPaths: ['src/integration/index.ts'], finalPatchSha256: 'b'.repeat(64),
		violations: [], furtherWorkerAuthorized: false as const,
	};
}

test('persists a one-use invocation from reservation through terminal evidence', () => {
	const store = new IntegrationInvocationStore(':memory:', () => new Date('2026-09-02T20:00:00.000Z'));
	try {
		const input = reservation();
		assert.equal(store.reserve(input, 'operator', 'same-request').status, 'reserved');
		const claimed = store.claim(input.integrationAttemptId, 'operator');
		assert.equal(claimed.status, 'running');
		assert.equal(claimed.workerCalls, 1);
		const completed = store.complete(input.integrationAttemptId, 'operator', outcome(input.integrationAttemptId));
		assert.equal(completed.status, 'succeeded');
		assert.deepEqual(completed.outcome, outcome(input.integrationAttemptId));
		assert.throws(() => store.claim(input.integrationAttemptId, 'operator'), IntegrationInvocationConflictError);
		assert.throws(() => store.complete(input.integrationAttemptId, 'operator', outcome(input.integrationAttemptId)), IntegrationInvocationConflictError);
	} finally {
		store.close();
	}
});

test('replays identical reservation but rejects idempotency and assembly collisions', () => {
	const store = new IntegrationInvocationStore(':memory:');
	try {
		const input = reservation();
		const first = store.reserve(input, 'operator', 'request');
		assert.equal(store.reserve(input, 'operator', 'request').integrationAttemptId, first.integrationAttemptId);
		assert.throws(() => store.reserve({ ...input, taskId: 'different' }, 'operator', 'request'), IntegrationInvocationConflictError);
		assert.throws(() => store.reserve({ ...input, integrationAttemptId: randomUUID() }, 'operator', 'another-request'), IntegrationInvocationConflictError);
	} finally {
		store.close();
	}
});

test('serializes claims across database connections and preserves failed history', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-invocation-'));
	const path = join(root, 'ledger.db');
	const first = new IntegrationInvocationStore(path);
	const second = new IntegrationInvocationStore(path);
	try {
		const input = reservation();
		first.reserve(input, 'operator', 'request');
		assert.equal(first.claim(input.integrationAttemptId, 'operator').workerCalls, 1);
		assert.throws(() => second.claim(input.integrationAttemptId, 'operator'), IntegrationInvocationConflictError);
		assert.equal(second.fail(input.integrationAttemptId, 'operator').status, 'failed');
		assert.throws(() => first.claim(input.integrationAttemptId, 'operator'), IntegrationInvocationConflictError);
	} finally {
		first.close();
		second.close();
	}
});

test('keeps invocation evidence principal-scoped', () => {
	const store = new IntegrationInvocationStore(':memory:');
	try {
		const input = reservation();
		store.reserve(input, 'operator', 'request');
		assert.throws(() => store.get(input.integrationAttemptId, 'different-operator'), IntegrationInvocationForbiddenError);
	} finally {
		store.close();
	}
});
