import * as v from 'valibot';
import { GateResultSchema, PreparationResultSchema } from './execution-contracts.ts';

const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const DigestSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const PublicationRebaseRequestSchema = v.object({
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export const PublicationRebaseBlockReasonSchema = v.picklist([
	'source_evidence_changed',
	'remote_base_unchanged',
	'local_source_stale',
	'base_not_descendant',
	'preparation_failed',
	'preparation_changed_workspace',
	'patch_conflict',
	'changed_paths_mismatch',
	'protected_path',
	'policy_limit',
	'gate_failed',
	'post_gate_changed',
	'head_moved',
	'unexpected_failure',
]);

export const PublicationRebaseRecordSchema = v.pipe(v.object({
	id: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1)),
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	repositoryId: v.pipe(v.string(), v.minLength(1)),
	status: v.picklist(['pending', 'running', 'validated', 'blocked']),
	oldBaseCommit: GitObjectIdSchema,
	newBaseCommit: v.optional(GitObjectIdSchema),
	approvedPatchSha256: DigestSchema,
	replayedPatchSha256: v.optional(DigestSchema),
	sourceChangedPaths: v.array(v.pipe(v.string(), v.minLength(1))),
	replayedChangedPaths: v.array(v.pipe(v.string(), v.minLength(1))),
	conflictPaths: v.array(v.pipe(v.string(), v.minLength(1))),
	workspacePath: v.optional(v.pipe(v.string(), v.minLength(1))),
	preparation: v.optional(PreparationResultSchema),
	gates: v.array(GateResultSchema),
	blockReason: v.optional(PublicationRebaseBlockReasonSchema),
	detail: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
	modelCalls: v.literal(0),
	reviewRequired: v.literal(true),
	reviewAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	reason: v.pipe(v.string(), v.minLength(1)),
	createdAt: v.string(),
	updatedAt: v.string(),
}),
	v.check((record) => record.status !== 'validated' || (
		record.newBaseCommit !== undefined
		&& record.replayedPatchSha256 !== undefined
		&& record.workspacePath !== undefined
		&& record.preparation?.status === 'passed'
		&& record.gates.length > 0
		&& record.gates.every(({ status }) => status === 'passed')
		&& record.conflictPaths.length === 0
		&& record.blockReason === undefined
	), 'Validated stale-base evidence must include a prepared, gated replay'),
	v.check((record) => record.status !== 'blocked' || record.blockReason !== undefined, 'Blocked stale-base evidence requires a typed reason'),
);

export type PublicationRebaseRequest = v.InferOutput<typeof PublicationRebaseRequestSchema>;
export type PublicationRebaseBlockReason = v.InferOutput<typeof PublicationRebaseBlockReasonSchema>;
export type PublicationRebaseRecord = v.InferOutput<typeof PublicationRebaseRecordSchema>;
