import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateIntegrationFinalIntegrity } from '../src/control-plane/integration-final-integrity.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const repository = getRepository('frostyard/clix')!;

const baseCommit = 'a'.repeat(40);
const assemblyPatchSha256 = 'b'.repeat(64);
const finalPatchSha256 = 'c'.repeat(64);
const outcome = {
	integrationAttemptId: '00000000-0000-4000-8000-000000000001', taskId: 'integration',
	status: 'succeeded' as const, workerCallCount: 1 as const,
	workerChangedPaths: ['src/integration/result.ts'], finalPatchSha256,
	violations: [], furtherWorkerAuthorized: false as const,
};
const inspection = {
	headCommit: baseCommit, stagedPatchSha256: assemblyPatchSha256,
	workerChangedPaths: ['src/integration/result.ts'],
	finalChangedPaths: ['src/api/client.ts', 'src/integration/result.ts'],
	diffLines: 4, finalPatchSha256,
};

function evaluate(overrides = {}) {
	return evaluateIntegrationFinalIntegrity({
		baseCommit, assemblyPatchSha256, assemblyChangedPaths: ['src/api/client.ts'], repository, outcome,
	}, { ...inspection, ...overrides });
}

test('accepts an unchanged trusted patch after gates', () => {
	const result = evaluate();
	assert.equal(result.status, 'passed');
	assert.deepEqual(result.violations, []);
});

test('detects gate changes to content, paths, index, and HEAD independently', () => {
	assert.deepEqual(evaluate({ finalPatchSha256: 'd'.repeat(64) }).violations, ['final_patch_changed']);
	assert.deepEqual(evaluate({ workerChangedPaths: ['src/integration/other.ts'] }).violations, ['worker_paths_changed']);
	assert.deepEqual(evaluate({ stagedPatchSha256: 'd'.repeat(64) }).violations, ['index_changed']);
	assert.deepEqual(evaluate({ headCommit: 'd'.repeat(40) }).violations, ['head_moved']);
});
