import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { DraftPatchEvidenceSchema } from './execution-contracts.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { projectMultiRepositoryChangeSetReadiness } from './multi-repository-change-set-contracts.ts';
import { MultiRepositoryChangeSetScheduleStore } from './multi-repository-change-set-schedule-store.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryChangeSetStore } from './multi-repository-change-set-store.ts';
import { MultiRepositoryCompatibilityExecutionStore } from './multi-repository-compatibility-execution-store.ts';
import { MultiRepositoryVerificationPlanStore } from './multi-repository-verification-plan-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryPublicationPolicySnapshotSchema = v.object({
	repositoryId: RepositoryIdSchema,
	githubRepositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	defaultBranch: v.pipe(v.string(), v.minLength(1)),
	readOnly: v.literal(false),
	writeCode: v.literal(true),
	writeGitHub: v.literal(true),
	merge: v.literal(false),
	publicationPolicy: v.object({
		enabled: v.literal(true),
		branchPrefix: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._-]+\/$/)),
		draftPullRequestsOnly: v.literal(true),
		allowForcePush: v.literal(false),
		requiredCheckNames: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), v.minLength(1), v.maxLength(50)),
		maxAttempts: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
		maxTotalBlobBytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100 * 1024 * 1024)),
	}),
});

export const MultiRepositoryPublicationMemberSchema = v.object({
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	attemptId: v.pipe(v.string(), v.uuid()),
	reviewId: v.pipe(v.string(), v.uuid()),
	baseCommit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	filesChanged: v.pipe(v.number(), v.integer(), v.minValue(1)),
	patchSha256: Sha256Schema,
	rolloutLayer: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15)),
	rollbackLayer: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15)),
	policySnapshotSha256: Sha256Schema,
	policySnapshot: MultiRepositoryPublicationPolicySnapshotSchema,
});

export const MultiRepositoryPublicationAuthorizationSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	compatibilityExecutionId: v.pipe(v.string(), v.uuid()),
	verificationPlanId: v.pipe(v.string(), v.uuid()),
	scheduleId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.literal('ready_for_linked_publication'),
	compatibilityResultSha256: Sha256Schema,
	memberSetSha256: Sha256Schema,
	members: v.pipe(v.array(MultiRepositoryPublicationMemberSchema), v.minLength(2), v.maxLength(16)),
	rolloutLayers: v.pipe(v.array(v.pipe(v.array(RepositoryIdSchema), v.minLength(1))), v.minLength(1), v.maxLength(16)),
	rollbackLayers: v.pipe(v.array(v.pipe(v.array(RepositoryIdSchema), v.minLength(1))), v.minLength(1), v.maxLength(16)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	publicationBarrierSatisfied: v.literal(true),
	draftPublicationExecutionAuthorized: v.literal(false),
	githubMutationAuthorized: v.literal(false),
	rolloutAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
	createdAt: v.string(),
});

