import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
	IntegrationConflictResolutionError,
	IntegrationConflictResolutionService,
} from '../src/control-plane/integration-conflict-resolution-service.ts';
import type { IntegrationAssemblyPlan } from '../src/control-plane/integration-assembly-contracts.ts';
import { IntegrationWorkspaceService, type IntegrationPatchPayload } from '../src/control-plane/integration-workspace-service.ts';
import {
	MultiWorkerParentConflictError,
	MultiWorkerParentForbiddenError,
	MultiWorkerParentStore,
} from '../src/control-plane/multi-worker-parent-store.ts';
import { IntegrationConflictPromotionService } from '../src/control-plane/integration-conflict-promotion-service.ts';
import { IntegrationInvocationStore } from '../src/control-plane/integration-invocation-store.ts';
import { IntegrationConflictAgentInvocationStore } from '../src/control-plane/integration-conflict-agent-invocation-store.ts';
import { IntegrationConflictAgentPreflightService } from '../src/control-plane/integration-conflict-agent-preflight-service.ts';
import { IntegrationConflictAgentOrchestrationService } from '../src/control-plane/integration-conflict-agent-orchestration-service.ts';
import type {
	IntegrationConflictAgentInitialData,
	IntegrationConflictAgentOutcome,
} from '../src/control-plane/integration-conflict-agent-contracts.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-conflict-resolution-'));
	const source = join(root, 'source');
	const workspaces = join(root, 'workspaces');
	mkdirSync(source);
	git(source, ['init', '--quiet', '--initial-branch=main']);
	git(source, ['config', 'user.name', 'Bobsled Test']);
	git(source, ['config', 'user.email', 'bobsled@example.invalid']);
	writeFileSync(join(source, 'shared.txt'), Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
	git(source, ['add', '.']);
	git(source, ['commit', '--quiet', '-m', 'base']);
	return { root, source, workspaces, baseCommit: git(source, ['rev-parse', 'HEAD']) };
}

function patch(source: string, line: number, content: string, taskId: string): IntegrationPatchPayload {
	const path = join(source, 'shared.txt');
	const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
	lines[line - 1] = content;
	writeFileSync(path, `${lines.join('\n')}\n`);
	const value = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', 'shared.txt'], { cwd: source, encoding: 'utf8' });
	git(source, ['restore', 'shared.txt']);
	return { taskId, patchSha256: createHash('sha256').update(value).digest('hex'), patch: value };
}

function plan(baseCommit: string, payloads: IntegrationPatchPayload[]): IntegrationAssemblyPlan {
	return {
		taskId: 'integration', baseCommit, prerequisiteTaskIds: payloads.map(({ taskId }) => taskId),
		orderedPatches: payloads.map(({ taskId, patchSha256 }) => ({ taskId, patchSha256, changedPaths: ['shared.txt'] })),
		ready: true, blockers: [], executionAuthorized: false,
	};
}

async function rejectedAssembly(value: ReturnType<typeof fixture>, payloads: IntegrationPatchPayload[]) {
	return new IntegrationWorkspaceService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.assemble(randomUUID(), plan(value.baseCommit, payloads), payloads);
}

test('resolves a rejected non-overlapping patch stack in a new three-way workspace', async () => {
	const value = fixture();
	const payloads = [patch(value.source, 4, 'task one', 'one'), patch(value.source, 6, 'task two', 'two')];
	const rejected = await rejectedAssembly(value, payloads);
	assert.equal(rejected.status, 'blocked');
	assert.equal(rejected.status === 'blocked' ? rejected.reason : '', 'patch_rejected');
	const result = await new IntegrationConflictResolutionService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.resolve(randomUUID(), rejected, plan(value.baseCommit, payloads), payloads);
	assert.equal(result.status, 'resolved');
	assert.equal(result.modelCalls, 0);
	assert.equal(result.workerAuthorized, false);
	assert.notEqual(result.workspacePath, rejected.workspacePath);
	assert.match(readFileSync(join(result.workspacePath, 'shared.txt'), 'utf8'), /task one/);
	assert.match(readFileSync(join(result.workspacePath, 'shared.txt'), 'utf8'), /task two/);
});

