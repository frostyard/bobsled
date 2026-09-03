import * as v from 'valibot';
import { PreparationResultSchema } from './execution-contracts.ts';
import { WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const PathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
export const IntegrationConflictAgentPreflightViolationSchema = v.picklist([
	'policy_denied',
	'missing_replay_manifest',
	'patch_evidence_tampered',
	'preparation_failed',
	'preparation_changed_workspace',
	'head_moved',
	'applied_prefix_mismatch',
	'failed_task_mismatch',
	'conflict_paths_mismatch',
	'conflict_not_reproduced',
	'replay_failed',
]);
export type IntegrationConflictAgentPreflightViolation = v.InferOutput<typeof IntegrationConflictAgentPreflightViolationSchema>;

const Entries = {
	agentAttemptId: v.pipe(v.string(), v.uuid()),
	sourceResolutionId: v.pipe(v.string(), v.uuid()),
	baseCommit: GitObjectIdSchema,
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	appliedTaskIds: v.pipe(v.array(WorkPlanTaskIdSchema), v.maxLength(31)),
	failedTaskId: v.optional(WorkPlanTaskIdSchema),
	changedPaths: v.pipe(v.array(PathSchema), v.maxLength(100)),
	conflictPaths: v.pipe(v.array(PathSchema), v.maxLength(100)),
	modelCalls: v.literal(0),
	workerAuthorized: v.literal(false),
};

export const IntegrationConflictAgentPreflightResultSchema = v.pipe(v.variant('status', [
	v.object({
		...Entries, status: v.literal('passed'), preparation: PreparationResultSchema,
		headCommit: GitObjectIdSchema, violations: v.pipe(v.array(v.never()), v.length(0)),
	}),
	v.object({
		...Entries,
		status: v.literal('blocked'),
		preparation: v.optional(PreparationResultSchema),
		headCommit: v.optional(GitObjectIdSchema),
		violations: v.pipe(v.array(IntegrationConflictAgentPreflightViolationSchema), v.minLength(1), v.maxLength(11)),
		detail: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
	}),
]), v.check(
	(result) => result.status !== 'passed' || (result.preparation.status === 'passed' && result.conflictPaths.length > 0),
	'Passing conflict-agent preflight requires successful preparation and reproduced conflicts',
));

export type IntegrationConflictAgentPreflightResult = v.InferOutput<typeof IntegrationConflictAgentPreflightResultSchema>;
