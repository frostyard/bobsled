import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
	IntegrationInvocationConflictError,
	IntegrationInvocationForbiddenError,
	IntegrationInvocationStore,
} from '../src/control-plane/integration-invocation-store.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { IntegrationGateService } from '../src/control-plane/integration-gate-service.ts';
import {
	MultiWorkerParentConflictError,
	MultiWorkerParentForbiddenError,
	MultiWorkerParentStore,
} from '../src/control-plane/multi-worker-parent-store.ts';

const ownerId = 'operator';
const baseCommit = 'a'.repeat(40);

function scopedPlan() {
	return {
		version: 2 as const, summary: 'Integrate one completed prerequisite.',
		tasks: [
			{ id: 'api', title: 'API', objective: 'Build API.', acceptanceCriteria: ['API passes.'], dependsOn: [], fileScopes: [{ kind: 'directory' as const, path: 'src/api' }] },
			{ id: 'integration', title: 'Integration', objective: 'Integrate API.', acceptanceCriteria: ['Integration passes.'], dependsOn: ['api'], fileScopes: [{ kind: 'directory' as const, path: 'src/integration' }] },
		], assumptions: [], risks: [],
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-invocation-'));
	const path = join(root, 'ledger.db');
	const ledger = new JobLedger(path);
	const run = ledger.admit({
		repositoryId: 'frostyard/bobsled',
		workItem: { source: 'manual', key: 'm5-parent', title: 'Integrate API', body: '', labels: [] },
	}, { id: ownerId }, 'admit-parent');
	ledger.close();
	const parents = new MultiWorkerParentStore(path);
	const planId = randomUUID();
	const parent = parents.recordPlan({ planId, jobId: run.jobs[0]?.id, baseCommit, plan: scopedPlan() }, ownerId, 'plan-parent');
	const assemblyId = randomUUID();
	parents.recordAssembly({
		assemblyId, planId, taskId: 'integration',
		result: {
			assemblyId, taskId: 'integration', baseCommit, workspacePath: join(root, 'workspace'),
			appliedTaskIds: ['api'], changedPaths: ['src/api/client.ts'], workerAuthorized: false,
			status: 'assembled', patchSha256: 'b'.repeat(64),
		},
	}, ownerId);
	parents.close();
	return {
		root, path, planId, assemblyId, planSha256: parent.planSha256,
		reservation: { integrationAttemptId: randomUUID(), assemblyId, planSha256: parent.planSha256, taskId: 'integration' },
	};
}

function outcome(integrationAttemptId: string) {
	return {
		integrationAttemptId, taskId: 'integration', status: 'succeeded' as const, workerCallCount: 1 as const,
		workerChangedPaths: ['src/integration/index.ts'], finalPatchSha256: 'c'.repeat(64),
		violations: [], furtherWorkerAuthorized: false as const,
	};
}

test('persists immutable plan and assembly parents through database reopen', () => {
	const value = fixture();
	const reopened = new MultiWorkerParentStore(value.path);
	try {
		assert.equal(reopened.getPlan(value.planId, ownerId).planSha256, value.planSha256);
		const prior = reopened.getAssembly(value.assemblyId, ownerId);
		assert.equal(prior.status, 'assembled');
		assert.equal(reopened.recordAssembly({
			assemblyId: value.assemblyId, planId: value.planId, taskId: 'integration', result: prior.result,
		}, ownerId).assemblyId, value.assemblyId);
		assert.throws(() => reopened.getPlan(value.planId, 'different-operator'), MultiWorkerParentForbiddenError);
		assert.throws(() => reopened.recordAssembly({
			assemblyId: randomUUID(), planId: value.planId, taskId: 'integration',
			result: { ...prior.result, assemblyId: randomUUID() },
		}, ownerId), MultiWorkerParentConflictError);
	} finally { reopened.close(); }
});

test('persists a one-use invocation from reservation through terminal evidence', () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path, () => new Date('2026-09-02T20:00:00.000Z'));
	try {
		const input = value.reservation;
		assert.equal(store.reserve(input, ownerId, 'same-request').status, 'reserved');
		assert.equal(store.claim(input.integrationAttemptId, ownerId).workerCalls, 1);
		const completed = store.complete(input.integrationAttemptId, ownerId, outcome(input.integrationAttemptId));
		assert.equal(completed.status, 'awaiting_gates');
		assert.deepEqual(completed.outcome, outcome(input.integrationAttemptId));
		assert.throws(() => store.claim(input.integrationAttemptId, ownerId), IntegrationInvocationConflictError);
		assert.throws(() => store.complete(input.integrationAttemptId, ownerId, outcome(input.integrationAttemptId)), IntegrationInvocationConflictError);
	} finally { store.close(); }
});