test('preserves unresolved conflict markers as blocked evidence without model authority', async () => {
	const value = fixture();
	const payloads = [patch(value.source, 5, 'task one', 'one'), patch(value.source, 5, 'task two', 'two')];
	const rejected = await rejectedAssembly(value, payloads);
	assert.equal(rejected.status, 'blocked');
	const result = await new IntegrationConflictResolutionService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.resolve(randomUUID(), rejected, plan(value.baseCommit, payloads), payloads);
	assert.equal(result.status, 'blocked');
	if (result.status !== 'blocked') return;
	assert.equal(result.reason, 'unresolved_conflict');
	assert.deepEqual(result.conflictPaths, ['shared.txt']);
	assert.equal(result.modelCalls, 0);
	assert.equal(result.workerAuthorized, false);
	assert.equal(result.replayManifest?.orderedPatches.length, 2);
});

async function durableBlockedResolution(includeRemainingPatch = false) {
	const value = fixture();
	const payloads = [patch(value.source, 5, 'task one', 'one'), patch(value.source, 5, 'task two', 'two')];
	if (includeRemainingPatch) payloads.push(patch(value.source, 7, 'task three', 'three'));
	const assemblyPlan = plan(value.baseCommit, payloads);
	const rejected = await rejectedAssembly(value, payloads);
	const resolutionId = randomUUID();
	const result = await new IntegrationConflictResolutionService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.resolve(resolutionId, rejected, assemblyPlan, payloads);
	assert.equal(result.status, 'blocked');
	if (result.status !== 'blocked') throw new Error('Expected blocked conflict fixture');

	const databasePath = join(value.root, 'agent-ledger.db');
	const database = new Database(databasePath);
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
	database.prepare('INSERT INTO runs (id, owner_id) VALUES (?, ?)').run(runId, 'operator');
	database.prepare('INSERT INTO jobs (id, run_id, policy_snapshot_json, work_item_snapshot_json) VALUES (?, ?, ?, ?)').run(
		jobId, runId, JSON.stringify(getRepository('frostyard/clix')),
		JSON.stringify({ source: 'manual', key: 'agent-preflight', title: 'Resolve stack', body: '', labels: [] }),
	);
	database.close();
	const parents = new MultiWorkerParentStore(databasePath);
	const planId = randomUUID();
	parents.recordPlan({
		planId, jobId, baseCommit: value.baseCommit,
		plan: {
			version: 2, summary: 'Resolve dependent changes.', assumptions: [], risks: [],
			tasks: [
				{ id: 'one', title: 'One', objective: 'First change.', acceptanceCriteria: ['First passes.'], dependsOn: [], fileScopes: [{ kind: 'repository' }] },
				{ id: 'two', title: 'Two', objective: 'Second change.', acceptanceCriteria: ['Second passes.'], dependsOn: ['one'], fileScopes: [{ kind: 'repository' }] },
				...(includeRemainingPatch ? [{ id: 'three', title: 'Three', objective: 'Third change.', acceptanceCriteria: ['Third passes.'], dependsOn: ['two'], fileScopes: [{ kind: 'repository' as const }] }] : []),
				{ id: 'integration', title: 'Integration', objective: 'Integrate.', acceptanceCriteria: ['Stack passes.'], dependsOn: [includeRemainingPatch ? 'three' : 'two'], fileScopes: [{ kind: 'repository' }] },
			],
		},
	}, 'operator', 'agent-conflict-plan');
	parents.recordAssembly({ assemblyId: rejected.assemblyId, planId, taskId: 'integration', result: rejected }, 'operator');
	parents.recordConflictResolution({ resolutionId, sourceAssemblyId: rejected.assemblyId, result }, 'operator');
	parents.close();
	return { ...value, databasePath, result };
}

