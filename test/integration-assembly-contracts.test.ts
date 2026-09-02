import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
	IntegrationAssemblyError,
	IntegrationAssemblyPlanSchema,
	planIntegrationAssembly,
} from '../src/control-plane/integration-assembly-contracts.ts';
import { MultiWorkerPlanV2Schema } from '../src/control-plane/work-plan-contracts.ts';

const baseCommit = 'a'.repeat(40);

function task(id: string, path: string, dependsOn: string[] = []) {
	return {
		id,
		title: `Implement ${id}`,
		objective: `Produce ${id}.`,
		acceptanceCriteria: [`${id} is verified.`],
		dependsOn,
		fileScopes: path === '*' ? [{ kind: 'repository' as const }] : [{ kind: 'directory' as const, path }],
	};
}

const plan = v.parse(MultiWorkerPlanV2Schema, {
	version: 2,
	summary: 'Assemble two independent foundations before integration.',
	tasks: [
		task('api', 'src/api'),
		task('ui', 'src/ui'),
		task('integration', '*', ['api', 'ui']),
	],
	assumptions: [],
	risks: [],
});

function patch(taskId: string, changedPaths: string[], digestCharacter: string, commit = baseCommit) {
	return { taskId, baseCommit: commit, patchSha256: digestCharacter.repeat(64), changedPaths };
}

test('builds a topologically ordered patch stack without granting execution', () => {
	assert.deepEqual(planIntegrationAssembly(plan, 'integration', baseCommit, [
		patch('ui', ['src/ui/view.ts'], 'b'),
		patch('api', ['src/api/client.ts'], 'c'),
	]), {
		taskId: 'integration',
		baseCommit,
		prerequisiteTaskIds: ['api', 'ui'],
		orderedPatches: [
			{ taskId: 'api', patchSha256: 'c'.repeat(64), changedPaths: ['src/api/client.ts'] },
			{ taskId: 'ui', patchSha256: 'b'.repeat(64), changedPaths: ['src/ui/view.ts'] },
		],
		ready: true,
		blockers: [],
		executionAuthorized: false,
	});
});

test('includes the complete transitive prerequisite set in deterministic order', () => {
	const deepPlan = v.parse(MultiWorkerPlanV2Schema, {
		version: 2,
		summary: 'Assemble a deeper dependency graph.',
		tasks: [
			task('foundation', 'src/shared'),
			task('api', 'src/api', ['foundation']),
			task('ui', 'src/ui'),
			task('integration', '*', ['api', 'ui']),
		],
		assumptions: [],
		risks: [],
	});
	const result = planIntegrationAssembly(deepPlan, 'integration', baseCommit, [
		patch('ui', ['src/ui/view.ts'], 'b'),
		patch('api', ['src/api/client.ts'], 'c'),
		patch('foundation', ['src/shared/types.ts'], 'd'),
	]);
	assert.equal(result.ready, true);
	assert.deepEqual(result.prerequisiteTaskIds, ['foundation', 'ui', 'api']);
	assert.deepEqual(result.orderedPatches.map(({ taskId }) => taskId), ['foundation', 'ui', 'api']);
});

test('fails closed on missing, mismatched, or scope-invalid prerequisite evidence', () => {
	assert.deepEqual(planIntegrationAssembly(plan, 'integration', baseCommit, [
		patch('api', ['src/ui/not-owned.ts'], 'b', 'd'.repeat(40)),
	]), {
		taskId: 'integration',
		baseCommit,
		prerequisiteTaskIds: ['api', 'ui'],
		orderedPatches: [],
		ready: false,
		blockers: [
			{ taskId: 'api', reason: 'base_mismatch' },
			{ taskId: 'api', reason: 'scope_violation' },
			{ taskId: 'ui', reason: 'missing_evidence' },
		],
		executionAuthorized: false,
	});
});

test('reports duplicate and unrelated evidence deterministically', () => {
	const result = planIntegrationAssembly(plan, 'integration', baseCommit, [
		patch('api', ['src/api/one.ts'], 'b'),
		patch('api', ['src/api/two.ts'], 'c'),
		patch('integration', ['README.md'], 'd'),
		patch('ui', ['src/ui/view.ts'], 'e'),
	]);
	assert.equal(result.ready, false);
	assert.deepEqual(result.blockers, [
		{ taskId: 'api', reason: 'duplicate_evidence' },
		{ taskId: 'integration', reason: 'unexpected_evidence' },
	]);
	assert.deepEqual(result.orderedPatches, []);
});

test('requires a known dependency-bearing task and bounded typed evidence', () => {
	assert.throws(() => planIntegrationAssembly(plan, 'missing', baseCommit, []), IntegrationAssemblyError);
	assert.throws(() => planIntegrationAssembly(plan, 'api', baseCommit, []), IntegrationAssemblyError);
	assert.throws(() => planIntegrationAssembly(plan, 'integration', baseCommit, Array.from({ length: 33 }, () => patch('api', [], 'b'))), IntegrationAssemblyError);
	assert.throws(() => planIntegrationAssembly(plan, 'integration', 'not-a-commit', []));
});

test('typed evidence cannot claim readiness without a complete patch stack', () => {
	assert.throws(() => v.parse(IntegrationAssemblyPlanSchema, {
		taskId: 'integration',
		baseCommit,
		prerequisiteTaskIds: ['api'],
		orderedPatches: [],
		ready: true,
		blockers: [],
		executionAuthorized: false,
	}));
	assert.throws(() => v.parse(IntegrationAssemblyPlanSchema, {
		taskId: 'integration',
		baseCommit,
		prerequisiteTaskIds: ['api', 'ui'],
		orderedPatches: [
			{ taskId: 'ui', patchSha256: 'b'.repeat(64), changedPaths: ['src/ui/view.ts'] },
			{ taskId: 'api', patchSha256: 'c'.repeat(64), changedPaths: ['src/api/client.ts'] },
		],
		ready: true,
		blockers: [],
		executionAuthorized: false,
	}));
});
