import * as v from 'valibot';
import {
	dependencyEdgesAreUnique,
	dependencyGraphExcludesSelfEdges,
	dependencyGraphIsAcyclic,
	dependencyLayersForNodes,
	dependencyNodeIdsAreUnique,
	dependencyTargetsExist,
} from './dependency-graph.ts';

export const WorkPlanTaskIdSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(64),
	v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Task IDs must be lowercase kebab-case'),
);

export const RepositoryRelativePathSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(500),
	v.check((path) => !path.startsWith('/') && !path.endsWith('/'), 'Owned paths must be repository-relative without a trailing slash'),
	v.check((path) => !/[\\*?\[\]\u0000-\u001f\u007f]/.test(path), 'Owned paths must be literal POSIX paths without glob or control characters'),
	v.check((path) => path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'), 'Owned paths must be normalized without empty, dot, or parent segments'),
);

export const FileOwnershipScopeSchema = v.variant('kind', [
	v.object({ kind: v.literal('repository') }),
	v.object({ kind: v.literal('directory'), path: RepositoryRelativePathSchema }),
	v.object({ kind: v.literal('file'), path: RepositoryRelativePathSchema }),
]);

const WorkPlanTaskEntries = {
	id: WorkPlanTaskIdSchema,
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	objective: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	acceptanceCriteria: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
		v.minLength(1),
		v.maxLength(20),
	),
	dependsOn: v.pipe(v.array(WorkPlanTaskIdSchema), v.maxLength(32)),
};

export const WorkPlanTaskSchema = v.object(WorkPlanTaskEntries);

export const ScopedWorkPlanTaskSchema = v.object({
	...WorkPlanTaskEntries,
	fileScopes: v.pipe(v.array(FileOwnershipScopeSchema), v.minLength(1), v.maxLength(32)),
});

const MultiWorkerPlanV1ObjectSchema = v.object({
	version: v.literal(1),
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	tasks: v.pipe(v.array(WorkPlanTaskSchema), v.minLength(1), v.maxLength(32)),
	assumptions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
	risks: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
});

const MultiWorkerPlanV2ObjectSchema = v.object({
	version: v.literal(2),
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	tasks: v.pipe(v.array(ScopedWorkPlanTaskSchema), v.minLength(1), v.maxLength(32)),
	assumptions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
	risks: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
});

interface DependencyPlanShape {
	tasks: Array<{ id: string; dependsOn: string[] }>;
}

export type FileOwnershipScope = v.InferOutput<typeof FileOwnershipScopeSchema>;

export function fileScopesOverlap(left: FileOwnershipScope, right: FileOwnershipScope): boolean {
	if (left.kind === 'repository' || right.kind === 'repository') return true;
	if (left.kind === 'file' && right.kind === 'file') return left.path === right.path;
	const directory = left.kind === 'directory' ? left : right.kind === 'directory' ? right : undefined;
	const candidate = directory === left ? right : left;
	if (!directory) return false;
	return candidate.path === directory.path || candidate.path.startsWith(`${directory.path}/`);
}

interface ScopedDependencyPlanShape extends DependencyPlanShape {
	tasks: Array<{ id: string; dependsOn: string[]; fileScopes: FileOwnershipScope[] }>;
}

function taskScopesAreMinimal(plan: ScopedDependencyPlanShape): boolean {
	return plan.tasks.every(({ fileScopes }) => fileScopes.every((scope, index) =>
		fileScopes.slice(index + 1).every((candidate) => !fileScopesOverlap(scope, candidate)),
	));
}

function tasksAreDependencyOrdered(plan: ScopedDependencyPlanShape, taskId: string, possibleAncestorId: string): boolean {
	const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
	const visited = new Set<string>();
	function visit(id: string): boolean {
		if (visited.has(id)) return false;
		visited.add(id);
		const dependencies = taskById.get(id)?.dependsOn ?? [];
		return dependencies.includes(possibleAncestorId) || dependencies.some(visit);
	}
	return visit(taskId);
}