function passingConflictPreflight(
	store: IntegrationConflictAgentInvocationStore,
	workspaceRoot: string,
): IntegrationConflictAgentPreflightService {
	return new IntegrationConflictAgentPreflightService(store, {
		workspaceRoot,
		runner: async () => ({
			status: 'passed', exitCode: 0, durationMs: 1, stdout: 'prepared', stderr: '', truncated: false,
		}),
	});
}

function workerOutcome(
	input: IntegrationConflictAgentInitialData,
	disposition: 'resolved' | 'blocked' = 'resolved',
): IntegrationConflictAgentOutcome {
	return {
		conversationId: `test-${input.agentAttemptId}`,
		submissionId: randomUUID(),
		result: {
			disposition,
			summary: disposition === 'resolved' ? 'Resolved the authenticated conflict.' : 'Could not resolve safely.',
			resolvedPaths: disposition === 'resolved' ? [...input.conflictPaths] : [],
			testsRun: [], notes: [],
		},
		text: '',
	};
}

function writeResolvedShared(workspacePath: string): void {
	const lines = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`);
	lines[4] = 'resolved task one and task two';
	writeFileSync(join(workspacePath, 'shared.txt'), `${lines.join('\n')}\n`);
}

test('replays authenticated conflict evidence in a fresh prepared workspace before model claim', async () => {
	const value = await durableBlockedResolution();
	const store = new IntegrationConflictAgentInvocationStore(value.databasePath);
	try {
		const agentAttemptId = randomUUID();
		store.reserve({ agentAttemptId, sourceResolutionId: value.result.resolutionId }, 'operator', 'agent-preflight');
		const service = new IntegrationConflictAgentPreflightService(store, {
			workspaceRoot: value.workspaces,
			runner: async () => ({ status: 'passed', exitCode: 0, durationMs: 1, stdout: 'prepared', stderr: '', truncated: false }),
		});
		const lease = await service.run(agentAttemptId, 'operator');
		assert.equal(lease.status, 'reserved');
		assert.equal(lease.modelCalls, 0);
		assert.equal(lease.preflight?.result?.status, 'passed');
		assert.deepEqual(lease.preflight?.result?.conflictPaths, ['shared.txt']);
		assert.notEqual(lease.preflight?.result?.workspacePath, value.result.workspacePath);
		assert.match(readFileSync(join(lease.preflight!.result!.workspacePath, 'shared.txt'), 'utf8'), /<<<<<<< ours/);
		assert.equal(store.claim(agentAttemptId, 'operator').lease.status, 'running');
	} finally { store.close(); }
});

test('blocks failed preparation and authenticated patch tampering without model spend', async () => {
	const preparationValue = await durableBlockedResolution();
	const preparationStore = new IntegrationConflictAgentInvocationStore(preparationValue.databasePath);
	try {
		const agentAttemptId = randomUUID();
		preparationStore.reserve({ agentAttemptId, sourceResolutionId: preparationValue.result.resolutionId }, 'operator', 'failed-preparation');
		const lease = await new IntegrationConflictAgentPreflightService(preparationStore, {
			workspaceRoot: preparationValue.workspaces,
			runner: async () => ({ status: 'failed', exitCode: 7, durationMs: 1, stdout: '', stderr: 'setup failed', truncated: false }),
		}).run(agentAttemptId, 'operator');
		assert.equal(lease.status, 'blocked');
		assert.equal(lease.modelCalls, 0);
		assert.deepEqual(lease.preflight?.result?.status === 'blocked' ? lease.preflight.result.violations : [], ['preparation_failed']);
		const recoveredAttemptId = randomUUID();
		assert.equal(preparationStore.reserve({
			agentAttemptId: recoveredAttemptId, sourceResolutionId: preparationValue.result.resolutionId,
		}, 'operator', 'after-preparation-failure').modelCalls, 0);
		const mutated = await new IntegrationConflictAgentPreflightService(preparationStore, {
			workspaceRoot: preparationValue.workspaces,
			runner: async (_command, context) => {
				writeFileSync(join(context.workspacePath, 'preparation-output.txt'), 'unexpected\n');
				return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
			},
		}).run(recoveredAttemptId, 'operator');
		assert.equal(mutated.modelCalls, 0);
		assert.deepEqual(mutated.preflight?.result?.status === 'blocked' ? mutated.preflight.result.violations : [], ['preparation_changed_workspace']);
		const timedOutAttemptId = randomUUID();
		preparationStore.reserve({ agentAttemptId: timedOutAttemptId, sourceResolutionId: preparationValue.result.resolutionId }, 'operator', 'timed-out-preparation');
		const timedOut = await new IntegrationConflictAgentPreflightService(preparationStore, {
			workspaceRoot: preparationValue.workspaces,
			runner: async () => ({ status: 'timed_out', exitCode: null, durationMs: 1, stdout: '', stderr: '', truncated: false }),
		}).run(timedOutAttemptId, 'operator');
		assert.equal(timedOut.modelCalls, 0);
		assert.deepEqual(timedOut.preflight?.result?.status === 'blocked' ? timedOut.preflight.result.violations : [], ['preparation_failed']);
	} finally { preparationStore.close(); }

	const tamperedValue = await durableBlockedResolution();
	const tamperedStore = new IntegrationConflictAgentInvocationStore(tamperedValue.databasePath);
	try {
		const manifest = tamperedValue.result.replayManifest!;
		const patchPath = join(tamperedValue.result.workspacePath, '..', 'evidence', `01-${manifest.orderedPatches[0]!.taskId}.patch`);
		writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}\n`);
		const agentAttemptId = randomUUID();
		tamperedStore.reserve({ agentAttemptId, sourceResolutionId: tamperedValue.result.resolutionId }, 'operator', 'tampered');
		const lease = await new IntegrationConflictAgentPreflightService(tamperedStore, { workspaceRoot: tamperedValue.workspaces })
			.run(agentAttemptId, 'operator');
		assert.equal(lease.status, 'blocked');
		assert.equal(lease.modelCalls, 0);
		assert.deepEqual(lease.preflight?.result?.status === 'blocked' ? lease.preflight.result.violations : [], ['patch_evidence_tampered']);
	} finally { tamperedStore.close(); }
});

