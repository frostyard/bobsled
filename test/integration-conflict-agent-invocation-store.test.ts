import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
	IntegrationConflictAgentInvocationConflictError,
	IntegrationConflictAgentInvocationForbiddenError,
	IntegrationConflictAgentInvocationStore,
} from '../src/control-plane/integration-conflict-agent-invocation-store.ts';
import { IntegrationConflictAgentPreflightService } from '../src/control-plane/integration-conflict-agent-preflight-service.ts';
import { integrationConflictReplayManifestDigest } from '../src/control-plane/integration-conflict-resolution-contracts.ts';
import { MultiWorkerParentStore } from '../src/control-plane/multi-worker-parent-store.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const ownerId = 'operator';
const baseCommit = 'a'.repeat(40);

function fixture(status: 'blocked' | 'resolved' = 'blocked', includeManifest = true) {
	const path = join(mkdtempSync(join(tmpdir(), 'bobsled-conflict-agent-')), 'ledger.db');
	const database = new Database(path);
	const runId = randomUUID();
	const jobId = randomUUID();
	database.exec(`
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		CREATE TABLE runs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL);
		CREATE TABLE jobs (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL,
			work_item_snapshot_json TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id)
		);
	`);
	database.prepare('INSERT INTO runs (id, owner_id) VALUES (?, ?)').run(runId, ownerId);
	database.prepare('INSERT INTO jobs (id, run_id, policy_snapshot_json, work_item_snapshot_json) VALUES (?, ?, ?, ?)').run(
		jobId, runId, JSON.stringify(getRepository('frostyard/clix')),
		JSON.stringify({ source: 'manual', key: 'conflict-agent', title: 'Resolve the stack', body: '', labels: [] }),
	);
	database.close();

	const parents = new MultiWorkerParentStore(path);
	const planId = randomUUID();
	parents.recordPlan({
		planId, jobId, baseCommit,
		plan: {
			version: 2, summary: 'Resolve dependent changes.', assumptions: [], risks: [],
			tasks: [
				{ id: 'one', title: 'One', objective: 'First change.', acceptanceCriteria: ['First passes.'], dependsOn: [], fileScopes: [{ kind: 'repository' }] },
				{ id: 'integration', title: 'Integration', objective: 'Integrate.', acceptanceCriteria: ['Stack passes.'], dependsOn: ['one'], fileScopes: [{ kind: 'repository' }] },
			],
		},
	}, ownerId, 'plan');
	const assemblyId = randomUUID();
	parents.recordAssembly({
		assemblyId, planId, taskId: 'integration',
		result: {
			assemblyId, taskId: 'integration', baseCommit, workspacePath: '/evidence/rejected/repo',
			appliedTaskIds: [], changedPaths: [], workerAuthorized: false,
			status: 'blocked', reason: 'patch_rejected', failedTaskId: 'one', detail: 'patch rejected',
		},
	}, ownerId);
	const resolutionId = randomUUID();
	const orderedPatches = [{ taskId: 'one', patchSha256: 'c'.repeat(64), changedPaths: ['shared.txt'] }];
	const replayManifest = includeManifest ? {
		orderedPatches, stackSha256: integrationConflictReplayManifestDigest(orderedPatches),
	} : undefined;
	parents.recordConflictResolution({
		resolutionId, sourceAssemblyId: assemblyId,
		result: status === 'blocked' ? {
			resolutionId, sourceAssemblyId: assemblyId, taskId: 'integration', baseCommit,
			workspacePath: '/evidence/resolution/repo', strategy: 'git_three_way', appliedTaskIds: [],
			changedPaths: ['shared.txt'], conflictPaths: ['shared.txt'], replayManifest, modelCalls: 0,
			workerAuthorized: false, status: 'blocked', reason: 'unresolved_conflict',
			failedTaskId: 'one', detail: 'content conflict',
		} : {
			resolutionId, sourceAssemblyId: assemblyId, taskId: 'integration', baseCommit,
			workspacePath: '/evidence/resolution/repo', strategy: 'git_three_way', appliedTaskIds: ['one'],
			changedPaths: ['shared.txt'], conflictPaths: [], replayManifest, modelCalls: 0,
			workerAuthorized: false, status: 'resolved', patchSha256: 'b'.repeat(64),
		},
	}, ownerId);
	parents.close();
	return { path, resolutionId, assemblyId };
}

function passPreflight(store: IntegrationConflictAgentInvocationStore, agentAttemptId: string, sourceResolutionId: string): void {
	store.claimPreflight(agentAttemptId, ownerId);
	store.completePreflight(agentAttemptId, ownerId, {
		agentAttemptId, sourceResolutionId, baseCommit, workspacePath: `/evidence/agent/${agentAttemptId}/repo`,
		preparation: {
			name: 'Prepare', command: 'true', networkAccess: false, status: 'passed', exitCode: 0,
			durationMs: 1, stdout: '', stderr: '', truncated: false,
		},
		headCommit: baseCommit, appliedTaskIds: [], failedTaskId: 'one', changedPaths: ['shared.txt'],
		conflictPaths: ['shared.txt'], nonConflictStateSha256: 'd'.repeat(64),
		conflictStateSha256: 'e'.repeat(64),
		modelCalls: 0, workerAuthorized: false, status: 'passed', violations: [],
	});
}