function unorderedTaskScopesAreDisjoint(plan: ScopedDependencyPlanShape): boolean {
	return plan.tasks.every((left, leftIndex) => plan.tasks.slice(leftIndex + 1).every((right) => {
		const ordered = tasksAreDependencyOrdered(plan, left.id, right.id) || tasksAreDependencyOrdered(plan, right.id, left.id);
		if (ordered) return true;
		return left.fileScopes.every((leftScope) => right.fileScopes.every((rightScope) => !fileScopesOverlap(leftScope, rightScope)));
	}));
}

export const MultiWorkerPlanV1Schema = v.pipe(
	MultiWorkerPlanV1ObjectSchema,
	v.check((plan) => dependencyNodeIdsAreUnique(plan.tasks), 'Work-plan task IDs must be unique'),
	v.check((plan) => dependencyEdgesAreUnique(plan.tasks), 'A task cannot repeat a dependency'),
	v.check((plan) => dependencyTargetsExist(plan.tasks), 'Every dependency must reference a task in the same plan'),
	v.check((plan) => dependencyGraphExcludesSelfEdges(plan.tasks), 'A task cannot depend on itself'),
	v.check((plan) => dependencyGraphIsAcyclic(plan.tasks), 'Work-plan dependencies must form an acyclic graph'),
);

export const MultiWorkerPlanV2Schema = v.pipe(
	MultiWorkerPlanV2ObjectSchema,
	v.check((plan) => dependencyNodeIdsAreUnique(plan.tasks), 'Work-plan task IDs must be unique'),
	v.check((plan) => dependencyEdgesAreUnique(plan.tasks), 'A task cannot repeat a dependency'),
	v.check((plan) => dependencyTargetsExist(plan.tasks), 'Every dependency must reference a task in the same plan'),
	v.check((plan) => dependencyGraphExcludesSelfEdges(plan.tasks), 'A task cannot depend on itself'),
	v.check((plan) => dependencyGraphIsAcyclic(plan.tasks), 'Work-plan dependencies must form an acyclic graph'),
	v.check((plan) => taskScopesAreMinimal(plan), 'A task cannot contain duplicate or overlapping file scopes'),
	v.check((plan) => unorderedTaskScopesAreDisjoint(plan), 'Tasks without dependency ordering must have non-overlapping file scopes'),
);

export const MultiWorkerPlanSchema = v.union([MultiWorkerPlanV1Schema, MultiWorkerPlanV2Schema]);

export type WorkPlanTask = v.InferOutput<typeof WorkPlanTaskSchema>;
export type ScopedWorkPlanTask = v.InferOutput<typeof ScopedWorkPlanTaskSchema>;
export type MultiWorkerPlanV1 = v.InferOutput<typeof MultiWorkerPlanV1Schema>;
export type MultiWorkerPlanV2 = v.InferOutput<typeof MultiWorkerPlanV2Schema>;
export type MultiWorkerPlan = v.InferOutput<typeof MultiWorkerPlanSchema>;

/** Returns deterministic dependency-readiness layers in declared task order. */
export function dependencyLayers(input: MultiWorkerPlan): string[][] {
	const plan = v.parse(MultiWorkerPlanSchema, input);
	const layers = dependencyLayersForNodes(plan.tasks);
	if (layers.length === 0) throw new Error('Validated work plan has no dependency-ready task');
	return layers;
}

export interface FileScopeReadinessLayer {
	taskIds: string[];
	scopesDisjoint: true;
	executionAuthorized: false;
}

/**
 * Projects scope-compatible dependency layers without granting worker fan-out,
 * workspace leases, token spend, or concurrent execution authority.
 */
export function fileScopeReadinessLayers(input: MultiWorkerPlanV2): FileScopeReadinessLayer[] {
	const plan = v.parse(MultiWorkerPlanV2Schema, input);
	return dependencyLayersForNodes(plan.tasks).map((taskIds) => ({
		taskIds,
		scopesDisjoint: true,
		executionAuthorized: false,
	}));
}
