import * as v from 'valibot';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import {
	dependencyEdgesAreUnique,
	dependencyGraphExcludesSelfEdges,
	dependencyGraphIsAcyclic,
	dependencyLayersForNodes,
	dependencyNodeIdsAreUnique,
	dependencyTargetsExist,
} from './dependency-graph.ts';

export const RepositoryCompatibilityKindSchema = v.picklist(['api', 'schema', 'artifact', 'runtime', 'documentation']);

export const RepositoryCompatibilityContractSchema = v.object({
	dependencyRepositoryId: RepositoryIdSchema,
	kind: RepositoryCompatibilityKindSchema,
	expectation: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	verification: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
		v.minLength(1),
		v.maxLength(20),
	),
});

export const MultiRepositoryChangeUnitSchema = v.object({
	repositoryId: RepositoryIdSchema,
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	objective: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	acceptanceCriteria: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
		v.minLength(1),
		v.maxLength(20),
	),
	dependsOn: v.pipe(v.array(RepositoryIdSchema), v.maxLength(15)),
	compatibilityContracts: v.pipe(v.array(RepositoryCompatibilityContractSchema), v.maxLength(15)),
});

interface ChangeSetShape {
	repositories: Array<{
		repositoryId: string;
		dependsOn: string[];
		compatibilityContracts: Array<{ dependencyRepositoryId: string }>;
	}>;
}

function dependencyNodes(changeSet: ChangeSetShape): Array<{ id: string; dependsOn: string[] }> {
	return changeSet.repositories.map(({ repositoryId, dependsOn }) => ({ id: repositoryId, dependsOn }));
}

function compatibilityContractsMatchDependencies(changeSet: ChangeSetShape): boolean {
	return changeSet.repositories.every(({ dependsOn, compatibilityContracts }) => {
		const contracted = compatibilityContracts.map(({ dependencyRepositoryId }) => dependencyRepositoryId);
		return new Set(contracted).size === contracted.length
			&& contracted.length === dependsOn.length
			&& dependsOn.every((dependency) => contracted.includes(dependency));
	});
}

const MultiRepositoryChangeSetPlanV1ObjectSchema = v.object({
	version: v.literal(1),
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	objective: v.pipe(v.string(), v.minLength(1), v.maxLength(5_000)),
	repositories: v.pipe(v.array(MultiRepositoryChangeUnitSchema), v.minLength(2), v.maxLength(16)),
	assumptions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
	risks: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
});

export const MultiRepositoryChangeSetPlanV1Schema = v.pipe(
	MultiRepositoryChangeSetPlanV1ObjectSchema,
	v.check((changeSet) => dependencyNodeIdsAreUnique(dependencyNodes(changeSet)), 'Change-set repository IDs must be unique'),
	v.check((changeSet) => dependencyEdgesAreUnique(dependencyNodes(changeSet)), 'A repository cannot repeat a dependency'),
	v.check((changeSet) => dependencyTargetsExist(dependencyNodes(changeSet)), 'Every repository dependency must belong to the same change set'),
	v.check((changeSet) => dependencyGraphExcludesSelfEdges(dependencyNodes(changeSet)), 'A repository cannot depend on itself'),
	v.check((changeSet) => dependencyGraphIsAcyclic(dependencyNodes(changeSet)), 'Repository dependencies must form an acyclic graph'),
	v.check((changeSet) => compatibilityContractsMatchDependencies(changeSet), 'Every dependency requires exactly one matching compatibility contract'),
);

export const MultiRepositoryReadinessViolationCodeSchema = v.picklist([
	'repository_not_enrolled',
	'coordination_not_mutual',
]);

export const MultiRepositoryReadinessViolationSchema = v.object({
	code: MultiRepositoryReadinessViolationCodeSchema,
	repositoryId: RepositoryIdSchema,
	dependencyRepositoryId: v.optional(RepositoryIdSchema),
	detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export const MultiRepositoryChangeSetReadinessSchema = v.object({
	version: v.literal(1),
	dependencyLayers: v.array(v.array(RepositoryIdSchema)),
	violations: v.array(MultiRepositoryReadinessViolationSchema),
	coordinationAllowed: v.boolean(),
	executionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
});

export type MultiRepositoryChangeSetPlanV1 = v.InferOutput<typeof MultiRepositoryChangeSetPlanV1Schema>;
export type MultiRepositoryChangeSetReadiness = v.InferOutput<typeof MultiRepositoryChangeSetReadinessSchema>;

/**
 * Evaluates enrollment and mutual coordination allowlists without granting jobs,
 * workspaces, model calls, branches, publications, rollout, or merge authority.
 */
export function projectMultiRepositoryChangeSetReadiness(
	input: MultiRepositoryChangeSetPlanV1,
	repositories: readonly RepositoryContract[],
): MultiRepositoryChangeSetReadiness {
	const changeSet = v.parse(MultiRepositoryChangeSetPlanV1Schema, input);
	const enrolled = new Map(repositories.filter(({ enabled }) => enabled).map((repository) => [repository.id, repository]));
	const violations: v.InferOutput<typeof MultiRepositoryReadinessViolationSchema>[] = [];

	for (const unit of changeSet.repositories) {
		if (!enrolled.has(unit.repositoryId)) {
			violations.push({
				code: 'repository_not_enrolled', repositoryId: unit.repositoryId,
				detail: `${unit.repositoryId} is not an enabled enrolled repository.`,
			});
		}
	}

	for (const [index, unit] of changeSet.repositories.entries()) {
		const repository = enrolled.get(unit.repositoryId);
		for (const participant of changeSet.repositories.slice(index + 1)) {
			const other = enrolled.get(participant.repositoryId);
			if (!repository || !other) continue;
			if (!repository.multiRepo.coordinateWith.includes(other.id) || !other.multiRepo.coordinateWith.includes(repository.id)) {
				violations.push({
					code: 'coordination_not_mutual', repositoryId: unit.repositoryId, dependencyRepositoryId: participant.repositoryId,
					detail: `${unit.repositoryId} and ${participant.repositoryId} do not mutually permit coordinated changes.`,
				});
			}
		}
	}

	return v.parse(MultiRepositoryChangeSetReadinessSchema, {
		version: 1,
		dependencyLayers: dependencyLayersForNodes(dependencyNodes(changeSet)),
		violations,
		coordinationAllowed: violations.length === 0,
		executionAuthorized: false,
		publicationAuthorized: false,
	});
}
