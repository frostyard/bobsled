import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { CompatibilityGateSchema, RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { projectMultiRepositoryChangeSetReadiness, RepositoryCompatibilityContractSchema } from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryChangeSetScheduleStore, type MultiRepositoryChangeSetSchedule } from './multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from './multi-repository-change-set-store.ts';
import { MultiRepositoryVerificationPlanStore, type MultiRepositoryVerificationPlan } from './multi-repository-verification-plan-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryAuthorizedCompatibilityGateSchema = v.object({
	repositoryId: RepositoryIdSchema,
	dependencyRepositoryId: RepositoryIdSchema,
	contract: RepositoryCompatibilityContractSchema,
	repositoryPatchSha256: Sha256Schema,
	dependencyPatchSha256: Sha256Schema,
	gate: CompatibilityGateSchema,
});

export const MultiRepositoryVerificationAuthorizationSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	verificationPlanId: v.pipe(v.string(), v.uuid()),
	scheduleId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.literal('authorized'),
	verificationPlanSha256: Sha256Schema,
	gateSetSha256: Sha256Schema,
	gates: v.pipe(v.array(MultiRepositoryAuthorizedCompatibilityGateSchema), v.minLength(1), v.maxLength(120)),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	compatibilityExecutionAuthorized: v.literal(true),
	workspaceMutationAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	rolloutAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
	createdAt: v.string(),
});

