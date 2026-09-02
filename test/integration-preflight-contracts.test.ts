import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as v from 'valibot';
import {
	evaluateIntegrationPreflight,
	IntegrationPreflightResultSchema,
} from '../src/control-plane/integration-preflight-contracts.ts';
import { inspectIntegrationWorkspace } from '../src/control-plane/integration-preflight-service.ts';

const baseCommit = 'a'.repeat(40);
const stagedPatchSha256 = 'b'.repeat(64);

test('authorizes only an exact clean integration stack', () => {
	const integrationAttemptId = randomUUID();
	const passed = evaluateIntegrationPreflight(integrationAttemptId, baseCommit, stagedPatchSha256, {
		headCommit: baseCommit, stagedPatchSha256, dirtyPaths: [],
	});
	assert.equal(passed.status, 'passed');
	assert.equal(passed.workerAuthorized, true);
	assert.deepEqual(passed.violations, []);
	assert.throws(() => v.parse(IntegrationPreflightResultSchema, {
		integrationAttemptId, status: 'passed', violations: [], detail: '', workerAuthorized: true,
	}));

	const blocked = evaluateIntegrationPreflight(integrationAttemptId, baseCommit, stagedPatchSha256, {
		headCommit: 'c'.repeat(40), stagedPatchSha256: 'd'.repeat(64), dirtyPaths: ['untracked.txt'],
	});
	assert.equal(blocked.status, 'blocked');
	assert.equal(blocked.workerAuthorized, false);
	assert.deepEqual(blocked.violations, ['head_moved', 'index_changed', 'dirty_worktree']);
});

test('inspects staged prerequisites separately from unstaged and untracked dirt', async () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-integration-preflight-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
	execFileSync('git', ['config', 'user.name', 'Bobsled Test'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'bobsled@example.invalid'], { cwd: root });
	writeFileSync(join(root, 'tracked.txt'), 'base\n');
	execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
	writeFileSync(join(root, 'prerequisite.txt'), 'staged\n');
	execFileSync('git', ['add', 'prerequisite.txt'], { cwd: root });

	const clean = await inspectIntegrationWorkspace(root);
	const stagedPatch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', '--cached', 'HEAD', '--'], { cwd: root });
	assert.equal(clean.stagedPatchSha256, createHash('sha256').update(stagedPatch).digest('hex'));
	assert.deepEqual(clean.dirtyPaths, []);

	writeFileSync(join(root, 'tracked.txt'), 'dirty\n');
	writeFileSync(join(root, 'untracked.txt'), 'new\n');
	assert.deepEqual((await inspectIntegrationWorkspace(root)).dirtyPaths, ['tracked.txt', 'untracked.txt']);
});
