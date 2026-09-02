import * as v from 'valibot';
import { RepositoryContractSchema, WorkItemSchema } from './contracts.ts';
import { ImplementationResultSchema } from './execution-contracts.ts';
import { authorizeTaskPatch } from './task-scope-enforcement.ts';
import { MultiWorkerPlanV2Schema, WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

export const IntegrationWorkerInitialDataSchema = v.pipe(
	v.object({
		integrationAttemptId: v.pipe(v.string(), v.uuid()),
		assemblyId: v.pipe(v.string(), v.uuid()),
		workspacePath: v.pipe(v.string(), v.minLength(1)),
		sandboxHomePath: v.pipe(v.string(), v.minLength(1)),
		toolDataPath: v.pipe(v.string(), v.minLength(1)),
		executablePath: v.pipe(v.string(), v.minLength(1)),
		baseCommit: GitObjectIdSchema,
		assemblyPatchSha256: Sha256Schema,
		plan: MultiWorkerPlanV2Schema,
		taskId: WorkPlanTaskIdSchema,
		repository: RepositoryContractSchema,
		workItem: WorkItemSchema,
		maxWorkerCalls: v.literal(1),
	}),
	v.check(
		(input) => input.plan.tasks.some(({ id, dependsOn }) => id === input.taskId && dependsOn.length > 0),
		'Integration workers require a known dependency-bearing task',
	),
);

export const IntegrationWorkerResultSchema = ImplementationResultSchema;

export const IntegrationWorkerOutcomeSchema = v.object({
	conversationId: v.pipe(v.string(), v.minLength(1)),
	submissionId: v.pipe(v.string(), v.minLength(1)),
	result: IntegrationWorkerResultSchema,
	text: v.string(),
});

export const IntegrationWorkerInspectionSchema = v.object({
	headCommit: GitObjectIdSchema,
	stagedPatchSha256: Sha256Schema,
	workerChangedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
	finalPatchSha256: Sha256Schema,
});

export const IntegrationWorkerDispositionSchema = v.pipe(
	v.object({
		integrationAttemptId: v.pipe(v.string(), v.uuid()),
		taskId: WorkPlanTaskIdSchema,
		status: v.picklist(['succeeded', 'blocked']),
		workerCallCount: v.literal(1),
		workerChangedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
		finalPatchSha256: Sha256Schema,
		violations: v.pipe(v.array(v.picklist([
			'worker_blocked',
			'head_moved',
			'index_changed',
			'scope_violation',
			'reported_paths_mismatch',
			'disposition_mismatch',
			'final_patch_mismatch',
		])), v.maxLength(7)),
		furtherWorkerAuthorized: v.literal(false),
	}),
	v.check((result) => result.status === (result.violations.length === 0 ? 'succeeded' : 'blocked'), 'Integration status must agree with trusted violations'),
);

export type IntegrationWorkerInitialData = v.InferOutput<typeof IntegrationWorkerInitialDataSchema>;
export type IntegrationWorkerResult = v.InferOutput<typeof IntegrationWorkerResultSchema>;
export type IntegrationWorkerOutcome = v.InferOutput<typeof IntegrationWorkerOutcomeSchema>;
export type IntegrationWorkerInspection = v.InferOutput<typeof IntegrationWorkerInspectionSchema>;
export type IntegrationWorkerDisposition = v.InferOutput<typeof IntegrationWorkerDispositionSchema>;

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

/** Trusted evaluation over Git-computed state after exactly one integration-worker call. */
export function evaluateIntegrationWorker(
	inputInitialData: IntegrationWorkerInitialData,
	inputResult: IntegrationWorkerResult,
	inputInspection: IntegrationWorkerInspection,
): IntegrationWorkerDisposition {
	const initialData = v.parse(IntegrationWorkerInitialDataSchema, inputInitialData);
	const result = v.parse(IntegrationWorkerResultSchema, inputResult);
	const inspection = v.parse(IntegrationWorkerInspectionSchema, inputInspection);
	const violations: IntegrationWorkerDisposition['violations'] = [];

	if (result.disposition === 'blocked') violations.push('worker_blocked');
	if (inspection.headCommit !== initialData.baseCommit) violations.push('head_moved');
	if (inspection.stagedPatchSha256 !== initialData.assemblyPatchSha256) violations.push('index_changed');
	if (!authorizeTaskPatch(initialData.plan, initialData.taskId, inspection.workerChangedPaths).authorized) violations.push('scope_violation');
	if (!samePaths(result.changedPaths, inspection.workerChangedPaths)) violations.push('reported_paths_mismatch');
	if (
		(result.disposition === 'changed' && inspection.workerChangedPaths.length === 0)
		|| (result.disposition === 'no_change' && inspection.workerChangedPaths.length > 0)
	) violations.push('disposition_mismatch');
	if (
		(result.disposition === 'changed' && inspection.finalPatchSha256 === initialData.assemblyPatchSha256)
		|| (result.disposition === 'no_change' && inspection.finalPatchSha256 !== initialData.assemblyPatchSha256)
	) violations.push('final_patch_mismatch');

	return v.parse(IntegrationWorkerDispositionSchema, {
		integrationAttemptId: initialData.integrationAttemptId,
		taskId: initialData.taskId,
		status: violations.length === 0 ? 'succeeded' : 'blocked',
		workerCallCount: 1,
		workerChangedPaths: inspection.workerChangedPaths,
		finalPatchSha256: inspection.finalPatchSha256,
		violations,
		furtherWorkerAuthorized: false,
	});
}
