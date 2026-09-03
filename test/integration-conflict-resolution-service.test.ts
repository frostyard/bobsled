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

test('persists one principal-scoped deterministic resolution per rejected assembly', async () => {
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
		CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id));
	`);
	database.prepare('INSERT INTO runs (id, owner_id) VALUES (?, ?)').run(runId, 'operator');
	database.prepare('INSERT INTO jobs (id, run_id) VALUES (?, ?)').run(jobId, runId);
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
	parents.close();

	const reopened = new MultiWorkerParentStore(databasePath);
	try {
		assert.equal(reopened.getConflictResolution(resolutionId, 'operator').result.workspacePath, result.workspacePath);
	} finally { reopened.close(); }
});
