import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
	MultiWorkerPlanSchema,
	dependencyLayers,
} from '../src/control-plane/work-plan-contracts.ts';

function task(id: string, dependsOn: string[] = []) {
	return {
		id,
		title: `Implement ${id}`,
		objective: `Produce the bounded ${id} deliverable.`,
		acceptanceCriteria: [`${id} is verified.`],
		dependsOn,
	};
}

const diamondPlan = {
	version: 1 as const,
	summary: 'Implement two independent foundations before integration.',
	tasks: [
		task('foundation'),
		task('api', ['foundation']),
		task('ui', ['foundation']),
		task('integration', ['api', 'ui']),
	],
	assumptions: [],
	risks: ['File ownership is not represented yet.'],
};

test('accepts a typed dependency DAG and returns deterministic readiness layers', () => {
	const parsed = v.parse(MultiWorkerPlanSchema, diamondPlan);
	assert.deepEqual(dependencyLayers(parsed), [
		['foundation'],
		['api', 'ui'],
		['integration'],
	]);
});

test('rejects duplicate task IDs and duplicate dependency edges', () => {
	assert.throws(() => v.parse(MultiWorkerPlanSchema, {
		...diamondPlan,
		tasks: [task('same'), task('same')],
	}));
	assert.throws(() => v.parse(MultiWorkerPlanSchema, {
		...diamondPlan,
		tasks: [task('foundation'), task('consumer', ['foundation', 'foundation'])],
	}));
});

test('rejects unknown, self, and cyclic dependencies', () => {
	assert.throws(() => v.parse(MultiWorkerPlanSchema, {
		...diamondPlan,
		tasks: [task('consumer', ['missing'])],
	}));
	assert.throws(() => v.parse(MultiWorkerPlanSchema, {
		...diamondPlan,
		tasks: [task('self', ['self'])],
	}));
	assert.throws(() => v.parse(MultiWorkerPlanSchema, {
		...diamondPlan,
		tasks: [task('first', ['second']), task('second', ['first'])],
	}));
});

test('does not describe dependency-ready tasks as safe for parallel execution', () => {
	const parsed = v.parse(MultiWorkerPlanSchema, diamondPlan);
	assert.equal('parallel' in parsed.tasks[1], false);
	assert.equal('fileScopes' in parsed.tasks[1], false);
});
