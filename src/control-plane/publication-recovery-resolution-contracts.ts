import * as v from 'valibot';

export const PublicationRecoveryResolutionRequestSchema = v.object({
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	supersedingPublicationId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export const PublicationRecoveryResolutionRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1)),
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	supersedingPublicationId: v.pipe(v.string(), v.uuid()),
	repositoryId: v.pipe(v.string(), v.minLength(1)),
	disposition: v.literal('superseded_by_merged_publication'),
	modelCalls: v.literal(0),
	githubMutations: v.literal(0),
	reason: v.pipe(v.string(), v.minLength(1)),
	createdAt: v.string(),
});

export type PublicationRecoveryResolutionRecord = v.InferOutput<typeof PublicationRecoveryResolutionRecordSchema>;
