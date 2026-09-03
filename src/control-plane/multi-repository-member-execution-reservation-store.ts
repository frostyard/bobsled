import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { projectMultiRepositoryChangeSetReadiness } from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryChangeSetStore } from './multi-repository-change-set-store.ts';
import { MultiRepositoryMemberPreparationLeaseStore } from './multi-repository-member-preparation-lease-store.ts';
import {
	MultiRepositoryMemberExecutionPreflightResultSchema,
	type MultiRepositoryMemberExecutionPreflightResult,
} from './multi-repository-member-execution-preflight-contracts.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryMemberExecutionReservationSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	leaseId: v.pipe(v.string(), v.uuid()),
	scheduleId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['reserved', 'running', 'blocked']),
	workerCalls: v.union([v.literal(0), v.literal(1)]),
	attemptId: v.optional(v.pipe(v.string(), v.uuid())),
	attemptNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	preparationResultSha256: Sha256Schema,
	policySnapshotSha256: Sha256Schema,
	policySnapshot: RepositoryContractSchema,
	baseCommit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	evidencePath: v.pipe(v.string(), v.minLength(1)),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	preflightAuthorized: v.boolean(),
	modelDispatchClaimed: v.boolean(),
	modelDispatchAuthorized: v.literal(false),
	executionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	preflight: v.optional(v.object({ result: MultiRepositoryMemberExecutionPreflightResultSchema, createdAt: v.string() })),
});