test('reserves only durable unresolved three-way evidence and reconstructs trusted context', async () => {
	const value = fixture('blocked', false);
	const store = new IntegrationConflictAgentInvocationStore(value.path, () => new Date('2026-09-03T01:00:00.000Z'));
	try {
		const agentAttemptId = randomUUID();
		const lease = store.reserve({ agentAttemptId, sourceResolutionId: value.resolutionId }, ownerId, 'agent-resolution');
		assert.equal(lease.status, 'reserved');
		assert.equal(lease.modelCalls, 0);
		assert.equal(lease.maxModelCalls, 1);
		assert.equal(lease.sourceAssemblyId, value.assemblyId);
		assert.equal(store.reserve({ agentAttemptId, sourceResolutionId: value.resolutionId }, ownerId, 'agent-resolution').agentAttemptId, agentAttemptId);
		const context = store.getContext(agentAttemptId, ownerId);
		assert.deepEqual(context.conflictPaths, ['shared.txt']);
		assert.equal(context.sourceWorkspacePath, '/evidence/resolution/repo');
		assert.equal(context.baseCommit, baseCommit);
		assert.equal(context.repository.id, 'frostyard/clix');
		assert.equal(context.workItem.key, 'conflict-agent');
		assert.throws(() => store.get(agentAttemptId, 'different-operator'), IntegrationConflictAgentInvocationForbiddenError);
		const historical = await new IntegrationConflictAgentPreflightService(store, { workspaceRoot: join(value.path, '..', 'workspaces') })
			.run(agentAttemptId, ownerId);
		assert.equal(historical.status, 'blocked');
		assert.equal(historical.modelCalls, 0);
		assert.deepEqual(historical.preflight?.result?.status === 'blocked' ? historical.preflight.result.violations : [], ['missing_replay_manifest']);
	} finally { store.close(); }

	const resolved = fixture('resolved');
	const ineligible = new IntegrationConflictAgentInvocationStore(resolved.path);
	try {
		assert.throws(() => ineligible.reserve({ agentAttemptId: randomUUID(), sourceResolutionId: resolved.resolutionId }, ownerId, 'resolved'), IntegrationConflictAgentInvocationConflictError);
	} finally { ineligible.close(); }
});

test('permits recovery before spend but enforces one model-bearing claim across processes', () => {
	const value = fixture();
	const first = new IntegrationConflictAgentInvocationStore(value.path, () => new Date('2026-09-03T01:00:00.000Z'));
	const second = new IntegrationConflictAgentInvocationStore(value.path, () => new Date('2026-09-03T01:01:00.000Z'));
	try {
		const abandonedId = randomUUID();
		first.reserve({ agentAttemptId: abandonedId, sourceResolutionId: value.resolutionId }, ownerId, 'abandoned');
		const blocked = first.blockBeforeDispatch(abandonedId, ownerId, 'workspace replay did not reproduce trusted conflicts');
		assert.equal(blocked.status, 'blocked');
		assert.equal(blocked.modelCalls, 0);

		const winnerId = randomUUID();
		const loserId = randomUUID();
		first.reserve({ agentAttemptId: winnerId, sourceResolutionId: value.resolutionId }, ownerId, 'winner');
		second.reserve({ agentAttemptId: loserId, sourceResolutionId: value.resolutionId }, ownerId, 'loser');
		assert.throws(() => first.claim(winnerId, ownerId), IntegrationConflictAgentInvocationConflictError);
		passPreflight(first, winnerId, value.resolutionId);
		passPreflight(second, loserId, value.resolutionId);
		const claim = first.claim(winnerId, ownerId);
		assert.equal(claim.newlyClaimed, true);
		assert.equal(claim.lease.modelCalls, 1);
		assert.equal(first.claim(winnerId, ownerId).newlyClaimed, false);
		assert.throws(() => second.claim(loserId, ownerId), IntegrationConflictAgentInvocationConflictError);
		assert.throws(() => second.reserve({
			agentAttemptId: randomUUID(), sourceResolutionId: value.resolutionId,
		}, ownerId, 'after-spend'), IntegrationConflictAgentInvocationConflictError);
		const failed = first.failClaimed(winnerId, ownerId, 'model receipt was ambiguous; retry forbidden');
		assert.equal(failed.status, 'failed');
		assert.equal(failed.modelCalls, 1);
		assert.throws(() => first.claim(winnerId, ownerId), IntegrationConflictAgentInvocationConflictError);
	} finally {
		first.close();
		second.close();
	}
});

test('rejects idempotency reuse with different source evidence', () => {
	const left = fixture();
	const right = fixture();
	const store = new IntegrationConflictAgentInvocationStore(left.path);
	try {
		store.reserve({ agentAttemptId: randomUUID(), sourceResolutionId: left.resolutionId }, ownerId, 'same-key');
		assert.throws(() => store.reserve({
			agentAttemptId: randomUUID(), sourceResolutionId: right.resolutionId,
		}, ownerId, 'same-key'), IntegrationConflictAgentInvocationConflictError);
	} finally { store.close(); }
});
