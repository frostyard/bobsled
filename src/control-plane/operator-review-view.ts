import * as v from 'valibot';
import { DraftPatchEvidenceSchema, RemediationOutcomeSchema, ReviewReportSchema } from './execution-contracts.ts';

const OperatorReviewReportSchema = v.object({
	verdict: ReviewReportSchema.entries.verdict,
	summary: ReviewReportSchema.entries.summary,
	findings: ReviewReportSchema.entries.findings,
	testedClaims: ReviewReportSchema.entries.testedClaims,
	residualRisks: ReviewReportSchema.entries.residualRisks,
});

export const OperatorReviewViewSchema = v.object({
	status: v.picklist(['queued', 'running', 'approved', 'blocked', 'failed']),
	primaryReport: v.optional(OperatorReviewReportSchema),
	initialReport: v.optional(OperatorReviewReportSchema),
	finalReport: v.optional(OperatorReviewReportSchema),
	remediation: v.optional(v.object({
		performed: v.literal(true), summary: v.string(), addressedFindingIds: v.array(v.string()),
		unresolvedFindingIds: v.array(v.string()), changedPaths: v.array(v.string()),
		testsRun: v.array(v.string()), notes: v.array(v.string()),
	})),
	evidence: v.optional(v.object({
		baseCommit: v.string(), headCommit: v.string(), headMoved: v.boolean(), filesChanged: v.number(),
		diffLines: v.number(), diffSha256: v.string(), changedPaths: v.array(v.string()),
		protectedPaths: v.array(v.string()), policyViolations: v.array(v.string()),
		gates: v.array(v.object({ id: v.string(), name: v.string(), status: v.string() })),
	})),
	error: v.optional(v.string()),
	nextAction: v.object({
		kind: v.picklist(['wait', 'prepare_publication', 'start_revised_run', 'inspect_failure']),
		label: v.string(), guidance: v.string(),
	}),
});

export type OperatorReviewView = v.InferOutput<typeof OperatorReviewViewSchema>;

interface ReviewProjectionInput {
	status: OperatorReviewView['status'];
	initialVerdict?: unknown;
	finalVerdict?: unknown;
	outcome?: unknown;
}

function parsed<T>(schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>, input: unknown): T | undefined {
	const result = v.safeParse(schema, input);
	return result.success ? result.output : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function projectReviewForOperator(input: ReviewProjectionInput): OperatorReviewView {
	const initialReport = parsed(ReviewReportSchema, input.initialVerdict);
	const finalReport = parsed(ReviewReportSchema, input.finalVerdict);
	const outcome = record(input.outcome);
	const evidence = parsed(DraftPatchEvidenceSchema, outcome?.evidence);
	const remediation = parsed(RemediationOutcomeSchema, outcome?.remediation);
	const error = typeof outcome?.error === 'string' ? outcome.error : typeof outcome?.reason === 'string' ? outcome.reason : undefined;
	const nextAction: OperatorReviewView['nextAction'] = input.status === 'queued' || input.status === 'running'
		? { kind: 'wait', label: 'Wait for review', guidance: 'Refresh runs after the review settles. Do not authorize another review while this one is active.' }
		: input.status === 'approved'
			? { kind: 'prepare_publication', label: 'Prepare draft PR', guidance: 'The exact reviewed patch may enter the policy-gated draft publication flow. Human review and merge remain mandatory.' }
			: input.status === 'blocked'
				? { kind: 'start_revised_run', label: 'Revise task', guidance: 'Do not re-review the unchanged attempt. Start a revised run whose task explicitly addresses the blocking findings.' }
				: { kind: 'inspect_failure', label: 'Inspect failure', guidance: 'No approval exists. Inspect the recorded error before deciding whether to start a revised run.' };
	return v.parse(OperatorReviewViewSchema, {
		status: input.status, primaryReport: finalReport ?? initialReport, initialReport, finalReport,
		remediation: remediation ? { performed: true, ...remediation.result } : undefined,
		evidence: evidence ? {
			baseCommit: evidence.baseCommit, headCommit: evidence.headCommit, headMoved: evidence.headMoved,
			filesChanged: evidence.filesChanged, diffLines: evidence.diffLines, diffSha256: evidence.diffSha256,
			changedPaths: evidence.changedPaths, protectedPaths: evidence.protectedPaths,
			policyViolations: evidence.policyViolations,
			gates: evidence.gates.map(({ id, name, status }) => ({ id, name, status })),
		} : undefined,
		error, nextAction,
	});
}
