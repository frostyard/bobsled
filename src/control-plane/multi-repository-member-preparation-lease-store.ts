import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import { PreparationResultSchema } from './execution-contracts.ts';
import type { Principal } from './ledger.ts';
import { projectMultiRepositoryChangeSetReadiness } from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryChangeSetScheduleStore } from './multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from './multi-repository-change-set-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryMemberPreparationResultSchema = v.object({
	leaseId: v.pipe(v.string(), v.uuid()),
	repositoryId: RepositoryIdSchema,
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	evidencePath: v.pipe(v.string(), v.minLength(1)),
	baseCommit: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/))),
	headCommit: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/))),
	preparation: v.optional(PreparationResultSchema),
	changedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
	status: v.picklist(['passed', 'blocked']),
	violations: v.pipe(v.array(v.picklist([
		'source_unavailable', 'source_not_root', 'workspace_exists', 'workspace_creation_failed',
		'preparation_failed', 'preparation_ambiguous', 'inspection_failed', 'head_moved', 'preparation_changed_workspace',
	])), v.maxLength(10)),
	detail: v.pipe(v.string(), v.maxLength(10_000)),
	workspaceReady: v.boolean(),
	modelDispatchAuthorized: v.literal(false),
	executionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
});

export const MultiRepositoryMemberPreparationLeaseSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	scheduleId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['reserved', 'preparing', 'prepared', 'consumed', 'blocked', 'expired']),
	unitSha256: Sha256Schema,
	policySnapshotSha256: Sha256Schema,
	policySnapshot: RepositoryContractSchema,
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	workspacePreparationAuthorized: v.boolean(),
	modelDispatchAuthorized: v.literal(false),
	executionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	expiresAt: v.string(),
	preparation: v.optional(v.object({
		result: MultiRepositoryMemberPreparationResultSchema,
		createdAt: v.string(),
	})),
});