test('runs required gates in policy order and settles durable success evidence', async () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	try {
		store.reserve(value.reservation, ownerId, 'request');
		store.claim(value.reservation.integrationAttemptId, ownerId);
		store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
		const commands: string[] = [];
		const workspaces: string[] = [];
		const timeouts: number[] = [];
		const service = new IntegrationGateService(store, async (command, context, timeoutMs) => {
			commands.push(command);
			workspaces.push(context.workspacePath);
			timeouts.push(timeoutMs);
			return { status: 'passed', exitCode: 0, durationMs: 1, stdout: 'ok', stderr: '', truncated: false };
		});
		await assert.rejects(() => service.run(value.reservation.integrationAttemptId, 'different-operator'), IntegrationInvocationForbiddenError);
		const settled = await service.run(value.reservation.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'succeeded');
		assert.deepEqual(commands, ['npm test', 'npm run check:types', 'npm run build']);
		assert.deepEqual(workspaces, [join(value.root, 'workspace'), join(value.root, 'workspace'), join(value.root, 'workspace')]);
		assert.deepEqual(timeouts, [900_000, 900_000, 900_000]);
		assert.deepEqual(settled.gateResults?.map(({ status }) => status), ['passed', 'passed', 'passed']);
		await assert.rejects(() => service.run(value.reservation.integrationAttemptId, ownerId));
	} finally { store.close(); }
});

test('stops at the first failed gate and settles the invocation blocked', async () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	try {
		store.reserve(value.reservation, ownerId, 'request');
		store.claim(value.reservation.integrationAttemptId, ownerId);
		store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
		let calls = 0;
		const service = new IntegrationGateService(store, async () => {
			calls += 1;
			return calls === 2
				? { status: 'failed', exitCode: 1, durationMs: 1, stdout: '', stderr: 'failed', truncated: false }
				: { status: 'passed', exitCode: 0, durationMs: 1, stdout: 'ok', stderr: '', truncated: false };
		});
		const settled = await service.run(value.reservation.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.gateResults?.length, 2);
		assert.equal(calls, 2);
	} finally { store.close(); }
});

test('records runner failures as terminal gate evidence instead of stranding the invocation', async () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	try {
		store.reserve(value.reservation, ownerId, 'request');
		store.claim(value.reservation.integrationAttemptId, ownerId);
		store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
		const service = new IntegrationGateService(store, async () => { throw new Error('runner unavailable'); });
		const settled = await service.run(value.reservation.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.gateResults?.[0]?.status, 'failed');
		assert.match(settled.gateResults?.[0]?.stderr ?? '', /runner unavailable/);
	} finally { store.close(); }
});

test('persists a trusted gate timeout as terminal blocked evidence', async () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	try {
		store.reserve(value.reservation, ownerId, 'request');
		store.claim(value.reservation.integrationAttemptId, ownerId);
		store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
		const service = new IntegrationGateService(store, async () => ({
			status: 'timed_out', exitCode: null, durationMs: 900_000, stdout: '', stderr: '', truncated: false,
		}));
		const settled = await service.run(value.reservation.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.gateResults?.[0]?.status, 'timed_out');
		assert.equal(settled.gateResults?.length, 1);
	} finally { store.close(); }
});

