import * as v from 'valibot';
import { ReviewReportSchema } from './execution-contracts.ts';

const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const DigestSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const PublicationRebaseReviewRequestSchema = v.object({
	rebaseId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export const PublicationRebaseReviewBlockReasonSchema = v.picklist([
	'rebase_evidence_changed',
	'current_policy_denied',
	'workspace_changed',
	'reviewer_changes_requested',
	'reviewer_rejected',
	'reviewer_failed',
	'unexpected_failure',
]);

export const PublicationRebaseReviewRecordSchema = v.pipe(v.object({
	id: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1)),
	rebaseId: v.pipe(v.string(), v.uuid()),
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	repositoryId: v.pipe(v.string(), v.minLength(1)),
	status: v.picklist(['pending', 'preparing', 'running', 'approved', 'blocked', 'failed']),
	baseCommit: GitObjectIdSchema,
	patchSha256: DigestSchema,
	changedPaths: v.array(v.pipe(v.string(), v.minLength(1))),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	repositoryContextPath: v.optional(v.pipe(v.string(), v.minLength(1))),
	report: v.optional(ReviewReportSchema),
	conversationId: v.optional(v.pipe(v.string(), v.minLength(1))),
	submissionId: v.optional(v.pipe(v.string(), v.minLength(1))),
	modelCalls: v.picklist([0, 1]),
	blockReason: v.optional(PublicationRebaseReviewBlockReasonSchema),
	detail: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
	promotionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	reason: v.pipe(v.string(), v.minLength(1)),
	createdAt: v.string(),
	updatedAt: v.string(),
}),
	v.check((record) => record.status !== 'approved' || (
		record.modelCalls === 1
		&& record.report?.verdict === 'approve'
		&& record.repositoryContextPath !== undefined
		&& record.blockReason === undefined
	), 'Approved replay review evidence requires one approving fresh-context review'),
	v.check((record) => !['blocked', 'failed'].includes(record.status) || record.blockReason !== undefined, 'Settled replay review evidence requires a typed reason'),
);

export type PublicationRebaseReviewRecord = v.InferOutput<typeof PublicationRebaseReviewRecordSchema>;
export type PublicationRebaseReviewBlockReason = v.InferOutput<typeof PublicationRebaseReviewBlockReasonSchema>;

export const RecoveredDraftPublicationRequestSchema = v.object({
	rebaseReviewId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type RecoveredDraftPublicationRequest = v.InferOutput<typeof RecoveredDraftPublicationRequestSchema>;
