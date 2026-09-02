import * as v from 'valibot';
import {
	MultiWorkerPlanV2Schema,
	RepositoryRelativePathSchema,
	WorkPlanTaskIdSchema,
	type FileOwnershipScope,
	type MultiWorkerPlanV2,
} from './work-plan-contracts.ts';

const ChangedPathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(500));

export const TaskPatchScopeViolationSchema = v.object({
	path: ChangedPathSchema,
	reason: v.picklist(['invalid_path', 'duplicate_path', 'outside_scope']),
});

export const TaskPatchScopeDispositionSchema = v.pipe(
	v.object({
		taskId: WorkPlanTaskIdSchema,
		changedPaths: v.pipe(v.array(ChangedPathSchema), v.maxLength(100)),
		authorized: v.boolean(),
		violations: v.pipe(v.array(TaskPatchScopeViolationSchema), v.maxLength(100)),
	}),
	v.check((disposition) => disposition.authorized === (disposition.violations.length === 0), 'Patch-scope authorization must agree with its violations'),
);

export type TaskPatchScopeViolation = v.InferOutput<typeof TaskPatchScopeViolationSchema>;
export type TaskPatchScopeDisposition = v.InferOutput<typeof TaskPatchScopeDispositionSchema>;

export class TaskPatchScopeError extends Error {}

function fileScopeOwnsPath(scope: FileOwnershipScope, path: string): boolean {
	if (scope.kind === 'repository') return true;
	if (scope.kind === 'file') return scope.path === path;
	return path === scope.path || path.startsWith(`${scope.path}/`);
}

/**
 * Binds trusted Git changed paths to one versioned task's declared ownership.
 * This produces evidence only; it grants no workspace, worker, or execution lease.
 */
export function authorizeTaskPatch(
	inputPlan: MultiWorkerPlanV2,
	inputTaskId: string,
	inputChangedPaths: readonly string[],
): TaskPatchScopeDisposition {
	const plan = v.parse(MultiWorkerPlanV2Schema, inputPlan);
	const taskId = v.parse(WorkPlanTaskIdSchema, inputTaskId);
	const task = plan.tasks.find(({ id }) => id === taskId);
	if (!task) throw new TaskPatchScopeError(`Task is not present in the scoped plan: ${taskId}`);
	if (inputChangedPaths.length > 100) throw new TaskPatchScopeError('Trusted patch contains more than 100 changed paths');
	const changedPaths = inputChangedPaths.map((path) => v.parse(ChangedPathSchema, path));
	const seen = new Set<string>();
	const violations: TaskPatchScopeViolation[] = [];

	for (const path of changedPaths) {
		if (seen.has(path)) {
			violations.push({ path, reason: 'duplicate_path' });
			continue;
		}
		seen.add(path);
		if (!v.safeParse(RepositoryRelativePathSchema, path).success) {
			violations.push({ path, reason: 'invalid_path' });
			continue;
		}
		if (!task.fileScopes.some((scope) => fileScopeOwnsPath(scope, path))) {
			violations.push({ path, reason: 'outside_scope' });
		}
	}

	return v.parse(TaskPatchScopeDispositionSchema, {
		taskId,
		changedPaths,
		authorized: violations.length === 0,
		violations,
	});
}
