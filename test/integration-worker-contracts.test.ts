import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as v from 'valibot';
import { getRepository } from '../src/control-plane/repositories.ts';
import {
	evaluateIntegrationWorker,
	IntegrationWorkerInitialDataSchema,
} from '../src/control-plane/integration-worker-contracts.ts';
import { MultiWorkerPlanV2Schema } from '../src/control-plane/work-plan-contracts.ts';

const baseCommit = 'a'.repeat(40);
const assemblyDigest = 'b'.repeat(64);
const finalDigest = 'c'.repeat(64);
const plan = v.parse(MultiWorkerPlanV2Schema, {
	version: 2,
	summary: 'Integrate the completed API and UI prerequisites.',
	tasks: [
		{ id: 'api', title: 'API', objective: 'Build API.', acceptanceCriteria: ['API passes.'], dependsOn: [], fileScopes: [{ kind: 'directory', path: 'src/api' }] },
		{ id: 'ui', title: 'UI', objective: 'Build UI.', acceptanceCriteria: ['UI passes.'], dependsOn: [], fileScopes: [{ kind: 'directory', path: 'src/ui' }] },
		{ id: 'integration', title: 'Integration', objective: 'Connect both.', acceptanceCriteria: ['Integration passes.'], dependsOn: ['api', 'ui'], fileScopes: [{ kind: 'directory', path: 'src/integration' }] },
	],
	assumptions: [],
	risks: [],
});

function initialData() {
	return v.parse(IntegrationWorkerInitialDataSchema, {
		integrationAttemptId: randomUUID(), assemblyId: randomUUID(), workspacePath: '/tmp/workspace',
		sandboxHomePath: '/tmp/home', toolDataPath: '/tmp/tools', executablePath: '/usr/bin',
		baseCommit, assemblyPatchSha256: assemblyDigest, plan, taskId: 'integration',
		assemblyChangedPaths: ['src/api/client.ts'],
		repository: getRepository('frostyard/bobsled'),
		workItem: { source: 'manual', key: 'integration-test', title: 'Connect API and UI', body: '', labels: [] },
		maxWorkerCalls: 1,
	});
}

test('accepts one scoped unstaged worker delta while authorizing no further call', () => {
	const input = initialData();
	assert.deepEqual(evaluateIntegrationWorker(input, {
		disposition: 'changed', summary: 'Connected both layers.', changedPaths: ['src/integration/index.ts'], testsRun: ['npm test'], notes: [],
	}, {
		headCommit: baseCommit, stagedPatchSha256: assemblyDigest,
		workerChangedPaths: ['src/integration/index.ts'],
		finalChangedPaths: ['src/api/client.ts', 'src/integration/index.ts'], diffLines: 10,
		finalPatchSha256: finalDigest,
	}), {
		integrationAttemptId: input.integrationAttemptId,
		taskId: 'integration', status: 'succeeded', workerCallCount: 1,
		workerChangedPaths: ['src/integration/index.ts'], finalPatchSha256: finalDigest,
		violations: [], furtherWorkerAuthorized: false,
	});
});

test('blocks index mutation, moved HEAD, scope escape, and false model path claims', () => {
	const input = initialData();
	const result = evaluateIntegrationWorker(input, {
		disposition: 'changed', summary: 'Claimed integration.', changedPaths: ['src/integration/index.ts'], testsRun: [], notes: [],
	}, {
		headCommit: 'd'.repeat(40), stagedPatchSha256: 'e'.repeat(64),
		workerChangedPaths: ['src/api/escaped.ts'], finalChangedPaths: ['src/api/client.ts', 'src/api/escaped.ts'],
		diffLines: 10, finalPatchSha256: finalDigest,
	});
	assert.equal(result.status, 'blocked');
	assert.deepEqual(result.violations, ['head_moved', 'index_changed', 'scope_violation', 'reported_paths_mismatch']);
	assert.equal(result.furtherWorkerAuthorized, false);
});

test('requires no-change evidence to preserve both paths and final patch digest', () => {
	const input = initialData();
	assert.equal(evaluateIntegrationWorker(input, {
		disposition: 'no_change', summary: 'Already integrated.', changedPaths: [], testsRun: [], notes: [],
	}, {
		headCommit: baseCommit, stagedPatchSha256: assemblyDigest,
		workerChangedPaths: [], finalChangedPaths: ['src/api/client.ts'], diffLines: 5, finalPatchSha256: assemblyDigest,
	}).status, 'succeeded');
	assert.deepEqual(evaluateIntegrationWorker(input, {
		disposition: 'no_change', summary: 'Already integrated.', changedPaths: [], testsRun: [], notes: [],
	}, {
		headCommit: baseCommit, stagedPatchSha256: assemblyDigest,
		workerChangedPaths: ['src/integration/index.ts'], finalChangedPaths: ['src/api/client.ts', 'src/integration/index.ts'],
		diffLines: 10, finalPatchSha256: finalDigest,
	}).violations, ['reported_paths_mismatch', 'disposition_mismatch', 'final_patch_mismatch']);
});

test('refuses root tasks and always blocks a worker-reported safety stop', () => {
	const input = initialData();
	assert.throws(() => v.parse(IntegrationWorkerInitialDataSchema, { ...input, taskId: 'api' }));
	assert.deepEqual(evaluateIntegrationWorker(input, {
		disposition: 'blocked', summary: 'Cannot integrate safely.', changedPaths: [], testsRun: [], notes: [],
	}, {
		headCommit: baseCommit, stagedPatchSha256: assemblyDigest,
		workerChangedPaths: [], finalChangedPaths: ['src/api/client.ts'], diffLines: 5, finalPatchSha256: assemblyDigest,
	}).violations, ['worker_blocked']);
});

test('enforces final aggregate size and protected-path policy', () => {
	const input = initialData();
	const restricted = {
		...input,
		repository: {
			...input.repository,
			executionPolicy: { ...input.repository.executionPolicy, maxFiles: 1, maxDiffLines: 1 },
			protectedBoundaries: [{
				id: 'integration-boundary', paths: ['src/integration/**'], minimumRisk: 'high' as const, requiresHumanReview: true as const,
			}],
		},
	};
	const result = evaluateIntegrationWorker(restricted, {
		disposition: 'changed', summary: 'Integrated.', changedPaths: ['src/integration/index.ts'], testsRun: [], notes: [],
	}, {
		headCommit: baseCommit, stagedPatchSha256: assemblyDigest,
		workerChangedPaths: ['src/integration/index.ts'], finalChangedPaths: ['src/api/client.ts', 'src/integration/index.ts'],
		diffLines: 10, finalPatchSha256: finalDigest,
	});
	assert.deepEqual(result.violations, ['file_limit', 'diff_limit', 'protected_path']);
});
