import * as v from 'valibot';

export const DraftPublicationRequestSchema = v.object({
	runId: v.pipe(v.string(), v.uuid()),
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export const PublicationCheckSchema = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['queued', 'in_progress', 'completed']),
	conclusion: v.optional(v.nullable(v.string())),
	detailsUrl: v.optional(v.string()),
});

export const DraftPublicationRecordSchema = v.pipe(v.object({
	id: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1)),
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	attemptId: v.pipe(v.string(), v.uuid()),
	reviewId: v.pipe(v.string(), v.uuid()),
	repositoryId: v.pipe(v.string(), v.minLength(1)),
	status: v.picklist(['blocked', 'pending', 'running', 'published', 'checks_pending', 'checks_failed', 'ready_for_human', 'merged', 'closed', 'failed']),
	baseCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
	approvedPatchSha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
	branchName: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
	body: v.pipe(v.string(), v.minLength(1), v.maxLength(50_000)),
	marker: v.pipe(v.string(), v.minLength(1)),
	requiredCheckNames: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
	reason: v.pipe(v.string(), v.minLength(1)),
	blockedReason: v.optional(v.string()),
	attemptCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
	commitSha: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))),
	pullNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	pullUrl: v.optional(v.string()),
	pullState: v.optional(v.picklist(['open', 'closed'])),
	pullDraft: v.optional(v.boolean()),
	pullMergedAt: v.optional(v.string()),
	pullClosedAt: v.optional(v.string()),
	checks: v.array(PublicationCheckSchema),
	error: v.optional(v.string()),
	createdAt: v.string(),
	updatedAt: v.string(),
}),
	v.check((record) => record.status !== 'merged' || (record.pullState === 'closed' && record.pullMergedAt !== undefined && record.pullDraft === false), 'Merged publication evidence must describe a non-draft closed pull request'),
	v.check((record) => record.status !== 'closed' || (record.pullState === 'closed' && record.pullMergedAt === undefined && record.pullClosedAt !== undefined), 'Closed publication evidence must describe an unmerged closed pull request'),
);

export type DraftPublicationRequest = v.InferOutput<typeof DraftPublicationRequestSchema>;
export type DraftPublicationRecord = v.InferOutput<typeof DraftPublicationRecordSchema>;
export type PublicationCheck = v.InferOutput<typeof PublicationCheckSchema>;