const AuthorizeSchema = v.object({
	compatibilityExecutionId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export type MultiRepositoryPublicationAuthorization = v.InferOutput<typeof MultiRepositoryPublicationAuthorizationSchema>;
export class MultiRepositoryPublicationAuthorizationConflictError extends Error {}
export class MultiRepositoryPublicationAuthorizationForbiddenError extends Error {}
export class MultiRepositoryPublicationAuthorizationNotFoundError extends Error {}
export class MultiRepositoryPublicationAuthorizationPolicyError extends Error {}

interface AuthorizationRow {
	id: string; compatibility_execution_id: string; verification_plan_id: string; schedule_id: string;
	change_set_id: string; owner_id: string; idempotency_key: string; request_sha256: string;
	compatibility_result_sha256: string; member_set_sha256: string; members_json: string;
	rollout_layers_json: string; rollback_layers_json: string; reason: string; status: string; created_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export class MultiRepositoryPublicationAuthorizationStore {
	readonly #db: Database.Database;
	readonly #executions: MultiRepositoryCompatibilityExecutionStore;
	readonly #verificationPlans: MultiRepositoryVerificationPlanStore;
	readonly #schedules: MultiRepositoryChangeSetScheduleStore;
	readonly #parents: MultiRepositoryChangeSetStore;
	readonly #repositories: readonly RepositoryContract[];
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date(), repositories: readonly RepositoryContract[] = enrolledRepositories) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#executions = new MultiRepositoryCompatibilityExecutionStore(path, now, repositories);
		this.#verificationPlans = new MultiRepositoryVerificationPlanStore(path, now, repositories);
		this.#schedules = new MultiRepositoryChangeSetScheduleStore(path, now, repositories);
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#schedules.close(); this.#verificationPlans.close(); this.#executions.close(); this.#db.close(); }

	authorize(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryPublicationAuthorization {
		const request = v.parse(AuthorizeSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryPublicationAuthorizationConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryPublicationAuthorizationConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}
		const execution = this.#executions.get(request.compatibilityExecutionId, principal);
		if (execution.status !== 'succeeded' || execution.result?.status !== 'succeeded' || execution.result.violations.length !== 0) {
			throw new MultiRepositoryPublicationAuthorizationConflictError('Linked publication requires successful compatibility execution');
		}
		const verificationPlan = this.#verificationPlans.get(execution.verificationPlanId, principal);
		const schedule = this.#schedules.get(execution.scheduleId, principal);
		const parent = this.#parents.get(execution.changeSetId, principal);
		if (verificationPlan.scheduleId !== schedule.id || schedule.changeSetId !== parent.id) {
			throw new MultiRepositoryPublicationAuthorizationConflictError('Compatibility lineage does not resolve to one coordinated change set');
		}
		return this.#db.transaction(() => {
			const concurrent = this.#findReplay(principal.id, idempotencyKey);
			if (concurrent) {
				if (concurrent.request_sha256 !== requestSha256) throw new MultiRepositoryPublicationAuthorizationConflictError('Idempotency key was already used for different input');
				return this.get(concurrent.id, principal);
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_publication_authorizations WHERE compatibility_execution_id=?').get(execution.id)) {
				throw new MultiRepositoryPublicationAuthorizationConflictError('This compatibility execution already has an immutable linked-publication authorization');
			}
			this.#assertCurrentPolicy(parent.plan);
			const members = this.#buildMembers(execution, verificationPlan, schedule, new Map(this.#repositories.map((repository) => [repository.id, repository])), true);
			const compatibilityResultSha256 = digest(execution.result);
			const memberSetSha256 = digest(members);
			const id = randomUUID(); const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_publication_authorizations
				(id, compatibility_execution_id, verification_plan_id, schedule_id, change_set_id, owner_id,
				idempotency_key, request_sha256, compatibility_result_sha256, member_set_sha256, members_json,
				rollout_layers_json, rollback_layers_json, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready_for_linked_publication', ?)`).run(
				id, execution.id, verificationPlan.id, schedule.id, parent.id, principal.id, idempotencyKey,
				requestSha256, compatibilityResultSha256, memberSetSha256, JSON.stringify(members),
				JSON.stringify(verificationPlan.result.rolloutLayers), JSON.stringify(verificationPlan.result.rollbackLayers), request.reason, createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryPublicationAuthorization {
		const row = this.#db.prepare('SELECT * FROM multi_repository_publication_authorizations WHERE id=?').get(id) as AuthorizationRow | undefined;
		if (!row) throw new MultiRepositoryPublicationAuthorizationNotFoundError('Linked-publication authorization was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryPublicationAuthorizationForbiddenError('Linked-publication authorization belongs to another principal');
		const execution = this.#executions.get(row.compatibility_execution_id, principal);
		const verificationPlan = this.#verificationPlans.get(row.verification_plan_id, principal);
		const schedule = this.#schedules.get(row.schedule_id, principal);
		let members: v.InferOutput<typeof MultiRepositoryPublicationMemberSchema>[];
		let rolloutLayers: string[][]; let rollbackLayers: string[][];
		try {
			members = v.parse(v.array(MultiRepositoryPublicationMemberSchema), JSON.parse(row.members_json));
			rolloutLayers = v.parse(v.array(v.array(RepositoryIdSchema)), JSON.parse(row.rollout_layers_json));
			rollbackLayers = v.parse(v.array(v.array(RepositoryIdSchema)), JSON.parse(row.rollback_layers_json));
		} catch { throw new MultiRepositoryPublicationAuthorizationConflictError('Stored linked-publication evidence is malformed'); }
		const storedPolicies = new Map(members.map((member) => [member.repositoryId, member.policySnapshot]));
		const expectedMembers = this.#buildMembers(execution, verificationPlan, schedule, storedPolicies, false);
		if (row.status !== 'ready_for_linked_publication' || execution.status !== 'succeeded' || execution.result?.status !== 'succeeded'
			|| row.verification_plan_id !== execution.verificationPlanId || row.schedule_id !== execution.scheduleId
			|| row.change_set_id !== execution.changeSetId || digest(execution.result) !== row.compatibility_result_sha256
			|| digest({ compatibilityExecutionId: row.compatibility_execution_id, reason: row.reason }) !== row.request_sha256
			|| digest(members) !== row.member_set_sha256
			|| JSON.stringify(canonical(members)) !== JSON.stringify(canonical(expectedMembers))
			|| JSON.stringify(rolloutLayers) !== JSON.stringify(verificationPlan.result.rolloutLayers)
			|| JSON.stringify(rollbackLayers) !== JSON.stringify(verificationPlan.result.rollbackLayers)) {
			throw new MultiRepositoryPublicationAuthorizationConflictError('Stored linked-publication authorization failed parent, member, policy, or rollout integrity verification');
		}
		return v.parse(MultiRepositoryPublicationAuthorizationSchema, {
			id: row.id, compatibilityExecutionId: row.compatibility_execution_id, verificationPlanId: row.verification_plan_id,
			scheduleId: row.schedule_id, changeSetId: row.change_set_id, ownerId: row.owner_id, status: row.status,
			compatibilityResultSha256: row.compatibility_result_sha256, memberSetSha256: row.member_set_sha256,
			members, rolloutLayers, rollbackLayers, reason: row.reason, createdAt: row.created_at,
			publicationBarrierSatisfied: true, draftPublicationExecutionAuthorized: false,
			githubMutationAuthorized: false, rolloutAuthorized: false, mergeAuthorized: false,
		});
	}

	#assertCurrentPolicy(plan: ReturnType<MultiRepositoryChangeSetStore['get']>['plan']): void {
		const readiness = projectMultiRepositoryChangeSetReadiness(plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositoryPublicationAuthorizationPolicyError('Current enrollment no longer mutually authorizes every participant');
	}

	#buildMembers(
		execution: ReturnType<MultiRepositoryCompatibilityExecutionStore['get']>,
		verificationPlan: ReturnType<MultiRepositoryVerificationPlanStore['get']>,
		schedule: ReturnType<MultiRepositoryChangeSetScheduleStore['get']>,
		policies: Map<string, RepositoryContract | v.InferOutput<typeof MultiRepositoryPublicationPolicySnapshotSchema>>,
		checkCurrentPolicy: boolean,
	) {
		if (!execution.manifest || execution.result?.status !== 'succeeded' || execution.result.violations.length !== 0) {
			throw new MultiRepositoryPublicationAuthorizationConflictError('Compatibility execution lacks successful manifest-bound evidence');
		}
		const manifest = new Map(execution.manifest.members.map((member) => [member.repositoryId, member]));
		const verified = new Map(verificationPlan.result.members.map((member) => [member.repositoryId, member]));
		const rollbackIndex = new Map(verificationPlan.result.rollbackLayers.flatMap((layer, index) => layer.map((repositoryId) => [repositoryId, index] as const)));
		return schedule.members.map((scheduled) => {
			const member = verified.get(scheduled.repositoryId); const compatible = manifest.get(scheduled.repositoryId);
			if (!member || !compatible || member.runId !== scheduled.runId || member.jobId !== scheduled.jobId || member.patchSha256 !== compatible.patchSha256) {
				throw new MultiRepositoryPublicationAuthorizationConflictError(`Publication member does not match compatibility lineage: ${scheduled.repositoryId}`);
			}
			if (member.filesChanged < 1 || member.reviewStatus !== 'approved') {
				throw new MultiRepositoryPublicationAuthorizationConflictError(`Publication member is not an approved non-empty patch: ${scheduled.repositoryId}`);
			}
			const source = policies.get(scheduled.repositoryId);
			if (!source) throw new MultiRepositoryPublicationAuthorizationPolicyError(`Repository publication policy is unavailable: ${scheduled.repositoryId}`);
			const policySnapshot = 'id' in source ? {
				repositoryId: source.id, githubRepositoryId: source.githubRepositoryId, defaultBranch: source.defaultBranch,
				readOnly: source.readOnly, writeCode: source.capabilities.writeCode, writeGitHub: source.capabilities.writeGitHub,
				merge: source.capabilities.merge, publicationPolicy: source.publicationPolicy,
			} : source;
			const parsedPolicy = v.safeParse(MultiRepositoryPublicationPolicySnapshotSchema, policySnapshot);
			if (!parsedPolicy.success) {
				const ErrorType = checkCurrentPolicy ? MultiRepositoryPublicationAuthorizationPolicyError : MultiRepositoryPublicationAuthorizationConflictError;
				throw new ErrorType(`Repository does not permit bounded draft publication: ${scheduled.repositoryId}`);
			}
			const reviews = this.#db.prepare("SELECT id, outcome_json FROM reviews WHERE job_id=? AND attempt_id=? AND status='approved' ORDER BY number").all(member.jobId, member.attemptId) as Array<{ id: string; outcome_json: string | null }>;
			if (reviews.length !== 1 || !reviews[0]?.outcome_json) throw new MultiRepositoryPublicationAuthorizationConflictError(`Publication member lacks exactly one approved review result: ${scheduled.repositoryId}`);
			let evidence: v.InferOutput<typeof DraftPatchEvidenceSchema>;
			try { evidence = v.parse(DraftPatchEvidenceSchema, (JSON.parse(reviews[0].outcome_json) as { evidence?: unknown }).evidence); }
			catch { throw new MultiRepositoryPublicationAuthorizationConflictError(`Approved review evidence is malformed: ${scheduled.repositoryId}`); }
			const artifacts = this.#db.prepare("SELECT digest, metadata_json FROM artifacts WHERE job_id=? AND attempt_id=? AND kind='review_draft_patch'").all(member.jobId, member.attemptId) as Array<{ digest: string | null; metadata_json: string }>;
			const artifact = artifacts.find((candidate) => {
				try { return (JSON.parse(candidate.metadata_json) as { reviewId?: unknown }).reviewId === reviews[0]!.id; } catch { return false; }
			});
			if (!artifact?.digest || artifact.digest !== member.patchSha256 || evidence.diffSha256 !== member.patchSha256
				|| evidence.baseCommit !== compatible.baseCommit || evidence.workspacePath !== compatible.workspacePath) {
				throw new MultiRepositoryPublicationAuthorizationConflictError(`Approved publication evidence does not match the compatibility result: ${scheduled.repositoryId}`);
			}
			const rollbackLayer = rollbackIndex.get(scheduled.repositoryId);
			if (rollbackLayer === undefined) throw new MultiRepositoryPublicationAuthorizationConflictError(`Publication member is absent from rollback order: ${scheduled.repositoryId}`);
			return v.parse(MultiRepositoryPublicationMemberSchema, {
				repositoryId: scheduled.repositoryId, runId: member.runId, jobId: member.jobId, attemptId: member.attemptId,
				reviewId: reviews[0].id, baseCommit: compatible.baseCommit, workspacePath: compatible.workspacePath,
				filesChanged: member.filesChanged, patchSha256: member.patchSha256, rolloutLayer: scheduled.layerIndex,
				rollbackLayer, policySnapshotSha256: digest(parsedPolicy.output), policySnapshot: parsedPolicy.output,
			});
		});
	}

	#findReplay(ownerId: string, idempotencyKey: string): AuthorizationRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_publication_authorizations WHERE owner_id=? AND idempotency_key=?').get(ownerId, idempotencyKey) as AuthorizationRow | undefined;
	}
}
