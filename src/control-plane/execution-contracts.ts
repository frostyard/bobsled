import * as v from 'valibot';
import { RepositoryContractSchema, WorkItemSchema } from './contracts.ts';

export const ExecutionAuthorizationRequestSchema = v.object({
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export const ReviewAuthorizationRequestSchema = v.object({
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export const ImplementationTaskSchema = v.object({
	id: v.literal('implementation'),
	objective: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	expectedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(20)),
	acceptanceCriteria: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.minLength(1), v.maxLength(20)),
});

export const ImplementationPlanSchema = v.object({
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	tasks: v.pipe(v.array(ImplementationTaskSchema), v.length(1)),
	assumptions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
	risks: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
});

export const ImplementationResultSchema = v.pipe(
	v.object({
		disposition: v.picklist(['changed', 'no_change', 'blocked']),
		summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
		changedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
		testsRun: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
		notes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
	}),
	v.check((result) => result.disposition !== 'changed' || result.changedPaths.length > 0, 'Changed results must report at least one changed path'),
	v.check((result) => result.disposition !== 'no_change' || result.changedPaths.length === 0, 'No-change results cannot report changed paths'),
);

export const WorkerInitialDataSchema = v.object({
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	attemptId: v.pipe(v.string(), v.uuid()),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	sandboxHomePath: v.pipe(v.string(), v.minLength(1)),
	toolDataPath: v.pipe(v.string(), v.minLength(1)),
	executablePath: v.pipe(v.string(), v.minLength(1)),
	baseCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
	repository: RepositoryContractSchema,
	workItem: WorkItemSchema,
});

export const WorkerOutcomeSchema = v.object({
	conversationId: v.pipe(v.string(), v.minLength(1)),
	submissionId: v.pipe(v.string(), v.minLength(1)),
	plan: ImplementationPlanSchema,
	result: ImplementationResultSchema,
	text: v.string(),
});

/** New workers must emit disposition; historical stored evidence is normalized only while reading it. */
export function parseStoredWorkerOutcome(input: unknown): v.InferOutput<typeof WorkerOutcomeSchema> {
	if (typeof input === 'object' && input !== null && 'result' in input) {
		const stored = input as Record<string, unknown>;
		const result = stored.result;
		if (typeof result === 'object' && result !== null && !('disposition' in result)) {
			const historical = result as Record<string, unknown>;
			const changedPaths = Array.isArray(historical.changedPaths) ? historical.changedPaths : [];
			return v.parse(WorkerOutcomeSchema, {
				...stored,
				result: { ...historical, disposition: changedPaths.length > 0 ? 'changed' : 'blocked' },
			});
		}
	}
	return v.parse(WorkerOutcomeSchema, input);
}

export const GateResultSchema = v.object({
	id: v.pipe(v.string(), v.minLength(1)),
	name: v.pipe(v.string(), v.minLength(1)),
	command: v.pipe(v.string(), v.minLength(1)),
	status: v.picklist(['passed', 'failed', 'timed_out']),
	exitCode: v.nullable(v.pipe(v.number(), v.integer())),
	durationMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
	stdout: v.string(),
	stderr: v.string(),
	truncated: v.boolean(),
});

export const PreparationResultSchema = v.object({
	name: v.pipe(v.string(), v.minLength(1)),
	command: v.pipe(v.string(), v.minLength(1)),
	networkAccess: v.boolean(),
	status: v.picklist(['passed', 'failed', 'timed_out']),
	exitCode: v.nullable(v.pipe(v.number(), v.integer())),
	durationMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
	stdout: v.string(),
	stderr: v.string(),
	truncated: v.boolean(),
});

export const DraftPatchEvidenceSchema = v.object({
	baseCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
	headCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
	headMoved: v.boolean(),
	changedPaths: v.array(v.string()),
	filesChanged: v.pipe(v.number(), v.integer(), v.minValue(0)),
	diffLines: v.pipe(v.number(), v.integer(), v.minValue(0)),
	diffSha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
	protectedPaths: v.array(v.string()),
	policyViolations: v.array(v.string()),
	gates: v.array(GateResultSchema),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	evidencePath: v.pipe(v.string(), v.minLength(1)),
});

export const ReviewFindingSchema = v.object({
	id: v.pipe(v.string(), v.regex(/^finding-[1-9][0-9]*$/)),
	severity: v.picklist(['low', 'moderate', 'high', 'critical']),
	category: v.picklist(['correctness', 'security', 'tests', 'maintainability', 'scope', 'documentation']),
	blocking: v.boolean(),
	path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
	line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
	evidence: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
	remediation: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export const ReviewReportSchema = v.pipe(
	v.object({
		verdict: v.picklist(['approve', 'changes_requested', 'reject']),
		summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
		findings: v.pipe(v.array(ReviewFindingSchema), v.maxLength(50)),
		testedClaims: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
		residualRisks: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
	}),
	v.check((report) => report.verdict !== 'approve' || report.findings.every(({ blocking }) => !blocking), 'An approved review cannot contain blocking findings'),
	v.check((report) => report.verdict !== 'changes_requested' || report.findings.some(({ blocking }) => blocking), 'Changes requested requires at least one blocking finding'),
	v.check((report) => report.verdict !== 'reject' || report.findings.some(({ severity, blocking }) => blocking && severity === 'critical'), 'Reject requires a blocking critical finding'),
);

export const ReviewInitialDataSchema = v.object({
	reviewId: v.pipe(v.string(), v.uuid()),
	round: v.picklist(['initial', 'final']),
	repositoryContextPath: v.pipe(v.string(), v.minLength(1)),
	repository: RepositoryContractSchema,
	workItem: WorkItemSchema,
	implementationPlan: ImplementationPlanSchema,
	implementationResult: ImplementationResultSchema,
	evidence: DraftPatchEvidenceSchema,
	patch: v.pipe(v.string(), v.maxLength(2_000_000)),
});

export const ReviewOutcomeSchema = v.object({
	conversationId: v.pipe(v.string(), v.minLength(1)),
	submissionId: v.pipe(v.string(), v.minLength(1)),
	report: ReviewReportSchema,
	text: v.string(),
});

export const RemediationInitialDataSchema = v.object({
	...WorkerInitialDataSchema.entries,
	reviewId: v.pipe(v.string(), v.uuid()),
	review: ReviewReportSchema,
});

export const RemediationResultSchema = v.object({
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
	addressedFindingIds: v.pipe(v.array(v.pipe(v.string(), v.regex(/^finding-[1-9][0-9]*$/))), v.maxLength(50)),
	unresolvedFindingIds: v.pipe(v.array(v.pipe(v.string(), v.regex(/^finding-[1-9][0-9]*$/))), v.maxLength(50)),
	changedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
	testsRun: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
	notes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(50)),
});

export const RemediationOutcomeSchema = v.object({
	conversationId: v.pipe(v.string(), v.minLength(1)),
	submissionId: v.pipe(v.string(), v.minLength(1)),
	result: RemediationResultSchema,
	text: v.string(),
});

export type ExecutionAuthorizationRequest = v.InferOutput<typeof ExecutionAuthorizationRequestSchema>;
export type ImplementationPlan = v.InferOutput<typeof ImplementationPlanSchema>;
export type ImplementationResult = v.InferOutput<typeof ImplementationResultSchema>;
export type WorkerInitialData = v.InferOutput<typeof WorkerInitialDataSchema>;
export type WorkerOutcome = v.InferOutput<typeof WorkerOutcomeSchema>;
export type GateResult = v.InferOutput<typeof GateResultSchema>;
export type PreparationResult = v.InferOutput<typeof PreparationResultSchema>;
export type DraftPatchEvidence = v.InferOutput<typeof DraftPatchEvidenceSchema>;
export type ReviewAuthorizationRequest = v.InferOutput<typeof ReviewAuthorizationRequestSchema>;
export type ReviewFinding = v.InferOutput<typeof ReviewFindingSchema>;
export type ReviewReport = v.InferOutput<typeof ReviewReportSchema>;
export type ReviewInitialData = v.InferOutput<typeof ReviewInitialDataSchema>;
export type ReviewOutcome = v.InferOutput<typeof ReviewOutcomeSchema>;
export type RemediationInitialData = v.InferOutput<typeof RemediationInitialDataSchema>;
export type RemediationResult = v.InferOutput<typeof RemediationResultSchema>;
export type RemediationOutcome = v.InferOutput<typeof RemediationOutcomeSchema>;
