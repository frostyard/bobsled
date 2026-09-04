import * as v from 'valibot';
import {
	RepositoryContractSchema,
	RepositoryPolicySnapshotSchema,
	RepositoryIdSchema,
	TriageDecisionSchema,
	WorkItemSchema,
} from './contracts.ts';
import { OperatorReviewViewSchema } from './operator-review-view.ts';

export const RunStatusSchema = v.picklist(['pending', 'active', 'blocked', 'succeeded', 'failed', 'cancelled']);
export const JobStatusSchema = v.picklist(['admitted', 'queued', 'running', 'blocked', 'succeeded', 'failed', 'cancelled']);

export const AdmitRunRequestSchema = v.object({
	repositoryId: RepositoryIdSchema,
	workItem: WorkItemSchema,
	triageDecision: v.optional(TriageDecisionSchema),
	supersedesRunId: v.optional(v.pipe(v.string(), v.uuid())),
});

export const HumanOverrideRequestSchema = v.object({
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const CancelRunRequestSchema = v.object({
	reason: v.pipe(v.string(), v.minLength(3), v.maxLength(2_000)),
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const ArchiveRunRequestSchema = v.object({
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const RestoreRunRequestSchema = v.object({
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const RunArchiveRecordSchema = v.object({
	actorId: v.pipe(v.string(), v.minLength(1)),
	reason: v.pipe(v.string(), v.minLength(1)),
	archivedAt: v.string(),
});

export const AuditEventSchema = v.object({
	sequence: v.pipe(v.number(), v.integer()),
	id: v.pipe(v.string(), v.uuid()),
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.optional(v.pipe(v.string(), v.uuid())),
	actorId: v.pipe(v.string(), v.minLength(1)),
	type: v.pipe(v.string(), v.minLength(1)),
	payload: v.record(v.string(), v.unknown()),
	createdAt: v.string(),
});

export const AttemptRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	number: v.pipe(v.number(), v.integer(), v.minValue(1)),
	status: v.picklist(['queued', 'running', 'succeeded', 'blocked', 'failed', 'cancelled']),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	outcome: v.optional(v.unknown()),
});

export const ArtifactRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	attemptId: v.optional(v.pipe(v.string(), v.uuid())),
	kind: v.pipe(v.string(), v.minLength(1)),
	uri: v.pipe(v.string(), v.minLength(1)),
	digest: v.optional(v.string()),
	metadata: v.record(v.string(), v.unknown()),
	createdAt: v.string(),
});

export const ReviewRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	attemptId: v.pipe(v.string(), v.uuid()),
	number: v.pipe(v.number(), v.integer(), v.minValue(1)),
	status: v.picklist(['queued', 'running', 'approved', 'blocked', 'failed']),
	initialVerdict: v.optional(v.unknown()),
	finalVerdict: v.optional(v.unknown()),
	outcome: v.optional(v.unknown()),
	operatorView: OperatorReviewViewSchema,
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
});

export const ApprovalRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.optional(v.pipe(v.string(), v.uuid())),
	kind: v.pipe(v.string(), v.minLength(1)),
	actorId: v.pipe(v.string(), v.minLength(1)),
	reason: v.pipe(v.string(), v.minLength(1)),
	createdAt: v.string(),
});

export const JobRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	runId: v.pipe(v.string(), v.uuid()),
	repositoryId: RepositoryIdSchema,
	status: JobStatusSchema,
	policySnapshot: RepositoryPolicySnapshotSchema,
	workItemSnapshot: WorkItemSchema,
	triageDecision: v.optional(TriageDecisionSchema),
	currentAttempt: v.pipe(v.number(), v.integer(), v.minValue(0)),
	attempts: v.array(AttemptRecordSchema),
	reviews: v.array(ReviewRecordSchema),
	artifacts: v.array(ArtifactRecordSchema),
	version: v.pipe(v.number(), v.integer(), v.minValue(1)),
	createdAt: v.string(),
	updatedAt: v.string(),
});

export const RunRecordSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1)),
	status: RunStatusSchema,
	archive: v.optional(RunArchiveRecordSchema),
	supersedesRunId: v.optional(v.pipe(v.string(), v.uuid())),
	version: v.pipe(v.number(), v.integer(), v.minValue(1)),
	createdAt: v.string(),
	updatedAt: v.string(),
	jobs: v.array(JobRecordSchema),
	approvals: v.array(ApprovalRecordSchema),
	audit: v.array(AuditEventSchema),
});

export type AdmitRunRequest = v.InferOutput<typeof AdmitRunRequestSchema>;
export type HumanOverrideRequest = v.InferOutput<typeof HumanOverrideRequestSchema>;
export type CancelRunRequest = v.InferOutput<typeof CancelRunRequestSchema>;
export type ArchiveRunRequest = v.InferOutput<typeof ArchiveRunRequestSchema>;
export type RestoreRunRequest = v.InferOutput<typeof RestoreRunRequestSchema>;
export type RunArchiveRecord = v.InferOutput<typeof RunArchiveRecordSchema>;
export type RunRecord = v.InferOutput<typeof RunRecordSchema>;
export type JobRecord = v.InferOutput<typeof JobRecordSchema>;
export type AttemptRecord = v.InferOutput<typeof AttemptRecordSchema>;
export type ArtifactRecord = v.InferOutput<typeof ArtifactRecordSchema>;
export type ReviewRecord = v.InferOutput<typeof ReviewRecordSchema>;
