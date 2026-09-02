import * as v from 'valibot';
import { authorizeTaskPatch } from './task-scope-enforcement.ts';
import {
	dependencyLayers,
	MultiWorkerPlanV2Schema,
	WorkPlanTaskIdSchema,
	type MultiWorkerPlanV2,
} from './work-plan-contracts.ts';

const GitObjectIdSchema = v.pipe(
	v.string(),
	v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Git object IDs must be lowercase hexadecimal SHA-1 or SHA-256 values'),
);

const Sha256Schema = v.pipe(
	v.string(),
	v.regex(/^[a-f0-9]{64}$/, 'Patch digests must be lowercase SHA-256 values'),
);

const ChangedPathsSchema = v.pipe(
	v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
	v.maxLength(100),
);

export const CompletedTaskPatchSchema = v.object({
	taskId: WorkPlanTaskIdSchema,
	baseCommit: GitObjectIdSchema,
	patchSha256: Sha256Schema,
	changedPaths: ChangedPathsSchema,
});

export const IntegrationAssemblyBlockerSchema = v.object({
	taskId: WorkPlanTaskIdSchema,
	reason: v.picklist([
		'missing_evidence',
		'duplicate_evidence',
		'unexpected_evidence',
		'base_mismatch',
		'scope_violation',
	]),
});

export const IntegrationAssemblyPatchSchema = v.object({
	taskId: WorkPlanTaskIdSchema,
	patchSha256: Sha256Schema,
	changedPaths: ChangedPathsSchema,
});

export const IntegrationAssemblyPlanSchema = v.pipe(
	v.object({
		taskId: WorkPlanTaskIdSchema,
		baseCommit: GitObjectIdSchema,
		prerequisiteTaskIds: v.pipe(v.array(WorkPlanTaskIdSchema), v.minLength(1), v.maxLength(31)),
		orderedPatches: v.pipe(v.array(IntegrationAssemblyPatchSchema), v.maxLength(31)),
		ready: v.boolean(),
		blockers: v.pipe(v.array(IntegrationAssemblyBlockerSchema), v.maxLength(96)),
		executionAuthorized: v.literal(false),
	}),
	v.check((plan) => plan.ready === (plan.blockers.length === 0), 'Integration readiness must agree with its blockers'),
	v.check(
		(plan) => new Set(plan.prerequisiteTaskIds).size === plan.prerequisiteTaskIds.length,
		'Integration prerequisite task IDs must be unique',
	),
	v.check(
		(plan) => plan.ready ? plan.orderedPatches.length === plan.prerequisiteTaskIds.length : plan.orderedPatches.length === 0,
		'Ready integration plans require every ordered patch; blocked plans cannot expose an assembly stack',
	),
	v.check(
		(plan) => !plan.ready || plan.orderedPatches.every((patch, index) => patch.taskId === plan.prerequisiteTaskIds[index]),
		'Integration patch order must exactly match prerequisite task order',
	),
);

export type CompletedTaskPatch = v.InferOutput<typeof CompletedTaskPatchSchema>;
export type IntegrationAssemblyBlocker = v.InferOutput<typeof IntegrationAssemblyBlockerSchema>;
export type IntegrationAssemblyPlan = v.InferOutput<typeof IntegrationAssemblyPlanSchema>;

export class IntegrationAssemblyError extends Error {}

function transitivePrerequisites(plan: MultiWorkerPlanV2, taskId: string): Set<string> {
	const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
	const prerequisites = new Set<string>();
	function visit(id: string): void {
		for (const dependency of taskById.get(id)?.dependsOn ?? []) {
			if (prerequisites.has(dependency)) continue;
			prerequisites.add(dependency);
			visit(dependency);
		}
	}
	visit(taskId);
	return prerequisites;
}

/**
 * Builds a deterministic prerequisite patch stack for one dependency-bearing task.
 * Scope authorization is recomputed from changed paths. Readiness remains evidence
 * only and never grants a workspace, worker, model call, or execution lease.
 */
export function planIntegrationAssembly(
	inputPlan: MultiWorkerPlanV2,
	inputTaskId: string,
	inputBaseCommit: string,
	inputPatches: readonly CompletedTaskPatch[],
): IntegrationAssemblyPlan {
	const plan = v.parse(MultiWorkerPlanV2Schema, inputPlan);
	const taskId = v.parse(WorkPlanTaskIdSchema, inputTaskId);
	const baseCommit = v.parse(GitObjectIdSchema, inputBaseCommit);
	const task = plan.tasks.find(({ id }) => id === taskId);
	if (!task) throw new IntegrationAssemblyError(`Task is not present in the scoped plan: ${taskId}`);
	const prerequisiteSet = transitivePrerequisites(plan, taskId);
	if (prerequisiteSet.size === 0) throw new IntegrationAssemblyError(`Task has no prerequisite patches to integrate: ${taskId}`);
	if (inputPatches.length > 32) throw new IntegrationAssemblyError('Integration input contains more than 32 patch records');
	const patches = inputPatches.map((patch) => v.parse(CompletedTaskPatchSchema, patch));
	const prerequisiteTaskIds = dependencyLayers(plan).flat().filter((id) => prerequisiteSet.has(id));
	const blockers: IntegrationAssemblyBlocker[] = [];
	const firstPatchByTask = new Map<string, CompletedTaskPatch>();

	for (const patch of patches) {
		if (!prerequisiteSet.has(patch.taskId)) {
			blockers.push({ taskId: patch.taskId, reason: 'unexpected_evidence' });
			continue;
		}
		if (firstPatchByTask.has(patch.taskId)) {
			blockers.push({ taskId: patch.taskId, reason: 'duplicate_evidence' });
			continue;
		}
		firstPatchByTask.set(patch.taskId, patch);
	}

	for (const prerequisiteTaskId of prerequisiteTaskIds) {
		const patch = firstPatchByTask.get(prerequisiteTaskId);
		if (!patch) {
			blockers.push({ taskId: prerequisiteTaskId, reason: 'missing_evidence' });
			continue;
		}
		if (patch.baseCommit !== baseCommit) blockers.push({ taskId: prerequisiteTaskId, reason: 'base_mismatch' });
		if (!authorizeTaskPatch(plan, prerequisiteTaskId, patch.changedPaths).authorized) {
			blockers.push({ taskId: prerequisiteTaskId, reason: 'scope_violation' });
		}
	}

	const ready = blockers.length === 0;
	const orderedPatches = ready ? prerequisiteTaskIds.map((prerequisiteTaskId) => {
		const patch = firstPatchByTask.get(prerequisiteTaskId);
		if (!patch) throw new IntegrationAssemblyError(`Ready integration plan lost patch evidence: ${prerequisiteTaskId}`);
		return { taskId: patch.taskId, patchSha256: patch.patchSha256, changedPaths: patch.changedPaths };
	}) : [];

	return v.parse(IntegrationAssemblyPlanSchema, {
		taskId,
		baseCommit,
		prerequisiteTaskIds,
		orderedPatches,
		ready,
		blockers,
		executionAuthorized: false,
	});
}
