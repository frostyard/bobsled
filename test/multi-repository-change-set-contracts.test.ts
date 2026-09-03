import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import {
	MultiRepositoryChangeSetPlanV1Schema,
	projectMultiRepositoryChangeSetReadiness,
} from '../src/control-plane/multi-repository-change-set-contracts.ts';
import { repositories } from '../src/control-plane/repositories.ts';

function unit(repositoryId: string, dependsOn: string[] = []) {
	return {
		repositoryId,
		title: `Update ${repositoryId}`,
		objective: `Keep ${repositoryId} compatible with the coordinated change.`,
		acceptanceCriteria: [`${repositoryId} passes its declared gates.`],
		dependsOn,
		compatibilityContracts: dependsOn.map((dependencyRepositoryId) => ({
			dependencyRepositoryId,
			kind: 'api' as const,
			expectation: `${repositoryId} consumes the updated interface from ${dependencyRepositoryId}.`,
			verification: ['The dependent repository verifies the new interface.'],
		})),
	};
}

const changeSet = {
	version: 1 as const,
	title: 'Coordinate a service and website contract',
	objective: 'Change a shared interface without publishing an incompatible dependent.',
	repositories: [
		unit('frostyard/clix'),
		unit('frostyard/bobsled', ['frostyard/clix']),
		unit('frostyard/frostyard-org', ['frostyard/bobsled']),
	],
	assumptions: [],
	risks: ['Rollout remains human controlled.'],
};

function mutuallyCoordinated(ids: string[]): RepositoryContract[] {
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository,
		multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

test('accepts a typed compatibility DAG and projects dependency-first rollout layers without authority', () => {
	const parsed = v.parse(MultiRepositoryChangeSetPlanV1Schema, changeSet);
	const readiness = projectMultiRepositoryChangeSetReadiness(parsed, mutuallyCoordinated(parsed.repositories.map(({ repositoryId }) => repositoryId)));
	assert.deepEqual(readiness, {
		version: 1,
		dependencyLayers: [['frostyard/clix'], ['frostyard/bobsled'], ['frostyard/frostyard-org']],
		violations: [],
		coordinationAllowed: true,
		executionAuthorized: false,
		publicationAuthorized: false,
	});
});

test('rejects malformed repository dependency graphs and missing compatibility contracts', () => {
	assert.throws(() => v.parse(MultiRepositoryChangeSetPlanV1Schema, { ...changeSet, repositories: [unit('frostyard/clix'), unit('frostyard/clix')] }));
	assert.throws(() => v.parse(MultiRepositoryChangeSetPlanV1Schema, { ...changeSet, repositories: [unit('frostyard/clix'), unit('frostyard/bobsled', ['frostyard/missing'])] }));
	assert.throws(() => v.parse(MultiRepositoryChangeSetPlanV1Schema, { ...changeSet, repositories: [unit('frostyard/clix'), unit('frostyard/bobsled', ['frostyard/bobsled'])] }));
	assert.throws(() => v.parse(MultiRepositoryChangeSetPlanV1Schema, {
		...changeSet,
		repositories: [unit('frostyard/clix', ['frostyard/bobsled']), unit('frostyard/bobsled', ['frostyard/clix'])],
	}));
	assert.throws(() => v.parse(MultiRepositoryChangeSetPlanV1Schema, {
		...changeSet,
		repositories: [unit('frostyard/clix'), { ...unit('frostyard/bobsled', ['frostyard/clix']), compatibilityContracts: [] }],
	}));
});

test('reports unenrolled and one-sided coordination policy without granting execution', () => {
	const plan = v.parse(MultiRepositoryChangeSetPlanV1Schema, {
		...changeSet,
		repositories: [unit('frostyard/clix'), unit('frostyard/unknown', ['frostyard/clix'])],
	});
	const unenrolled = projectMultiRepositoryChangeSetReadiness(plan, repositories);
	assert.deepEqual(unenrolled.violations.map(({ code }) => code), ['repository_not_enrolled']);
	assert.equal(unenrolled.coordinationAllowed, false);
	assert.equal(unenrolled.executionAuthorized, false);
	assert.equal(unenrolled.publicationAuthorized, false);

	const enrolledPlan = v.parse(MultiRepositoryChangeSetPlanV1Schema, {
		...changeSet,
		repositories: [unit('frostyard/clix'), unit('frostyard/bobsled', ['frostyard/clix'])],
	});
	const oneSided = mutuallyCoordinated(['frostyard/clix', 'frostyard/bobsled']).map((repository) => repository.id === 'frostyard/clix'
		? { ...repository, multiRepo: { coordinateWith: [] } }
		: repository);
	const denied = projectMultiRepositoryChangeSetReadiness(enrolledPlan, oneSided);
	assert.deepEqual(denied.violations.map(({ code }) => code), ['coordination_not_mutual']);
	assert.equal(denied.coordinationAllowed, false);

	const independent = v.parse(MultiRepositoryChangeSetPlanV1Schema, {
		...changeSet,
		repositories: [unit('frostyard/clix'), unit('frostyard/bobsled')],
	});
	const independentDenied = projectMultiRepositoryChangeSetReadiness(independent, repositories);
	assert.deepEqual(independentDenied.violations.map(({ code }) => code), ['coordination_not_mutual']);
});