const AuthorizeSchema = v.object({
	verificationPlanId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryVerificationAuthorization = v.InferOutput<typeof MultiRepositoryVerificationAuthorizationSchema>;
export class MultiRepositoryVerificationAuthorizationConflictError extends Error {}
export class MultiRepositoryVerificationAuthorizationForbiddenError extends Error {}
export class MultiRepositoryVerificationAuthorizationNotFoundError extends Error {}
export class MultiRepositoryVerificationAuthorizationPolicyError extends Error {}

interface AuthorizationRow {
	id: string; verification_plan_id: string; schedule_id: string; change_set_id: string; owner_id: string;
	idempotency_key: string; request_sha256: string; verification_plan_sha256: string;
	gate_set_sha256: string; gates_json: string; reason: string; status: string; created_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export class MultiRepositoryVerificationAuthorizationStore {
	readonly #db: Database.Database;
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
		this.#verificationPlans = new MultiRepositoryVerificationPlanStore(path, now, repositories);
		this.#schedules = new MultiRepositoryChangeSetScheduleStore(path, now, repositories);
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#schedules.close(); this.#verificationPlans.close(); this.#db.close(); }

	authorize(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryVerificationAuthorization {
		const request = v.parse(AuthorizeSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryVerificationAuthorizationConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryVerificationAuthorizationConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		return this.#db.transaction(() => {
			const concurrent = this.#findReplay(principal.id, idempotencyKey);
			if (concurrent) {
				if (concurrent.request_sha256 !== requestSha256) throw new MultiRepositoryVerificationAuthorizationConflictError('Idempotency key was already used for different input');
				return this.get(concurrent.id, principal);
			}
			const verificationPlan = this.#verificationPlans.get(request.verificationPlanId, principal);
			const schedule = this.#schedules.get(verificationPlan.scheduleId, principal);
			const parent = this.#parents.get(verificationPlan.changeSetId, principal);
			this.#assertCurrentPolicy(schedule, parent.plan);
			const gates = this.#authorizedGates(verificationPlan, schedule);
			if (this.#db.prepare('SELECT id FROM multi_repository_verification_authorizations WHERE verification_plan_id=?').get(verificationPlan.id)) {
				throw new MultiRepositoryVerificationAuthorizationConflictError('This verification plan already has an immutable execution authorization');
			}
			const id = randomUUID(); const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_verification_authorizations
				(id, verification_plan_id, schedule_id, change_set_id, owner_id, idempotency_key, request_sha256,
				verification_plan_sha256, gate_set_sha256, gates_json, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`).run(
				id, verificationPlan.id, schedule.id, parent.id, principal.id, idempotencyKey, requestSha256,
				verificationPlan.resultSha256, digest(gates), JSON.stringify(gates), request.reason, createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryVerificationAuthorization {
		const row = this.#db.prepare('SELECT * FROM multi_repository_verification_authorizations WHERE id=?').get(id) as AuthorizationRow | undefined;
		if (!row) throw new MultiRepositoryVerificationAuthorizationNotFoundError('Compatibility execution authorization was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryVerificationAuthorizationForbiddenError('Compatibility execution authorization belongs to another principal');
		const verificationPlan = this.#verificationPlans.get(row.verification_plan_id, principal);
		const schedule = this.#schedules.get(row.schedule_id, principal);
		let gates: v.InferOutput<typeof MultiRepositoryAuthorizedCompatibilityGateSchema>[];
		try { gates = v.parse(v.array(MultiRepositoryAuthorizedCompatibilityGateSchema), JSON.parse(row.gates_json)); }
		catch { throw new MultiRepositoryVerificationAuthorizationConflictError('Stored compatibility gate set is malformed'); }
		const expectedGates = this.#authorizedGates(verificationPlan, schedule);
		if (row.status !== 'authorized' || row.change_set_id !== verificationPlan.changeSetId
			|| row.schedule_id !== verificationPlan.scheduleId || row.verification_plan_sha256 !== verificationPlan.resultSha256
			|| digest({ verificationPlanId: row.verification_plan_id, reason: row.reason }) !== row.request_sha256
			|| digest(gates) !== row.gate_set_sha256
			|| JSON.stringify(canonical(gates)) !== JSON.stringify(canonical(expectedGates))) {
			throw new MultiRepositoryVerificationAuthorizationConflictError('Stored compatibility execution authorization failed parent or gate integrity verification');
		}
		return v.parse(MultiRepositoryVerificationAuthorizationSchema, {
			id: row.id, verificationPlanId: row.verification_plan_id, scheduleId: row.schedule_id,
			changeSetId: row.change_set_id, ownerId: row.owner_id, status: row.status,
			verificationPlanSha256: row.verification_plan_sha256, gateSetSha256: row.gate_set_sha256,
			gates, reason: row.reason, compatibilityExecutionAuthorized: true,
			workspaceMutationAuthorized: false, modelDispatchAuthorized: false, publicationAuthorized: false,
			rolloutAuthorized: false, mergeAuthorized: false, createdAt: row.created_at,
		});
	}

	#assertCurrentPolicy(schedule: MultiRepositoryChangeSetSchedule, plan: ReturnType<MultiRepositoryChangeSetStore['get']>['plan']): void {
		const readiness = projectMultiRepositoryChangeSetReadiness(plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositoryVerificationAuthorizationPolicyError('Current enrollment no longer mutually authorizes every participant');
		const current = new Map(this.#repositories.filter(({ enabled }) => enabled).map((repository) => [repository.id, repository]));
		for (const member of schedule.members) {
			const repository = current.get(member.repositoryId);
			if (!repository?.capabilities.read) {
				throw new MultiRepositoryVerificationAuthorizationPolicyError(`Current repository policy does not permit compatibility reads: ${member.repositoryId}`);
			}
			if (JSON.stringify(canonical(repository.multiRepo.compatibilityGates ?? [])) !== JSON.stringify(canonical(member.policySnapshot.multiRepo.compatibilityGates ?? []))) {
				throw new MultiRepositoryVerificationAuthorizationPolicyError(`Compatibility gate policy changed after scheduling: ${member.repositoryId}`);
			}
		}
	}

	#authorizedGates(verificationPlan: MultiRepositoryVerificationPlan, schedule: MultiRepositoryChangeSetSchedule) {
		const scheduled = new Map(schedule.members.map((member) => [member.repositoryId, member]));
		const gates = verificationPlan.result.compatibilityChecks.flatMap((check) => {
			const member = scheduled.get(check.repositoryId);
			if (!member) throw new MultiRepositoryVerificationAuthorizationConflictError(`Compatibility target is absent from the immutable schedule: ${check.repositoryId}`);
			const matching = (member.policySnapshot.multiRepo.compatibilityGates ?? []).filter(({ dependencyRepositoryId }) => dependencyRepositoryId === check.dependencyRepositoryId);
			if (matching.length === 0) throw new MultiRepositoryVerificationAuthorizationPolicyError(`No repository-declared compatibility gate covers ${check.repositoryId} -> ${check.dependencyRepositoryId}`);
			return matching.map((gate) => v.parse(MultiRepositoryAuthorizedCompatibilityGateSchema, { ...check, gate }));
		});
		return v.parse(v.pipe(v.array(MultiRepositoryAuthorizedCompatibilityGateSchema), v.minLength(1), v.maxLength(120)), gates);
	}

	#findReplay(ownerId: string, idempotencyKey: string): AuthorizationRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_verification_authorizations WHERE owner_id=? AND idempotency_key=?').get(ownerId, idempotencyKey) as AuthorizationRow | undefined;
	}
}
