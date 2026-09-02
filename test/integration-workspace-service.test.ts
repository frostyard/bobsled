import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IntegrationAssemblyPlan } from '../src/control-plane/integration-assembly-contracts.ts';
import {
	IntegrationWorkspaceError,
	IntegrationWorkspaceService,
} from '../src/control-plane/integration-workspace-service.ts';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd }).toString('utf8').trim();
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-integration-'));
	const source = join(root, 'source');
	const workspaces = join(root, 'workspaces');
	mkdirSync(source);
	git(source, ['init', '-b', 'main']);
	git(source, ['config', 'user.name', 'Bobsled Test']);
	git(source, ['config', 'user.email', 'bobsled@example.invalid']);
	writeFileSync(join(source, 'api.txt'), 'base\n');
	writeFileSync(join(source, 'ui.txt'), 'base\n');
	git(source, ['add', '.']);
	git(source, ['commit', '-m', 'fixture']);
	return { root, source, workspaces, baseCommit: git(source, ['rev-parse', 'HEAD']) };
}

function makePatch(source: string, path: string, content: string): string {
	writeFileSync(join(source, path), content);
	const patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', path], { cwd: source }).toString('utf8');
	git(source, ['restore', path]);
	return patch;
}

function digest(patch: string): string {
	return createHash('sha256').update(patch).digest('hex');
}

function plan(baseCommit: string, patches: Array<{ taskId: string; patchSha256: string; changedPaths: string[] }>): IntegrationAssemblyPlan {
	return {
		taskId: 'integration', baseCommit, prerequisiteTaskIds: patches.map(({ taskId }) => taskId),
		orderedPatches: patches, ready: true, blockers: [], executionAuthorized: false,
	};
}

test('assembles a digest-verified patch stack in an isolated detached worktree', async () => {
	const value = fixture();
	const apiPatch = makePatch(value.source, 'api.txt', 'api change\n');
	const uiPatch = makePatch(value.source, 'ui.txt', 'ui change\n');
	const patches = [
		{ taskId: 'api', patchSha256: digest(apiPatch), changedPaths: ['api.txt'] },
		{ taskId: 'ui', patchSha256: digest(uiPatch), changedPaths: ['ui.txt'] },
	];
	const result = await new IntegrationWorkspaceService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.assemble(randomUUID(), plan(value.baseCommit, patches), [
			{ taskId: 'api', patchSha256: digest(apiPatch), patch: apiPatch },
			{ taskId: 'ui', patchSha256: digest(uiPatch), patch: uiPatch },
		]);
	assert.equal(result.status, 'assembled');
	assert.deepEqual(result.appliedTaskIds, ['api', 'ui']);
	assert.deepEqual(result.changedPaths, ['api.txt', 'ui.txt']);
	assert.equal(result.workerAuthorized, false);
	assert.equal(git(result.workspacePath, ['rev-parse', 'HEAD']), value.baseCommit);
	assert.equal(readFileSync(join(result.workspacePath, 'api.txt'), 'utf8'), 'api change\n');
	assert.equal(readFileSync(join(result.workspacePath, 'ui.txt'), 'utf8'), 'ui change\n');
	assert.match(readFileSync(join(result.workspacePath, '..', 'evidence', 'assembly-result.json'), 'utf8'), /"assembled"/);
});

test('rejects a conflicting patch and preserves prior applied evidence', async () => {
	const value = fixture();
	const firstPatch = makePatch(value.source, 'api.txt', 'first change\n');
	const conflictingPatch = makePatch(value.source, 'api.txt', 'second change\n');
	const patches = [
		{ taskId: 'first', patchSha256: digest(firstPatch), changedPaths: ['api.txt'] },
		{ taskId: 'second', patchSha256: digest(conflictingPatch), changedPaths: ['api.txt'] },
	];
	const result = await new IntegrationWorkspaceService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.assemble(randomUUID(), plan(value.baseCommit, patches), [
			{ taskId: 'first', patchSha256: digest(firstPatch), patch: firstPatch },
			{ taskId: 'second', patchSha256: digest(conflictingPatch), patch: conflictingPatch },
		]);
	assert.equal(result.status, 'blocked');
	if (result.status !== 'blocked') return;
	assert.equal(result.reason, 'patch_rejected');
	assert.equal(result.failedTaskId, 'second');
	assert.deepEqual(result.appliedTaskIds, ['first']);
	assert.equal(result.workerAuthorized, false);
});

test('verifies payload identity and digest before creating a workspace', async () => {
	const value = fixture();
	const apiPatch = makePatch(value.source, 'api.txt', 'api change\n');
	const expected = { taskId: 'api', patchSha256: digest(apiPatch), changedPaths: ['api.txt'] };
	const service = new IntegrationWorkspaceService({ workspaceRoot: value.workspaces, repositorySource: value.source });
	await assert.rejects(() => service.assemble(randomUUID(), plan(value.baseCommit, [expected]), [
		{ taskId: 'api', patchSha256: digest(apiPatch), patch: `${apiPatch}\n` },
	]), IntegrationWorkspaceError);
	await assert.rejects(() => service.assemble(randomUUID(), plan(value.baseCommit, [expected]), []), IntegrationWorkspaceError);
});

test('blocks a patch whose actual paths differ from trusted changed-path evidence', async () => {
	const value = fixture();
	const apiPatch = makePatch(value.source, 'api.txt', 'api change\n');
	const expected = { taskId: 'api', patchSha256: digest(apiPatch), changedPaths: ['ui.txt'] };
	const result = await new IntegrationWorkspaceService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.assemble(randomUUID(), plan(value.baseCommit, [expected]), [
			{ taskId: 'api', patchSha256: digest(apiPatch), patch: apiPatch },
		]);
	assert.equal(result.status, 'blocked');
	if (result.status !== 'blocked') return;
	assert.equal(result.reason, 'changed_path_mismatch');
	assert.deepEqual(result.changedPaths, ['api.txt']);
});

test('preserves a verified no-change prerequisite as an explicit no-op', async () => {
	const value = fixture();
	const emptyPatch = '';
	const expected = { taskId: 'inspection', patchSha256: digest(emptyPatch), changedPaths: [] };
	const result = await new IntegrationWorkspaceService({ workspaceRoot: value.workspaces, repositorySource: value.source })
		.assemble(randomUUID(), plan(value.baseCommit, [expected]), [
			{ taskId: 'inspection', patchSha256: digest(emptyPatch), patch: emptyPatch },
		]);
	assert.equal(result.status, 'assembled');
	assert.deepEqual(result.appliedTaskIds, ['inspection']);
	assert.deepEqual(result.changedPaths, []);
});
