import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
	MultiWorkerPlanSchema,
	MultiWorkerPlanV2Schema,
	dependencyLayers,
	fileScopeReadinessLayers,
	fileScopesOverlap,
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

function scopedTask(id: string, fileScopes: Array<{ kind: 'repository' } | { kind: 'directory' | 'file'; path: string }>, dependsOn: string[] = []) {
	return { ...task(id, dependsOn), fileScopes };
}

const versionOneDiamond = {
	version: 1 as const,
	summary: 'Implement two dependency-ready foundations before integration.',
	tasks: [
		task('foundation'),
		task('api', ['foundation']),
		task('ui', ['foundation']),
		task('integration', ['api', 'ui']),
	],
	assumptions: [],
	risks: ['File ownership is not represented yet.'],
};

const scopedDiamond = {
	version: 2 as const,
	summary: 'Assign exact file ownership without granting worker execution.',
	tasks: [
		scopedTask('foundation', [{ kind: 'repository' }]),
		scopedTask('api', [{ kind: 'directory', path: 'src/api' }], ['foundation']),
		scopedTask('ui', [{ kind: 'directory', path: 'src/ui' }], ['foundation']),
		scopedTask('integration', [{ kind: 'repository' }], ['api', 'ui']),
	],
	assumptions: [],
	risks: ['Execution leases and fan-out are not implemented.'],
};

test('preserves version one DAGs and deterministic dependency layers', () => {
	const parsed = v.parse(MultiWorkerPlanSchema, versionOneDiamond);
	assert.deepEqual(dependencyLayers(parsed), [
		['foundation'],
		['api', 'ui'],
		['integration'],
	]);
	assert.equal('fileScopes' in parsed.tasks[1]!, false);
});

test('accepts scoped DAGs and projects non-executable scope readiness', () => {
	const parsed = v.parse(MultiWorkerPlanV2Schema, scopedDiamond);
	assert.deepEqual(dependencyLayers(parsed), [
		['foundation'],
		['api', 'ui'],
		['integration'],
	]);
	assert.deepEqual(fileScopeReadinessLayers(parsed), [
		{ taskIds: ['foundation'], scopesDisjoint: true, executionAuthorized: false },
		{ taskIds: ['api', 'ui'], scopesDisjoint: true, executionAuthorized: false },
		{ taskIds: ['integration'], scopesDisjoint: true, executionAuthorized: false },
	]);
});

test('rejects duplicate task IDs and invalid dependency edges in both versions', () => {
	for (const version of [1, 2] as const) {
		const base = version === 1 ? versionOneDiamond : scopedDiamond;
		const make = version === 1
			? (id: string, dependencies: string[] = []) => task(id, dependencies)
			: (id: string, dependencies: string[] = []) => scopedTask(id, [{ kind: 'file', path: `${id}.ts` }], dependencies);
		assert.throws(() => v.parse(MultiWorkerPlanSchema, { ...base, tasks: [make('same'), make('same')] }));
		assert.throws(() => v.parse(MultiWorkerPlanSchema, { ...base, tasks: [make('foundation'), make('consumer', ['foundation', 'foundation'])] }));
		assert.throws(() => v.parse(MultiWorkerPlanSchema, { ...base, tasks: [make('consumer', ['missing'])] }));
		assert.throws(() => v.parse(MultiWorkerPlanSchema, { ...base, tasks: [make('self', ['self'])] }));
		assert.throws(() => v.parse(MultiWorkerPlanSchema, { ...base, tasks: [make('first', ['second']), make('second', ['first'])] }));
	}
});

test('requires normalized literal repository-relative paths', () => {
	for (const path of ['/absolute.ts', 'src/', 'src//file.ts', 'src/../file.ts', 'src/*.ts', 'src\\file.ts', 'src/line\nbreak.ts']) {
		assert.throws(() => v.parse(MultiWorkerPlanV2Schema, {
			...scopedDiamond,
			tasks: [scopedTask('invalid', [{ kind: 'file', path }])],
		}));
	}
	assert.doesNotThrow(() => v.parse(MultiWorkerPlanV2Schema, {
		...scopedDiamond,
		tasks: [scopedTask('valid', [{ kind: 'file', path: 'docs/design notes.md' }])],
	}));
});

test('detects exact file, directory-prefix, and repository-wide overlap', () => {
	assert.equal(fileScopesOverlap({ kind: 'file', path: 'src/a.ts' }, { kind: 'file', path: 'src/a.ts' }), true);
	assert.equal(fileScopesOverlap({ kind: 'file', path: 'src/a.ts' }, { kind: 'file', path: 'src/b.ts' }), false);
	assert.equal(fileScopesOverlap({ kind: 'directory', path: 'src' }, { kind: 'file', path: 'src/a.ts' }), true);
	assert.equal(fileScopesOverlap({ kind: 'directory', path: 'src/api' }, { kind: 'directory', path: 'src/ui' }), false);
	assert.equal(fileScopesOverlap({ kind: 'repository' }, { kind: 'file', path: 'README.md' }), true);
});

test('rejects redundant task scopes and overlap between dependency-ready tasks', () => {
	assert.throws(() => v.parse(MultiWorkerPlanV2Schema, {
		...scopedDiamond,
		tasks: [scopedTask('redundant', [
			{ kind: 'directory', path: 'src' },
			{ kind: 'file', path: 'src/index.ts' },
		])],
	}));
	assert.throws(() => v.parse(MultiWorkerPlanV2Schema, {
		...scopedDiamond,
		tasks: [
			scopedTask('left', [{ kind: 'directory', path: 'src' }]),
			scopedTask('right', [{ kind: 'file', path: 'src/index.ts' }]),
		],
	}));
	assert.throws(() => v.parse(MultiWorkerPlanV2Schema, {
		...scopedDiamond,
		tasks: [
			scopedTask('independent', [{ kind: 'file', path: 'src/shared.ts' }]),
			scopedTask('foundation', [{ kind: 'file', path: 'src/foundation.ts' }]),
			scopedTask('later-but-unordered', [{ kind: 'file', path: 'src/shared.ts' }], ['foundation']),
		],
	}));
});

test('allows dependency-ordered scope reuse without calling it parallel-safe', () => {
	const parsed = v.parse(MultiWorkerPlanV2Schema, {
		...scopedDiamond,
		tasks: [
			scopedTask('foundation', [{ kind: 'directory', path: 'src' }]),
			scopedTask('integration', [{ kind: 'file', path: 'src/index.ts' }], ['foundation']),
		],
	});
	assert.deepEqual(fileScopeReadinessLayers(parsed), [
		{ taskIds: ['foundation'], scopesDisjoint: true, executionAuthorized: false },
		{ taskIds: ['integration'], scopesDisjoint: true, executionAuthorized: false },
	]);
});
