import * as v from 'valibot';
import { RepositoryContractSchema, WorkItemSchema } from './contracts.ts';
import { MultiWorkerPlanV2Schema, WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const PathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(500));

export const IntegrationConflictAgentInitialDataSchema = v.object({
	agentAttemptId: v.pipe(v.string(), v.uuid()),
	sourceResolutionId: v.pipe(v.string(), v.uuid()),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	sandboxHomePath: v.pipe(v.string(), v.minLength(1)),
	toolDataPath: v.pipe(v.string(), v.minLength(1)),
	executablePath: v.pipe(v.string(), v.minLength(1)),
	baseCommit: GitObjectIdSchema,
	conflictPaths: v.pipe(v.array(PathSchema), v.minLength(1), v.maxLength(100)),
	nonConflictStateSha256: Sha256Schema,
	plan: MultiWorkerPlanV2Schema,
	taskId: WorkPlanTaskIdSchema,
	repository: RepositoryContractSchema,
	workItem: WorkItemSchema,
	maxModelCalls: v.literal(1),
});

export const IntegrationConflictAgentResultSchema = v.pipe(v.object({
	disposition: v.picklist(['resolved', 'blocked']),
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
	resolvedPaths: v.pipe(v.array(PathSchema), v.maxLength(100)),
	testsRun: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
	notes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
}), v.check(
	(result) => result.disposition !== 'resolved' || result.resolvedPaths.length > 0,
	'Resolved conflict results must report at least one resolved path',
));

export const IntegrationConflictAgentOutcomeSchema = v.object({
	conversationId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	submissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	result: IntegrationConflictAgentResultSchema,
	text: v.pipe(v.string(), v.maxLength(200_000)),
});

export const IntegrationConflictAgentRunEvidenceSchema = v.variant('status', [
	v.object({ status: v.literal('completed'), receipt: IntegrationConflictAgentOutcomeSchema }),
	v.object({ status: v.literal('failed'), detail: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)) }),
]);

export type IntegrationConflictAgentInitialData = v.InferOutput<typeof IntegrationConflictAgentInitialDataSchema>;
export type IntegrationConflictAgentResult = v.InferOutput<typeof IntegrationConflictAgentResultSchema>;
export type IntegrationConflictAgentOutcome = v.InferOutput<typeof IntegrationConflictAgentOutcomeSchema>;
export type IntegrationConflictAgentRunEvidence = v.InferOutput<typeof IntegrationConflictAgentRunEvidenceSchema>;