test('runs one conflict-agent call, finishes the remaining stack, and promotes trusted resolution', async () => {
	const value = await durableBlockedResolution(true);
	const store = new IntegrationConflictAgentInvocationStore(value.databasePath);
	const agentAttemptId = randomUUID();
	try {
		store.reserve({ agentAttemptId, sourceResolutionId: value.result.resolutionId }, 'operator', 'agent-resolve');
		let calls = 0;
		const service = new IntegrationConflictAgentOrchestrationService(store, {
			preflight: passingConflictPreflight(store, value.workspaces),
			worker: async (input) => {
				calls += 1;
				writeResolvedShared(input.workspacePath);
				git(input.workspacePath, ['add', '--', 'shared.txt']);
				return workerOutcome(input);
			},
		});
		const lease = await service.execute(agentAttemptId, 'operator');
		assert.equal(calls, 1, JSON.stringify(lease));
		assert.equal(lease.status, 'resolved');
		assert.equal(lease.modelCalls, 1, JSON.stringify(lease));
		assert.equal(lease.resolution?.strategy, 'codex_one_call');
		assert.equal(lease.resolution?.status, 'resolved');
		assert.deepEqual(lease.resolution?.appliedTaskIds, ['one', 'two', 'three']);
		assert.equal((await service.execute(agentAttemptId, 'operator')).status, 'resolved');
		assert.equal(calls, 1);
	} finally { store.close(); }

	const parents = new MultiWorkerParentStore(value.databasePath);
	try {
		const promoted = await new IntegrationConflictPromotionService(parents)
			.promote(randomUUID(), agentAttemptId, 'operator', 'promote-agent-resolution');
		assert.equal(promoted.status, 'promoted');
		assert.equal(promoted.result.modelCalls, 0);
	} finally { parents.close(); }
});

