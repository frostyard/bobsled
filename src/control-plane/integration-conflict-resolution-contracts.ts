import * as v from 'valibot';
import { WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

const ResolutionResultEntries = {
	resolutionId: v.pipe(v.string(), v.uuid()),
	sourceAssemblyId: v.pipe(v.string(), v.uuid()),
	taskId: WorkPlanTaskIdSchema,
	baseCommit: GitObjectIdSchema,
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	strategy: v.literal('git_three_way'),
	appliedTaskIds: v.pipe(v.array(WorkPlanTaskIdSchema), v.maxLength(31)),
	changedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
	conflictPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
	modelCalls: v.literal(0),
	workerAuthorized: v.literal(false),
};

export const IntegrationConflictResolutionResultSchema = v.pipe(v.variant('status', [
	v.object({
		...ResolutionResultEntries,
		status: v.literal('resolved'),
		patchSha256: Sha256Schema,
	}),
	v.object({
		...ResolutionResultEntries,
		status: v.literal('blocked'),
		reason: v.picklist(['unresolved_conflict', 'patch_rejected', 'changed_path_mismatch', 'head_moved']),
		failedTaskId: v.optional(WorkPlanTaskIdSchema),
		detail: v.pipe(v.string(), v.maxLength(10_000)),
	}),
]), v.check(
	(result) => result.status === 'resolved' ? result.conflictPaths.length === 0 : true,
	'Resolved conflict evidence cannot retain unmerged paths',
), v.check(
	(result) => result.status !== 'blocked' || result.reason !== 'unresolved_conflict' || result.conflictPaths.length > 0,
	'Unresolved conflict evidence must identify at least one unmerged path',
), v.check(
	(result) => result.status !== 'resolved' || result.appliedTaskIds.length > 0,
	'Resolved conflict evidence must retain its applied patch stack',
));

export type IntegrationConflictResolutionResult = v.InferOutput<typeof IntegrationConflictResolutionResultSchema>;
