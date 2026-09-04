import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import { DraftPatchEvidenceSchema } from './execution-contracts.ts';
import type { Principal } from './ledger.ts';
import { RepositoryCompatibilityContractSchema } from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryChangeSetScheduleStore, type MultiRepositoryChangeSetSchedule } from './multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from './multi-repository-change-set-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryVerificationMemberSchema = v.object({
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	attemptId: v.pipe(v.string(), v.uuid()),
	filesChanged: v.pipe(v.number(), v.integer(), v.minValue(0)),
	patchSha256: Sha256Schema,
	reviewStatus: v.picklist(['approved', 'not_required']),
});

export const MultiRepositoryCompatibilityCheckSchema = v.object({
	repositoryId: RepositoryIdSchema,
	dependencyRepositoryId: RepositoryIdSchema,
	contract: RepositoryCompatibilityContractSchema,
	repositoryPatchSha256: Sha256Schema,
	dependencyPatchSha256: Sha256Schema,
});

export const MultiRepositoryVerificationPlanResultSchema = v.object({
	version: v.literal(1),
	members: v.pipe(v.array(MultiRepositoryVerificationMemberSchema), v.minLength(2), v.maxLength(16)),
	compatibilityChecks: v.pipe(v.array(MultiRepositoryCompatibilityCheckSchema), v.maxLength(120)),
	rolloutLayers: v.pipe(v.array(v.pipe(v.array(RepositoryIdSchema), v.minLength(1))), v.minLength(1)),
	rollbackLayers: v.pipe(v.array(v.pipe(v.array(RepositoryIdSchema), v.minLength(1))), v.minLength(1)),
	status: v.literal('ready_for_verification'),
	verificationExecutionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
});

export const MultiRepositoryVerificationPlanSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	scheduleId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.literal('ready_for_verification'),
	memberEvidenceSha256: Sha256Schema,
	resultSha256: Sha256Schema,
	result: MultiRepositoryVerificationPlanResultSchema,
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	createdAt: v.string(),
});