test('blocks conflict-agent scope escape and unresolved index without another call', async () => {
	for (const mode of ['scope-escape', 'unresolved-index'] as const) {
		const value = await durableBlockedResolution();
		const store = new IntegrationConflictAgentInvocationStore(value.databasePath);
		const agentAttemptId = randomUUID();
		try {
			store.reserve({ agentAttemptId, sourceResolutionId: value.result.resolutionId }, 'operator', mode);
			let calls = 0;
			const service = new IntegrationConflictAgentOrchestrationService(store, {
				preflight: passingConflictPreflight(store, value.workspaces),
				worker: async (input) => {
					calls += 1;
					writeResolvedShared(input.workspacePath);
					if (mode === 'scope-escape') {
						git(input.workspacePath, ['add', '--', 'shared.txt']);
						writeFileSync(join(input.workspacePath, 'outside.txt'), 'unauthorized\n');
					}
					return workerOutcome(input);
				},
			});
			const lease = await service.execute(agentAttemptId, 'operator');
			assert.equal(lease.status, 'blocked');
			assert.equal(lease.modelCalls, 1);
			assert.equal(lease.resolution?.status === 'blocked' ? lease.resolution.reason : '',
				mode === 'scope-escape' ? 'non_conflict_changed' : 'unmerged_paths');
			assert.equal((await service.execute(agentAttemptId, 'operator')).status, 'blocked');
			assert.equal(calls, 1);
		} finally { store.close(); }
	}
});

