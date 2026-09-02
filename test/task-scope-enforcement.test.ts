import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
	authorizeTaskPatch,
	TaskPatchScopeDispositionSchema,
	TaskPatchScopeError,
} from '../src/control-plane/task-scope-enforcement.ts';
import { MultiWorkerPlanV2Schema } from '../src/control-plane/work-plan-contracts.ts';

function task(id: string, fileScopes: Array<{ kind: 'repository' } | { kind: 'directory' | 'file'; path: string }>, dependsOn: string[] = []) {
	return {
		id,
		title: `Implement ${id}`,
		objective: `Produce ${id}.`,
		acceptanceCriteria: [`${id} is verified.`],
		dependsOn,
		fileScopes,
	};
}

const plan = v.parse(MultiWorkerPlanV2Schema, {
	version: 2,
	summary: 'Enforce exact task ownership against trusted patch paths.',
	tasks: [
		task('api', [{ kind: 'directory', path: 'src/api' }, { kind: 'file', path: 'docs/api.md' }]),
		task('ui', [{ kind: 'directory', path: 'src/ui' }]),
		task('integration', [{ kind: 'repository' }], ['api', 'ui']),
	],
	assumptions: [],
	risks: [],
});

test('authorizes a trusted patch only when every path belongs to the task', () => {
	assert.deepEqual(authorizeTaskPatch(plan, 'api', ['src/api/client.ts', 'docs/api.md']), {
		taskId: 'api',
		changedPaths: ['src/api/client.ts', 'docs/api.md'],
		authorized: true,
		violations: [],
	});
	assert.deepEqual(authorizeTaskPatch(plan, 'api', []), {
		taskId: 'api',
		changedPaths: [],
		authorized: true,
		violations: [],
	});
	assert.equal(authorizeTaskPatch(plan, 'integration', ['src/api/client.ts', 'src/ui/view.ts']).authorized, true);
	assert.equal(authorizeTaskPatch(plan, 'api', ['src/apis/client.ts']).authorized, false);
});

test('returns deterministic invalid, duplicate, and outside-scope violations', () => {
	assert.deepEqual(authorizeTaskPatch(plan, 'api', [
		'src/api/client.ts',
		'src/api/client.ts',
		'../escape.ts',
		'src/ui/view.ts',
	]), {
		taskId: 'api',
		changedPaths: ['src/api/client.ts', 'src/api/client.ts', '../escape.ts', 'src/ui/view.ts'],
		authorized: false,
		violations: [
			{ path: 'src/api/client.ts', reason: 'duplicate_path' },
			{ path: '../escape.ts', reason: 'invalid_path' },
			{ path: 'src/ui/view.ts', reason: 'outside_scope' },
		],
	});
});

test('rejects unknown tasks and over-broad trusted path input', () => {
	assert.throws(() => authorizeTaskPatch(plan, 'missing', []), TaskPatchScopeError);
	assert.throws(() => authorizeTaskPatch(plan, 'api', Array.from({ length: 101 }, (_, index) => `src/api/${index}.ts`)), TaskPatchScopeError);
	assert.throws(() => authorizeTaskPatch(plan, 'api', ['x'.repeat(501)]));
});

test('typed evidence cannot claim authorization while retaining violations', () => {
	assert.throws(() => v.parse(TaskPatchScopeDispositionSchema, {
		taskId: 'api',
		changedPaths: ['src/ui/view.ts'],
		authorized: true,
		violations: [{ path: 'src/ui/view.ts', reason: 'outside_scope' }],
	}));
});