const AdmitSchema = v.object({
	scheduleId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export type MultiRepositoryVerificationPlan = v.InferOutput<typeof MultiRepositoryVerificationPlanSchema>;
export class MultiRepositoryVerificationPlanConflictError extends Error {}
export class MultiRepositoryVerificationPlanForbiddenError extends Error {}
export class MultiRepositoryVerificationPlanNotFoundError extends Error {}

interface PlanRow {
	id: string; schedule_id: string; change_set_id: string; owner_id: string; idempotency_key: string;
	request_sha256: string; member_evidence_sha256: string; result_sha256: string; result_json: string;
	reason: string; status: string; created_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export class MultiRepositoryVerificationPlanStore {
	readonly #db: Database.Database;
	readonly #schedules: MultiRepositoryChangeSetScheduleStore;
	readonly #parents: MultiRepositoryChangeSetStore;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date(), repositories: readonly RepositoryContract[] = enrolledRepositories) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#schedules = new MultiRepositoryChangeSetScheduleStore(path, now, repositories);
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#schedules.close(); this.#db.close(); }

	admit(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryVerificationPlan {
		const request = v.parse(AdmitSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryVerificationPlanConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryVerificationPlanConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}
		return this.#db.transaction(() => {
			const concurrent = this.#findReplay(principal.id, idempotencyKey);
			if (concurrent) {
				if (concurrent.request_sha256 !== requestSha256) throw new MultiRepositoryVerificationPlanConflictError('Idempotency key was already used for different input');
				return this.get(concurrent.id, principal);
			}
			const schedule = this.#schedules.get(request.scheduleId, principal);
			const parent = this.#parents.get(schedule.changeSetId, principal);
			const { members, memberEvidenceSha256, result } = this.#buildResult(schedule, parent.plan, principal);
			if (this.#db.prepare('SELECT id FROM multi_repository_verification_plans WHERE schedule_id = ?').get(schedule.id)) {
				throw new MultiRepositoryVerificationPlanConflictError('This schedule already has an immutable verification plan');
			}
			const id = randomUUID(); const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_verification_plans
				(id, schedule_id, change_set_id, owner_id, idempotency_key, request_sha256, member_evidence_sha256,
				result_sha256, result_json, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready_for_verification', ?)`).run(
				id, schedule.id, schedule.changeSetId, principal.id, idempotencyKey, requestSha256, memberEvidenceSha256,
				digest(result), JSON.stringify(result), request.reason, createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryVerificationPlan {
		const row = this.#db.prepare('SELECT * FROM multi_repository_verification_plans WHERE id = ?').get(id) as PlanRow | undefined;
		if (!row) throw new MultiRepositoryVerificationPlanNotFoundError('Verification plan was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryVerificationPlanForbiddenError('Verification plan belongs to another principal');
		const schedule = this.#schedules.get(row.schedule_id, principal);
		const parent = this.#parents.get(row.change_set_id, principal);
		let result: v.InferOutput<typeof MultiRepositoryVerificationPlanResultSchema>;
		try {
			result = v.parse(MultiRepositoryVerificationPlanResultSchema, JSON.parse(row.result_json));
		} catch {
			throw new MultiRepositoryVerificationPlanConflictError('Stored verification plan result is malformed');
		}
		const expected = this.#buildResult(schedule, parent.plan, principal);
		if (row.status !== 'ready_for_verification' || row.change_set_id !== schedule.changeSetId || parent.id !== row.change_set_id
			|| digest({ scheduleId: row.schedule_id, reason: row.reason }) !== row.request_sha256
			|| expected.memberEvidenceSha256 !== row.member_evidence_sha256 || digest(result) !== row.result_sha256
			|| JSON.stringify(canonical(result)) !== JSON.stringify(canonical(expected.result))) {
			throw new MultiRepositoryVerificationPlanConflictError('Stored verification plan failed schedule, member, or result integrity verification');
		}
		return v.parse(MultiRepositoryVerificationPlanSchema, {
			id: row.id, scheduleId: row.schedule_id, changeSetId: row.change_set_id, ownerId: row.owner_id,
			status: row.status, memberEvidenceSha256: row.member_evidence_sha256, resultSha256: row.result_sha256,
			result, reason: row.reason, createdAt: row.created_at,
		});
	}

	#buildResult(schedule: MultiRepositoryChangeSetSchedule, plan: ReturnType<MultiRepositoryChangeSetStore['get']>['plan'], principal: Principal) {
		const members = schedule.members.map((member) => this.#completedMember(member, principal));
		const memberEvidenceSha256 = digest(members);
		const byRepository = new Map(members.map((member) => [member.repositoryId, member]));
		const compatibilityChecks = plan.repositories.flatMap((unit) => unit.compatibilityContracts.map((contract) => {
			const repository = byRepository.get(unit.repositoryId);
			const dependency = byRepository.get(contract.dependencyRepositoryId);
			if (!repository || !dependency) throw new MultiRepositoryVerificationPlanConflictError('Compatibility contract references a missing completed member');
			return {
				repositoryId: unit.repositoryId, dependencyRepositoryId: contract.dependencyRepositoryId, contract,
				repositoryPatchSha256: repository.patchSha256, dependencyPatchSha256: dependency.patchSha256,
			};
		}));
		const result = v.parse(MultiRepositoryVerificationPlanResultSchema, {
			version: 1, members, compatibilityChecks, rolloutLayers: schedule.dependencyLayers,
			rollbackLayers: [...schedule.dependencyLayers].reverse().map((layer) => [...layer].reverse()),
			status: 'ready_for_verification', verificationExecutionAuthorized: false,
			publicationAuthorized: false, mergeAuthorized: false,
		});
		return { members, memberEvidenceSha256, result };
	}

	#completedMember(member: ReturnType<MultiRepositoryChangeSetScheduleStore['get']>['members'][number], principal: Principal) {
		const state = this.#db.prepare(`SELECT r.owner_id, r.status AS run_status, j.status AS job_status, j.current_attempt,
			a.id AS attempt_id, a.status AS attempt_status, a.outcome_json,
			(SELECT COUNT(*) FROM reviews rv WHERE rv.job_id=j.id AND rv.attempt_id=a.id AND rv.status='approved') AS approved_reviews,
			(SELECT digest FROM artifacts ar WHERE ar.job_id=j.id AND ar.attempt_id=a.id AND ar.kind='review_draft_patch' ORDER BY ar.created_at DESC LIMIT 1) AS review_digest,
			(SELECT digest FROM artifacts ar WHERE ar.job_id=j.id AND ar.attempt_id=a.id AND ar.kind='draft_patch' ORDER BY ar.created_at DESC LIMIT 1) AS draft_digest
			FROM runs r JOIN jobs j ON j.run_id=r.id
			JOIN attempts a ON a.job_id=j.id AND a.number=j.current_attempt
			WHERE r.id=? AND j.id=?`).get(member.runId, member.jobId) as {
			owner_id: string; run_status: string; job_status: string; current_attempt: number;
			attempt_id: string; attempt_status: string; outcome_json: string | null; approved_reviews: number;
			review_digest: string | null; draft_digest: string | null;
		} | undefined;
		if (!state || state.owner_id !== principal.id || state.run_status !== 'succeeded' || state.job_status !== 'succeeded'
			|| state.current_attempt < 1 || state.attempt_status !== 'succeeded' || !state.outcome_json) {
			throw new MultiRepositoryVerificationPlanConflictError(`Repository member has not completed trusted implementation: ${member.repositoryId}`);
		}
		const evidence = v.parse(DraftPatchEvidenceSchema, (JSON.parse(state.outcome_json) as { evidence?: unknown }).evidence);
		const reviewRequired = member.policySnapshot.reviewPolicy.enabled && evidence.filesChanged > 0;
		if (reviewRequired && state.approved_reviews !== 1) {
			throw new MultiRepositoryVerificationPlanConflictError(`Repository member lacks its required approved review: ${member.repositoryId}`);
		}
		const patchSha256 = reviewRequired ? state.review_digest : state.draft_digest;
		if (!patchSha256 || !v.safeParse(Sha256Schema, patchSha256).success) {
			throw new MultiRepositoryVerificationPlanConflictError(`Repository member lacks trusted patch evidence: ${member.repositoryId}`);
		}
		return v.parse(MultiRepositoryVerificationMemberSchema, {
			repositoryId: member.repositoryId, runId: member.runId, jobId: member.jobId,
			attemptId: state.attempt_id, filesChanged: evidence.filesChanged, patchSha256,
			reviewStatus: reviewRequired ? 'approved' : 'not_required',
		});
	}

	#findReplay(ownerId: string, idempotencyKey: string): PlanRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_verification_plans WHERE owner_id=? AND idempotency_key=?')
			.get(ownerId, idempotencyKey) as PlanRow | undefined;
	}
}