test('blocks changed remaining-patch evidence after the sole model call', async () => {
	const value = await durableBlockedResolution(true);
	const store = new IntegrationConflictAgentInvocationStore(value.databasePath);
	const agentAttemptId = randomUUID();
	try {
		store.reserve({ agentAttemptId, sourceResolutionId: value.result.resolutionId }, 'operator', 'remaining-patch-tamper');
		const service = new IntegrationConflictAgentOrchestrationService(store, {
			preflight: passingConflictPreflight(store, value.workspaces),
			worker: async (input) => {
				writeResolvedShared(input.workspacePath);
				git(input.workspacePath, ['add', '--', 'shared.txt']);
				const patchPath = join(input.workspacePath, '..', 'evidence', '03-three.patch');
				writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}\n`);
				return workerOutcome(input);
			},
		});
		const lease = await service.execute(agentAttemptId, 'operator');
		assert.equal(lease.status, 'blocked');
		assert.equal(lease.modelCalls, 1);
		assert.equal(lease.resolution?.status === 'blocked' ? lease.resolution.reason : '', 'remaining_patch_rejected');
	} finally { store.close(); }
});

test('blocks replay-workspace tampering before spend and never retries a failed model call', async () => {
	const tampered = await durableBlockedResolution();
	const tamperedStore = new IntegrationConflictAgentInvocationStore(tampered.databasePath);
	try {
		const agentAttemptId = randomUUID();
		tamperedStore.reserve({ agentAttemptId, sourceResolutionId: tampered.result.resolutionId }, 'operator', 'tampered-after-preflight');
		const preflight = passingConflictPreflight(tamperedStore, tampered.workspaces);
		const prepared = await preflight.run(agentAttemptId, 'operator');
		assert.equal(prepared.preflight?.result?.status, 'passed');
		writeFileSync(join(prepared.preflight!.result!.workspacePath, 'shared.txt'), 'tampered\n');
		let calls = 0;
		const blocked = await new IntegrationConflictAgentOrchestrationService(tamperedStore, {
			preflight,
			worker: async (input) => { calls += 1; return workerOutcome(input); },
		}).execute(agentAttemptId, 'operator');
		assert.equal(blocked.status, 'blocked');
		assert.equal(blocked.modelCalls, 0);
		assert.equal(calls, 0);
	} finally { tamperedStore.close(); }

	const failed = await durableBlockedResolution();
	const failedStore = new IntegrationConflictAgentInvocationStore(failed.databasePath);
	try {
		const agentAttemptId = randomUUID();
		failedStore.reserve({ agentAttemptId, sourceResolutionId: failed.result.resolutionId }, 'operator', 'failed-worker');
		let calls = 0;
		const service = new IntegrationConflictAgentOrchestrationService(failedStore, {
			preflight: passingConflictPreflight(failedStore, failed.workspaces),
			worker: async () => { calls += 1; throw new Error('ambiguous worker failure'); },
		});
		const lease = await service.execute(agentAttemptId, 'operator');
		assert.equal(lease.status, 'failed');
		assert.equal(lease.workerRun?.evidence.status, 'failed');
		assert.equal((await service.execute(agentAttemptId, 'operator')).status, 'failed');
		assert.equal(calls, 1);
	} finally { failedStore.close(); }
});

test('rejects non-conflict parents and changed patch evidence before creating a workspace', async () => {
	const value = fixture();
	const payloads = [patch(value.source, 4, 'task one', 'one'), patch(value.source, 6, 'task two', 'two')];
	const rejected = await rejectedAssembly(value, payloads);
	const service = new IntegrationConflictResolutionService({ workspaceRoot: value.workspaces, repositorySource: value.source });
	await assert.rejects(() => service.resolve(randomUUID(), {
		...rejected, status: 'blocked', reason: 'head_moved', detail: 'different failure',
	}, plan(value.baseCommit, payloads), payloads), IntegrationConflictResolutionError);
	await assert.rejects(() => service.resolve(randomUUID(), rejected, plan(value.baseCommit, payloads), [
		{ ...payloads[0]!, patch: `${payloads[0]!.patch}\n` }, payloads[1]!,
	]), IntegrationConflictResolutionError);
});

test('persists conflict lineage and promotes only freshly verified resolved evidence', async () => {
	const value = fixture();
	const payloads = [patch(value.source, 4, 'task one', 'one'), patch(value.source, 6, 'task two', 'two')];
	const assemblyPlan = plan(value.baseCommit, payloads);
	const rejected = await rejectedAssembly(value, payloads);
	assert.equal(rejected.status, 'blocked');
	const resolutionId = randomUUID();
	const result = await new IntegrationConflictResolutionService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.resolve(resolutionId, rejected, assemblyPlan, payloads);
	assert.equal(result.status, 'resolved');

	const databasePath = join(value.root, 'ledger.db');
	const database = new Database(databasePath);
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
	database.prepare('INSERT INTO runs (id, owner_id) VALUES (?, ?)').run(runId, 'operator');
	database.prepare('INSERT INTO jobs (id, run_id, policy_snapshot_json, work_item_snapshot_json) VALUES (?, ?, ?, ?)').run(
		jobId, runId, JSON.stringify(getRepository('frostyard/clix')),
		JSON.stringify({ source: 'manual', key: 'conflict-parent', title: 'Resolve stack', body: '', labels: [] }),
	);
	database.close();
	const parents = new MultiWorkerParentStore(databasePath);
	const planId = randomUUID();
	const storedPlan = parents.recordPlan({
		planId, jobId, baseCommit: value.baseCommit,
		plan: {
			version: 2, summary: 'Resolve dependent changes.', assumptions: [], risks: [],
			tasks: [
				{ id: 'one', title: 'One', objective: 'First change.', acceptanceCriteria: ['First passes.'], dependsOn: [], fileScopes: [{ kind: 'repository' }] },
				{ id: 'two', title: 'Two', objective: 'Second change.', acceptanceCriteria: ['Second passes.'], dependsOn: ['one'], fileScopes: [{ kind: 'repository' }] },
				{ id: 'integration', title: 'Integration', objective: 'Integrate.', acceptanceCriteria: ['Stack passes.'], dependsOn: ['two'], fileScopes: [{ kind: 'repository' }] },
			],
		},
	}, 'operator', 'conflict-plan');
	parents.recordAssembly({ assemblyId: rejected.assemblyId, planId, taskId: 'integration', result: rejected }, 'operator');
	const stored = parents.recordConflictResolution({ resolutionId, sourceAssemblyId: rejected.assemblyId, result }, 'operator');
	assert.equal(stored.status, 'resolved');
	assert.equal(parents.recordConflictResolution({ resolutionId, sourceAssemblyId: rejected.assemblyId, result }, 'operator').resolutionId, resolutionId);
	assert.throws(() => parents.getConflictResolution(resolutionId, 'different-operator'), MultiWorkerParentForbiddenError);
	const duplicateStrategyId = randomUUID();
	assert.throws(() => parents.recordConflictResolution({
		resolutionId: duplicateStrategyId, sourceAssemblyId: rejected.assemblyId,
		result: { ...result, resolutionId: duplicateStrategyId },
	}, 'operator'), MultiWorkerParentConflictError);

	const blockedPromotionId = randomUUID();
	const blockedPromotion = await new IntegrationConflictPromotionService(parents, { inspector: async () => ({
		headCommit: value.baseCommit, stagedPatchSha256: 'f'.repeat(64), dirtyPaths: [],
	}) }).promote(blockedPromotionId, resolutionId, 'operator', 'blocked-promotion');
	assert.equal(blockedPromotion.status, 'blocked');
	assert.deepEqual(blockedPromotion.result.status === 'blocked' ? blockedPromotion.result.violations : [], ['index_changed']);
	const promotedAssemblyId = randomUUID();
	const promoted = await new IntegrationConflictPromotionService(parents)
		.promote(promotedAssemblyId, resolutionId, 'operator', 'successful-promotion');
	assert.equal(promoted.status, 'promoted');
	assert.equal(promoted.result.modelCalls, 0);
	assert.equal(promoted.result.workerAuthorized, false);
	assert.equal((await new IntegrationConflictPromotionService(parents)
		.promote(promotedAssemblyId, resolutionId, 'operator', 'successful-promotion')).assemblyId, promotedAssemblyId);
	assert.throws(() => parents.getConflictPromotion(promotedAssemblyId, 'different-operator'), MultiWorkerParentForbiddenError);
	await assert.rejects(() => new IntegrationConflictPromotionService(parents)
		.promote(randomUUID(), resolutionId, 'operator', 'duplicate-success'), MultiWorkerParentConflictError);
	parents.close();

	const reopened = new MultiWorkerParentStore(databasePath);
	try {
		assert.equal(reopened.getConflictResolution(resolutionId, 'operator').result.workspacePath, result.workspacePath);
		assert.equal(reopened.getConflictPromotion(promotedAssemblyId, 'operator').status, 'promoted');
	} finally { reopened.close(); }

	const invocations = new IntegrationInvocationStore(databasePath);
	try {
		assert.throws(() => invocations.reserve({
			integrationAttemptId: randomUUID(), assemblyId: blockedPromotionId,
			planSha256: storedPlan.planSha256, taskId: 'integration',
		}, 'operator', 'blocked-promotion-invocation'));
		const integrationAttemptId = randomUUID();
		const lease = invocations.reserve({
			integrationAttemptId, assemblyId: promotedAssemblyId,
			planSha256: storedPlan.planSha256, taskId: 'integration',
		}, 'operator', 'promoted-invocation');
		assert.equal(lease.status, 'reserved');
		const context = invocations.getParentContext(integrationAttemptId, 'operator');
		assert.equal(context.workspacePath, result.workspacePath);
		assert.equal(context.assemblyPatchSha256, result.status === 'resolved' ? result.patchSha256 : '');
	} finally { invocations.close(); }
});