const ReserveRequestSchema = v.object({
	leaseId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryMemberExecutionReservation = v.InferOutput<typeof MultiRepositoryMemberExecutionReservationSchema>;
export interface MultiRepositoryMemberExecutionClaim { reservation: MultiRepositoryMemberExecutionReservation; newlyClaimed: boolean }
export class MultiRepositoryMemberExecutionReservationConflictError extends Error {}
export class MultiRepositoryMemberExecutionReservationForbiddenError extends Error {}
export class MultiRepositoryMemberExecutionReservationNotFoundError extends Error {}
export class MultiRepositoryMemberExecutionReservationPolicyError extends Error {}

interface ReservationRow {
	id: string; lease_id: string; schedule_id: string; change_set_id: string; repository_id: string;
	run_id: string; job_id: string; owner_id: string; idempotency_key: string; request_sha256: string;
	preparation_result_sha256: string; policy_snapshot_sha256: string; policy_snapshot_json: string;
	base_commit: string; workspace_path: string; evidence_path: string; reason: string; status: string; worker_calls: number;
	attempt_id: string | null; attempt_number: number | null; created_at: string; started_at: string | null; finished_at: string | null;
}

interface PreflightRow { result_sha256: string; result_json: string; created_at: string }

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export class MultiRepositoryMemberExecutionReservationStore {
	readonly #db: Database.Database;
	readonly #leases: MultiRepositoryMemberPreparationLeaseStore;
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
		this.#leases = new MultiRepositoryMemberPreparationLeaseStore(path, now, repositories);
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#leases.close(); this.#db.close(); }

	reserve(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryMemberExecutionReservation {
		const request = v.parse(ReserveRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryMemberExecutionReservationConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryMemberExecutionReservationConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		const lease = this.#leases.get(request.leaseId, principal);
		if (lease.status !== 'prepared' || lease.preparation?.result.status !== 'passed' || !lease.preparation.result.workspaceReady
			|| !lease.preparation.result.baseCommit || lease.preparation.result.baseCommit !== lease.preparation.result.headCommit
			|| lease.preparation.result.changedPaths.length !== 0 || lease.preparation.result.violations.length !== 0) {
			throw new MultiRepositoryMemberExecutionReservationConflictError('Only a clean, passing prepared member can reserve execution preflight');
		}
		const preparation = lease.preparation.result;
		const parent = this.#parents.get(lease.changeSetId, principal);
		const readiness = projectMultiRepositoryChangeSetReadiness(parent.plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositoryMemberExecutionReservationPolicyError('Current enrollment no longer mutually authorizes every participant');
		const currentPolicy = this.#repositories.find(({ enabled, id }) => enabled && id === lease.repositoryId);
		if (!currentPolicy || !currentPolicy.capabilities.writeCode || !currentPolicy.executionPolicy.enabled) {
			throw new MultiRepositoryMemberExecutionReservationPolicyError(`Current repository policy does not permit local execution: ${lease.repositoryId}`);
		}
		const policySnapshot = v.parse(RepositoryContractSchema, currentPolicy);
		const policySnapshotSha256 = digest(policySnapshot);
		if (policySnapshotSha256 !== lease.policySnapshotSha256) {
			throw new MultiRepositoryMemberExecutionReservationPolicyError('Repository policy changed after workspace preparation; create a fresh coordinated execution path');
		}
		const gateIds = new Set(policySnapshot.qualityGates.map(({ id }) => id));
		const missingGate = policySnapshot.executionPolicy.requiredGateIds.find((id) => !gateIds.has(id));
		if (missingGate) throw new MultiRepositoryMemberExecutionReservationPolicyError(`Current execution policy references a missing gate: ${missingGate}`);
		const preparationResultSha256 = digest(preparation);

		return this.#db.transaction(() => {
			const concurrentReplay = this.#findReplay(principal.id, idempotencyKey);
			if (concurrentReplay) {
				if (concurrentReplay.request_sha256 !== requestSha256) throw new MultiRepositoryMemberExecutionReservationConflictError('Idempotency key was already used for different input');
				return this.get(concurrentReplay.id, principal);
			}
			const current = this.#db.prepare(`SELECT l.schedule_id, l.change_set_id, l.repository_id, l.run_id, l.job_id,
				l.owner_id, l.unit_sha256, l.policy_snapshot_sha256, l.status, p.result_sha256,
				r.status AS run_status, j.status AS job_status, j.current_attempt,
				(SELECT COUNT(*) FROM attempts a WHERE a.job_id = j.id) AS attempts,
				(SELECT COUNT(*) FROM reviews rv WHERE rv.job_id = j.id) AS reviews,
				(SELECT COUNT(*) FROM artifacts ar WHERE ar.job_id = j.id) AS artifacts
				FROM multi_repository_member_preparation_leases l
				JOIN multi_repository_member_preparations p ON p.lease_id = l.id
				JOIN runs r ON r.id = l.run_id JOIN jobs j ON j.id = l.job_id WHERE l.id = ?`).get(lease.id) as {
				schedule_id: string; change_set_id: string; repository_id: string; run_id: string; job_id: string;
				owner_id: string; unit_sha256: string; policy_snapshot_sha256: string; status: string; result_sha256: string;
				run_status: string; job_status: string; current_attempt: number; attempts: number; reviews: number; artifacts: number;
			} | undefined;
			if (!current || current.schedule_id !== lease.scheduleId || current.change_set_id !== lease.changeSetId
				|| current.repository_id !== lease.repositoryId || current.run_id !== lease.runId || current.job_id !== lease.jobId
				|| current.owner_id !== principal.id || current.unit_sha256 !== lease.unitSha256 || current.status !== 'prepared'
				|| current.policy_snapshot_sha256 !== policySnapshotSha256 || current.result_sha256 !== preparationResultSha256
				|| current.run_status !== 'blocked' || current.job_status !== 'blocked' || current.current_attempt !== 0
				|| current.attempts !== 0 || current.reviews !== 0 || current.artifacts !== 0) {
				throw new MultiRepositoryMemberExecutionReservationConflictError('Prepared member no longer has pristine, matching execution parentage');
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_member_execution_reservations WHERE lease_id = ?').get(lease.id)) {
				throw new MultiRepositoryMemberExecutionReservationConflictError('This prepared member already has an immutable execution reservation');
			}
			const id = randomUUID();
			const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_member_execution_reservations
				(id, lease_id, schedule_id, change_set_id, repository_id, run_id, job_id, owner_id,
				idempotency_key, request_sha256, preparation_result_sha256, policy_snapshot_sha256, policy_snapshot_json,
				base_commit, workspace_path, evidence_path, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(
				id, lease.id, lease.scheduleId, lease.changeSetId, lease.repositoryId, lease.runId, lease.jobId, principal.id,
				idempotencyKey, requestSha256, preparationResultSha256, policySnapshotSha256, JSON.stringify(policySnapshot),
				preparation.baseCommit, preparation.workspacePath, preparation.evidencePath,
				request.reason, createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryMemberExecutionReservation {
		const row = this.#db.prepare('SELECT * FROM multi_repository_member_execution_reservations WHERE id = ?').get(id) as ReservationRow | undefined;
		if (!row) throw new MultiRepositoryMemberExecutionReservationNotFoundError('Member execution reservation was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryMemberExecutionReservationForbiddenError('Member execution reservation belongs to another principal');
		return this.#record(row);
	}

	recordPreflightAndClaim(
		id: string,
		principal: Principal,
		input: MultiRepositoryMemberExecutionPreflightResult,
	): MultiRepositoryMemberExecutionClaim {
		const result = v.parse(MultiRepositoryMemberExecutionPreflightResultSchema, input);
		if (result.reservationId !== id) throw new MultiRepositoryMemberExecutionReservationConflictError('Preflight evidence does not match its reservation');
		return this.#db.transaction(() => {
			const reservation = this.get(id, principal);
			if (reservation.preflight) {
				if (digest(reservation.preflight.result) !== digest(result)) throw new MultiRepositoryMemberExecutionReservationConflictError('Preflight evidence conflicts with the durable result');
				return { reservation, newlyClaimed: false };
			}
			if (reservation.status !== 'reserved' || reservation.workerCalls !== 0 || reservation.attemptId) {
				throw new MultiRepositoryMemberExecutionReservationConflictError('Only an unused execution reservation can record preflight evidence');
			}
			const passed = result.status === 'passed' && result.violations.length === 0
				&& result.inspection?.headCommit === reservation.baseCommit && result.inspection.dirtyPaths.length === 0;
			if (passed !== (result.status === 'passed')) {
				throw new MultiRepositoryMemberExecutionReservationConflictError('Preflight status disagrees with trusted workspace evidence');
			}
			const timestamp = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_member_execution_preflights
				(reservation_id, result_sha256, result_json, created_at) VALUES (?, ?, ?, ?)`).run(
				id, digest(result), JSON.stringify(result), timestamp,
			);
			if (!passed) {
				const changed = this.#db.prepare(`UPDATE multi_repository_member_execution_reservations
					SET status = 'blocked', finished_at = ? WHERE id = ? AND owner_id = ? AND status = 'reserved' AND worker_calls = 0`)
					.run(timestamp, id, principal.id);
				if (changed.changes !== 1) throw new MultiRepositoryMemberExecutionReservationConflictError('Blocked preflight settlement raced with another claim');
				return { reservation: this.get(id, principal), newlyClaimed: false };
			}

			const state = this.#db.prepare(`SELECT r.owner_id, r.status AS run_status, r.version AS run_version,
				j.status AS job_status, j.current_attempt,
				(SELECT COUNT(*) FROM attempts a WHERE a.job_id = j.id) AS attempts,
				(SELECT COUNT(*) FROM reviews rv WHERE rv.job_id = j.id) AS reviews,
				(SELECT COUNT(*) FROM artifacts ar WHERE ar.job_id = j.id) AS artifacts
				FROM runs r JOIN jobs j ON j.run_id = r.id WHERE r.id = ? AND j.id = ?`).get(
				reservation.runId, reservation.jobId,
			) as { owner_id: string; run_status: string; run_version: number; job_status: string; current_attempt: number; attempts: number; reviews: number; artifacts: number } | undefined;
			if (!state || state.owner_id !== principal.id || state.run_status !== 'blocked' || state.job_status !== 'blocked'
				|| state.current_attempt !== 0 || state.attempts !== 0 || state.reviews !== 0 || state.artifacts !== 0) {
				throw new MultiRepositoryMemberExecutionReservationConflictError('Prepared member no longer has pristine blocked ledger parentage');
			}
			const attemptId = randomUUID();
			this.#db.prepare("INSERT INTO attempts (id, job_id, number, status, started_at) VALUES (?, ?, 1, 'running', ?)")
				.run(attemptId, reservation.jobId, timestamp);
			this.#db.prepare("UPDATE runs SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, reservation.runId);
			this.#db.prepare("UPDATE jobs SET status = 'running', current_attempt = 1, version = version + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, reservation.jobId);
			this.#db.prepare(`INSERT INTO approvals (id, run_id, job_id, kind, actor_id, reason, created_at)
				VALUES (?, ?, ?, 'multi_repository_execution', ?, ?, ?)`).run(
				randomUUID(), reservation.runId, reservation.jobId, principal.id, reservation.reason, timestamp,
			);
			this.#db.prepare(`INSERT INTO audit_events (id, run_id, job_id, actor_id, type, payload_json, created_at)
				VALUES (?, ?, ?, ?, 'multi_repository.execution_started', ?, ?)`).run(
				randomUUID(), reservation.runId, reservation.jobId, principal.id,
				JSON.stringify({ reservationId: id, attemptId, attemptNumber: 1, workerCalls: 1 }), timestamp,
			);
			const changed = this.#db.prepare(`UPDATE multi_repository_member_execution_reservations
				SET status = 'running', worker_calls = 1, attempt_id = ?, attempt_number = 1, started_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'reserved' AND worker_calls = 0 AND attempt_id IS NULL`)
				.run(attemptId, timestamp, id, principal.id);
			if (changed.changes !== 1) throw new MultiRepositoryMemberExecutionReservationConflictError('Model dispatch claim raced with another process');
			return { reservation: this.get(id, principal), newlyClaimed: true };
		}).immediate();
	}

	#findReplay(ownerId: string, idempotencyKey: string): ReservationRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_member_execution_reservations WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, idempotencyKey) as ReservationRow | undefined;
	}

	#record(row: ReservationRow): MultiRepositoryMemberExecutionReservation {
		const lease = this.#leases.get(row.lease_id, { id: row.owner_id });
		const policySnapshot = v.parse(RepositoryContractSchema, JSON.parse(row.policy_snapshot_json));
		const preparation = lease.preparation?.result;
		const preflightRow = this.#db.prepare('SELECT result_sha256, result_json, created_at FROM multi_repository_member_execution_preflights WHERE reservation_id = ?')
			.get(row.id) as PreflightRow | undefined;
		const preflight = preflightRow
			? v.parse(MultiRepositoryMemberExecutionPreflightResultSchema, JSON.parse(preflightRow.result_json))
			: undefined;
		const ledgerState = this.#db.prepare(`SELECT r.status AS run_status, j.status AS job_status, j.current_attempt,
			a.id AS attempt_id, a.number AS attempt_number, a.status AS attempt_status, a.started_at AS attempt_started_at
			FROM runs r JOIN jobs j ON j.run_id = r.id
			LEFT JOIN attempts a ON a.job_id = j.id AND a.id = ?
			WHERE r.id = ? AND j.id = ? AND r.owner_id = ?`).get(
			row.attempt_id, row.run_id, row.job_id, row.owner_id,
		) as { run_status: string; job_status: string; current_attempt: number; attempt_id: string | null; attempt_number: number | null; attempt_status: string | null; attempt_started_at: string | null } | undefined;
		const lifecycleValid = row.status === 'reserved'
			? row.worker_calls === 0 && !row.attempt_id && !row.attempt_number && !row.started_at && !row.finished_at && !preflight
				&& ledgerState?.run_status === 'blocked' && ledgerState.job_status === 'blocked' && ledgerState.current_attempt === 0
			: row.status === 'running'
				? row.worker_calls === 1 && Boolean(row.attempt_id) && row.attempt_number === 1 && Boolean(row.started_at) && !row.finished_at
					&& preflight?.status === 'passed'
					&& ledgerState?.run_status === 'active' && ledgerState.job_status === 'running' && ledgerState.current_attempt === 1
					&& ledgerState.attempt_id === row.attempt_id && ledgerState.attempt_number === row.attempt_number
					&& ledgerState.attempt_status === 'running' && ledgerState.attempt_started_at === row.started_at
				: row.status === 'blocked' && row.worker_calls === 0 && !row.attempt_id && !row.attempt_number && !row.started_at
					&& Boolean(row.finished_at) && preflight?.status === 'blocked'
					&& ledgerState?.run_status === 'blocked' && ledgerState.job_status === 'blocked' && ledgerState.current_attempt === 0;
		if (!lifecycleValid || lease.status !== 'prepared' || !preparation
			|| row.schedule_id !== lease.scheduleId || row.change_set_id !== lease.changeSetId || row.repository_id !== lease.repositoryId
			|| row.run_id !== lease.runId || row.job_id !== lease.jobId || digest(preparation) !== row.preparation_result_sha256
			|| digest(policySnapshot) !== row.policy_snapshot_sha256 || row.policy_snapshot_sha256 !== lease.policySnapshotSha256
			|| row.base_commit !== preparation.baseCommit || row.workspace_path !== preparation.workspacePath || row.evidence_path !== preparation.evidencePath
			|| (preflightRow && digest(preflight) !== preflightRow.result_sha256)
			|| (preflight && (preflight.reservationId !== row.id
				|| (preflight.status === 'passed' && (preflight.inspection?.headCommit !== row.base_commit || preflight.inspection.dirtyPaths.length !== 0))))
			|| digest({ leaseId: row.lease_id, reason: row.reason }) !== row.request_sha256) {
			throw new MultiRepositoryMemberExecutionReservationConflictError('Stored execution reservation failed preparation, policy, or request integrity verification');
		}
		return v.parse(MultiRepositoryMemberExecutionReservationSchema, {
			id: row.id, leaseId: row.lease_id, scheduleId: row.schedule_id, changeSetId: row.change_set_id,
			repositoryId: row.repository_id, runId: row.run_id, jobId: row.job_id, ownerId: row.owner_id,
			status: row.status, workerCalls: row.worker_calls,
			attemptId: row.attempt_id ?? undefined, attemptNumber: row.attempt_number ?? undefined,
			preparationResultSha256: row.preparation_result_sha256,
			policySnapshotSha256: row.policy_snapshot_sha256, policySnapshot,
			baseCommit: row.base_commit, workspacePath: row.workspace_path, evidencePath: row.evidence_path,
			reason: row.reason, preflightAuthorized: row.status === 'reserved', modelDispatchClaimed: row.worker_calls === 1,
			modelDispatchAuthorized: false, executionAuthorized: false, publicationAuthorized: false, createdAt: row.created_at,
			startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
			preflight: preflightRow && preflight ? { result: preflight, createdAt: preflightRow.created_at } : undefined,
		});
	}
}