const ReserveRequestSchema = v.object({
	scheduleId: v.pipe(v.string(), v.uuid()),
	repositoryId: RepositoryIdSchema,
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryMemberPreparationLease = v.InferOutput<typeof MultiRepositoryMemberPreparationLeaseSchema>;
export type MultiRepositoryMemberPreparationResult = NonNullable<MultiRepositoryMemberPreparationLease['preparation']>['result'];
export interface MultiRepositoryMemberPreparationClaim { lease: MultiRepositoryMemberPreparationLease; newlyClaimed: boolean }
export class MultiRepositoryPreparationLeaseConflictError extends Error {}
export class MultiRepositoryPreparationLeaseForbiddenError extends Error {}
export class MultiRepositoryPreparationLeaseNotFoundError extends Error {}
export class MultiRepositoryPreparationLeaseNotReadyError extends Error {}
export class MultiRepositoryPreparationLeasePolicyError extends Error {}

interface LeaseRow {
	id: string; schedule_id: string; change_set_id: string; repository_id: string; run_id: string; job_id: string;
	owner_id: string; idempotency_key: string; request_sha256: string; unit_sha256: string;
	policy_snapshot_sha256: string; policy_snapshot_json: string; reason: string; status: string; created_at: string;
	started_at: string | null; finished_at: string | null; expires_at: string;
}

interface PreparationRow { result_sha256: string; result_json: string; created_at: string }

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function isPassingPreparation(result: MultiRepositoryMemberPreparationResult): boolean {
	return result.status === 'passed' && result.workspaceReady && result.violations.length === 0
		&& result.preparation?.status === 'passed' && result.baseCommit === result.headCommit
		&& result.changedPaths.length === 0;
}

export class MultiRepositoryMemberPreparationLeaseStore {
	readonly #db: Database.Database;
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
		this.#schedules = new MultiRepositoryChangeSetScheduleStore(path, now, repositories);
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#schedules.close(); this.#db.close(); }

	reserve(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryMemberPreparationLease {
		const request = v.parse(ReserveRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryPreparationLeaseConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryPreparationLeaseConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		const schedule = this.#schedules.get(request.scheduleId, principal);
		const parent = this.#parents.get(schedule.changeSetId, principal);
		const scheduledMember = schedule.members.find(({ repositoryId }) => repositoryId === request.repositoryId);
		const unit = parent.plan.repositories.find(({ repositoryId }) => repositoryId === request.repositoryId);
		if (!scheduledMember || !unit) throw new MultiRepositoryPreparationLeaseConflictError('Requested repository is not an authorized scheduled member');
		const readiness = projectMultiRepositoryChangeSetReadiness(parent.plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositoryPreparationLeasePolicyError('Current enrollment no longer mutually authorizes every participant');
		const policy = this.#repositories.find(({ enabled, id }) => enabled && id === request.repositoryId);
		if (!policy || !policy.capabilities.writeCode || !policy.executionPolicy.enabled) {
			throw new MultiRepositoryPreparationLeasePolicyError(`Current repository policy does not permit workspace preparation: ${request.repositoryId}`);
		}
		const currentPolicy = v.parse(RepositoryContractSchema, policy);
		const gateIds = new Set(currentPolicy.qualityGates.map(({ id }) => id));
		const missingGate = currentPolicy.executionPolicy.requiredGateIds.find((id) => !gateIds.has(id));
		if (missingGate) throw new MultiRepositoryPreparationLeasePolicyError(`Current execution policy references a missing gate: ${missingGate}`);
		const policySnapshotSha256 = digest(currentPolicy);

		return this.#db.transaction(() => {
			const existingReplay = this.#findReplay(principal.id, idempotencyKey);
			if (existingReplay) {
				if (existingReplay.request_sha256 !== requestSha256) throw new MultiRepositoryPreparationLeaseConflictError('Idempotency key was already used for different input');
				return this.get(existingReplay.id, principal);
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_member_preparation_leases WHERE schedule_id = ? AND repository_id = ?').get(schedule.id, request.repositoryId)) {
				throw new MultiRepositoryPreparationLeaseConflictError('This scheduled member already has an immutable preparation lease');
			}
			if (this.#db.prepare("SELECT id FROM multi_repository_member_preparation_leases WHERE schedule_id = ? AND status = 'reserved'").get(schedule.id)) {
				throw new MultiRepositoryPreparationLeaseConflictError('Another member already holds this schedule preparation lease');
			}
			const currentSchedule = this.#db.prepare(`SELECT authorization_id, change_set_id, owner_id, plan_sha256, authorization_member_set_sha256, status
				FROM multi_repository_change_set_schedules WHERE id = ?`).get(schedule.id) as
				{ authorization_id: string; change_set_id: string; owner_id: string; plan_sha256: string; authorization_member_set_sha256: string; status: string } | undefined;
			if (!currentSchedule || currentSchedule.authorization_id !== schedule.authorizationId || currentSchedule.change_set_id !== parent.id
				|| currentSchedule.owner_id !== principal.id || currentSchedule.plan_sha256 !== parent.planSha256
				|| currentSchedule.authorization_member_set_sha256 !== schedule.authorizationMemberSetSha256 || currentSchedule.status !== 'scheduled') {
				throw new MultiRepositoryPreparationLeaseConflictError('Schedule parent changed before preparation reservation');
			}
			const memberState = this.#db.prepare(`SELECT r.owner_id, r.status AS run_status, j.status AS job_status, j.current_attempt,
				(SELECT COUNT(*) FROM attempts a WHERE a.job_id = j.id) AS attempts,
				(SELECT COUNT(*) FROM reviews rv WHERE rv.job_id = j.id) AS reviews,
				(SELECT COUNT(*) FROM artifacts ar WHERE ar.job_id = j.id) AS artifacts
				FROM multi_repository_change_set_schedule_members sm JOIN runs r ON r.id = sm.run_id JOIN jobs j ON j.id = sm.job_id
				WHERE sm.schedule_id = ? AND sm.repository_id = ? AND sm.run_id = ? AND sm.job_id = ? AND sm.unit_sha256 = ?`).get(
				schedule.id, request.repositoryId, scheduledMember.runId, scheduledMember.jobId, scheduledMember.unitSha256,
			) as { owner_id: string; run_status: string; job_status: string; current_attempt: number; attempts: number; reviews: number; artifacts: number } | undefined;
			if (!memberState || memberState.owner_id !== principal.id || memberState.run_status !== 'blocked' || memberState.job_status !== 'blocked'
				|| memberState.current_attempt !== 0 || memberState.attempts !== 0 || memberState.reviews !== 0 || memberState.artifacts !== 0) {
				throw new MultiRepositoryPreparationLeaseConflictError('Preparation target must retain pristine blocked ledger parentage');
			}
			for (const dependencyRepositoryId of unit.dependsOn) this.#assertDependencyComplete(schedule.id, dependencyRepositoryId);
			const id = randomUUID();
			const created = this.#now();
			const createdAt = created.toISOString();
			const expiresAt = new Date(created.getTime() + currentPolicy.workspacePreparation.timeoutMinutes * 60_000).toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_member_preparation_leases
				(id, schedule_id, change_set_id, repository_id, run_id, job_id, owner_id, idempotency_key, request_sha256,
				unit_sha256, policy_snapshot_sha256, policy_snapshot_json, reason, status, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
				id, schedule.id, parent.id, request.repositoryId, scheduledMember.runId, scheduledMember.jobId, principal.id,
				idempotencyKey, requestSha256, scheduledMember.unitSha256, policySnapshotSha256,
				JSON.stringify(currentPolicy), request.reason, createdAt, expiresAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryMemberPreparationLease {
		const row = this.#db.prepare('SELECT * FROM multi_repository_member_preparation_leases WHERE id = ?').get(id) as LeaseRow | undefined;
		if (!row) throw new MultiRepositoryPreparationLeaseNotFoundError('Member preparation lease was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryPreparationLeaseForbiddenError('Member preparation lease belongs to another principal');
		return this.#record(row);
	}

	claimPreparation(id: string, principal: Principal): MultiRepositoryMemberPreparationClaim {
		return this.#db.transaction(() => {
			const lease = this.get(id, principal);
			if (lease.status === 'preparing' || lease.preparation) return { lease, newlyClaimed: false };
			if (lease.status !== 'reserved') throw new MultiRepositoryPreparationLeaseConflictError('Only a reserved lease can claim workspace preparation');
			const timestamp = this.#now().toISOString();
			if (Date.parse(lease.expiresAt) <= this.#now().getTime()) {
				const changed = this.#db.prepare(`UPDATE multi_repository_member_preparation_leases
					SET status = 'expired', finished_at = ? WHERE id = ? AND owner_id = ? AND status = 'reserved'`)
					.run(timestamp, id, principal.id);
				if (changed.changes !== 1) throw new MultiRepositoryPreparationLeaseConflictError('Preparation lease expiry raced with another claim');
				return { lease: this.get(id, principal), newlyClaimed: false };
			}
			const changed = this.#db.prepare(`UPDATE multi_repository_member_preparation_leases
				SET status = 'preparing', started_at = ? WHERE id = ? AND owner_id = ? AND status = 'reserved'`)
				.run(timestamp, id, principal.id);
			if (changed.changes !== 1) throw new MultiRepositoryPreparationLeaseConflictError('Workspace preparation was claimed concurrently');
			return { lease: this.get(id, principal), newlyClaimed: true };
		}).immediate();
	}

	completePreparation(id: string, principal: Principal, input: MultiRepositoryMemberPreparationResult): MultiRepositoryMemberPreparationLease {
		const result = v.parse(MultiRepositoryMemberPreparationResultSchema, input);
		if (result.leaseId !== id) throw new MultiRepositoryPreparationLeaseConflictError('Preparation evidence does not match its lease');
		return this.#db.transaction(() => {
			const lease = this.get(id, principal);
			if (lease.preparation) {
				if (digest(lease.preparation.result) !== digest(result)) throw new MultiRepositoryPreparationLeaseConflictError('Preparation evidence conflicts with the durable result');
				return lease;
			}
			if (lease.status !== 'preparing' || result.repositoryId !== lease.repositoryId) {
				throw new MultiRepositoryPreparationLeaseConflictError('Only a claimed matching lease can record preparation evidence');
			}
			const passed = isPassingPreparation(result);
			if (passed !== (result.status === 'passed')
				|| (result.status === 'blocked' && (result.workspaceReady || result.violations.length === 0))) {
				throw new MultiRepositoryPreparationLeaseConflictError('Preparation status disagrees with trusted workspace evidence');
			}
			const timestamp = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_member_preparations
				(lease_id, result_sha256, result_json, created_at) VALUES (?, ?, ?, ?)`)
				.run(id, digest(result), JSON.stringify(result), timestamp);
			const status = passed ? 'prepared' : 'blocked';
			const changed = this.#db.prepare(`UPDATE multi_repository_member_preparation_leases
				SET status = ?, finished_at = ? WHERE id = ? AND owner_id = ? AND status = 'preparing'`)
				.run(status, timestamp, id, principal.id);
			if (changed.changes !== 1) throw new MultiRepositoryPreparationLeaseConflictError('Workspace preparation was settled concurrently');
			return this.get(id, principal);
		}).immediate();
	}

	#assertDependencyComplete(scheduleId: string, repositoryId: string): void {
		const dependency = this.#db.prepare(`SELECT r.status AS run_status, j.status AS job_status, j.current_attempt,
			(SELECT COUNT(*) FROM attempts a WHERE a.job_id = j.id AND a.number = j.current_attempt AND a.status = 'succeeded') AS successful_attempts,
			(SELECT COUNT(*) FROM reviews rv JOIN attempts a ON a.id = rv.attempt_id
				WHERE rv.job_id = j.id AND a.job_id = j.id AND a.number = j.current_attempt AND rv.status = 'approved') AS approved_reviews,
			sm.policy_snapshot_json
			FROM multi_repository_change_set_schedule_members sm JOIN runs r ON r.id = sm.run_id JOIN jobs j ON j.id = sm.job_id
			WHERE sm.schedule_id = ? AND sm.repository_id = ?`).get(scheduleId, repositoryId) as
			{ run_status: string; job_status: string; current_attempt: number; successful_attempts: number; approved_reviews: number; policy_snapshot_json: string } | undefined;
		if (!dependency) throw new MultiRepositoryPreparationLeaseConflictError(`Dependency is absent from the immutable schedule: ${repositoryId}`);
		const policy = v.parse(RepositoryContractSchema, JSON.parse(dependency.policy_snapshot_json));
		const reviewed = !policy.reviewPolicy.enabled || dependency.approved_reviews > 0;
		if (dependency.run_status !== 'succeeded' || dependency.job_status !== 'succeeded'
			|| dependency.current_attempt < 1 || dependency.successful_attempts < 1 || !reviewed) {
			throw new MultiRepositoryPreparationLeaseNotReadyError(`Dependency has not completed trusted implementation${policy.reviewPolicy.enabled ? ' and review' : ''}: ${repositoryId}`);
		}
	}

	#findReplay(ownerId: string, idempotencyKey: string): LeaseRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_member_preparation_leases WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, idempotencyKey) as LeaseRow | undefined;
	}

	#record(row: LeaseRow): MultiRepositoryMemberPreparationLease {
		const schedule = this.#schedules.get(row.schedule_id, { id: row.owner_id });
		const member = schedule.members.find(({ repositoryId }) => repositoryId === row.repository_id);
		const policySnapshot = v.parse(RepositoryContractSchema, JSON.parse(row.policy_snapshot_json));
		const expectedExpiresAt = new Date(
			Date.parse(row.created_at) + policySnapshot.workspacePreparation.timeoutMinutes * 60_000,
		).toISOString();
		const preparationRow = this.#db.prepare('SELECT result_sha256, result_json, created_at FROM multi_repository_member_preparations WHERE lease_id = ?')
			.get(row.id) as PreparationRow | undefined;
		const preparationResult = preparationRow
			? v.parse(MultiRepositoryMemberPreparationResultSchema, JSON.parse(preparationRow.result_json))
			: undefined;
		const lifecycleValid = row.status === 'reserved'
			? !row.started_at && !row.finished_at && !preparationRow
			: row.status === 'preparing'
				? Boolean(row.started_at) && !row.finished_at && !preparationRow
				: row.status === 'expired'
					? !row.started_at && Boolean(row.finished_at) && !preparationRow
					: ['prepared', 'consumed', 'blocked'].includes(row.status) && Boolean(row.started_at) && Boolean(row.finished_at) && Boolean(preparationRow);
		if (!lifecycleValid || row.change_set_id !== schedule.changeSetId || !member
			|| row.run_id !== member.runId || row.job_id !== member.jobId || row.unit_sha256 !== member.unitSha256
			|| digest(policySnapshot) !== row.policy_snapshot_sha256
			|| row.expires_at !== expectedExpiresAt
			|| (preparationRow && digest(preparationResult) !== preparationRow.result_sha256)
			|| (preparationResult && (preparationResult.leaseId !== row.id || preparationResult.repositoryId !== row.repository_id
				|| (['prepared', 'consumed'].includes(row.status)) !== isPassingPreparation(preparationResult)
				|| (preparationResult.status === 'blocked' && (preparationResult.workspaceReady || preparationResult.violations.length === 0))))
			|| digest({ scheduleId: row.schedule_id, repositoryId: row.repository_id, reason: row.reason }) !== row.request_sha256) {
			throw new MultiRepositoryPreparationLeaseConflictError('Stored preparation lease failed schedule, member, policy, or request integrity verification');
		}
		return v.parse(MultiRepositoryMemberPreparationLeaseSchema, {
			id: row.id, scheduleId: row.schedule_id, changeSetId: row.change_set_id, repositoryId: row.repository_id,
			runId: row.run_id, jobId: row.job_id, ownerId: row.owner_id, status: row.status,
			unitSha256: row.unit_sha256, policySnapshotSha256: row.policy_snapshot_sha256, policySnapshot,
			reason: row.reason, workspacePreparationAuthorized: row.status === 'reserved' || row.status === 'preparing', modelDispatchAuthorized: false,
			executionAuthorized: false, publicationAuthorized: false, createdAt: row.created_at,
			startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined, expiresAt: row.expires_at,
			preparation: preparationRow && preparationResult ? { result: preparationResult, createdAt: preparationRow.created_at } : undefined,
		});
	}
}