test('fails workspace-mutating required gates closed without executing them', async () => {
	const value = fixture();
	const db = new Database(value.path);
	const row = db.prepare('SELECT id, policy_snapshot_json FROM jobs LIMIT 1').get() as { id: string; policy_snapshot_json: string };
	const policy = JSON.parse(row.policy_snapshot_json) as { qualityGates: Array<{ id: string; mutatesWorkspace: boolean }> };
	const required = policy.qualityGates.find(({ id }) => id === 'test');
	assert.ok(required);
	required.mutatesWorkspace = true;
	db.prepare('UPDATE jobs SET policy_snapshot_json = ? WHERE id = ?').run(JSON.stringify(policy), row.id);
	db.close();
	const store = new IntegrationInvocationStore(value.path);
	try {
		store.reserve(value.reservation, ownerId, 'request');
		store.claim(value.reservation.integrationAttemptId, ownerId);
		store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
		let calls = 0;
		const service = new IntegrationGateService(store, async () => {
			calls += 1;
			return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
		});
		const settled = await service.run(value.reservation.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(calls, 0);
		assert.match(settled.gateResults?.[0]?.stderr ?? '', /Workspace-mutating/);
	} finally { store.close(); }
});

test('turns an unreadable durable parent into blocked evidence', async () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	store.reserve(value.reservation, ownerId, 'request');
	store.claim(value.reservation.integrationAttemptId, ownerId);
	store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
	store.close();
	const db = new Database(value.path);
	db.prepare("UPDATE jobs SET policy_snapshot_json = '{'").run();
	db.close();
	const reopened = new IntegrationInvocationStore(value.path);
	try {
		const settled = await new IntegrationGateService(reopened, async () => {
			throw new Error('must not execute');
		}).run(value.reservation.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.gateResults?.[0]?.id, 'policy');
	} finally { reopened.close(); }
});

test('rejects gate settlement before worker success and prevents replay', () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	const result = { id: 'test', name: 'Test', command: 'npm test', status: 'passed' as const, exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
	try {
		store.reserve(value.reservation, ownerId, 'request');
		assert.throws(() => store.settleGates(value.reservation.integrationAttemptId, ownerId, [result]), IntegrationInvocationConflictError);
		store.claim(value.reservation.integrationAttemptId, ownerId);
		store.complete(value.reservation.integrationAttemptId, ownerId, outcome(value.reservation.integrationAttemptId));
		assert.equal(store.settleGates(value.reservation.integrationAttemptId, ownerId, [result]).status, 'succeeded');
		assert.throws(() => store.settleGates(value.reservation.integrationAttemptId, ownerId, [result]), IntegrationInvocationConflictError);
	} finally { store.close(); }
});

test('replays identical reservation but rejects mismatched or reused parent evidence', () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	try {
		const input = value.reservation;
		const first = store.reserve(input, ownerId, 'request');
		assert.equal(store.reserve(input, ownerId, 'request').integrationAttemptId, first.integrationAttemptId);
		assert.throws(() => store.reserve({ ...input, planSha256: 'd'.repeat(64) }, ownerId, 'different-plan'), IntegrationInvocationConflictError);
		assert.throws(() => store.reserve({ ...input, integrationAttemptId: randomUUID() }, ownerId, 'another-request'), IntegrationInvocationConflictError);
	} finally { store.close(); }
});

test('serializes claims across database connections and preserves failed history', () => {
	const value = fixture();
	const first = new IntegrationInvocationStore(value.path);
	const second = new IntegrationInvocationStore(value.path);
	try {
		first.reserve(value.reservation, ownerId, 'request');
		assert.equal(first.claim(value.reservation.integrationAttemptId, ownerId).workerCalls, 1);
		assert.throws(() => second.claim(value.reservation.integrationAttemptId, ownerId), IntegrationInvocationConflictError);
		assert.equal(second.fail(value.reservation.integrationAttemptId, ownerId).status, 'failed');
		assert.throws(() => first.claim(value.reservation.integrationAttemptId, ownerId), IntegrationInvocationConflictError);
	} finally { first.close(); second.close(); }
});

test('keeps invocation and parent evidence principal-scoped', () => {
	const value = fixture();
	const store = new IntegrationInvocationStore(value.path);
	try {
		store.reserve(value.reservation, ownerId, 'request');
		assert.throws(() => store.get(value.reservation.integrationAttemptId, 'different-operator'), IntegrationInvocationForbiddenError);
		assert.throws(() => store.reserve({ ...value.reservation, integrationAttemptId: randomUUID() }, 'different-operator', 'request'), IntegrationInvocationForbiddenError);
	} finally { store.close(); }
});
