import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import {
	IntegrationWorkerDispositionSchema,
	type IntegrationWorkerDisposition,
	IntegrationWorkerRunEvidenceSchema,
	type IntegrationWorkerOutcome,
} from './integration-worker-contracts.ts';
import {
	MultiWorkerPlanV2Schema,
	WorkPlanTaskIdSchema,
	type MultiWorkerPlanV2,
} from './work-plan-contracts.ts';
import { ensureMultiWorkerParentSchema } from './multi-worker-parent-store.ts';
import { GateResultSchema, type GateResult } from './execution-contracts.ts';
import {
	RepositoryContractSchema,
	WorkItemSchema,
	type RepositoryContract,
	type WorkItem,
} from './contracts.ts';
import { IntegrationWorkspaceResultSchema } from './integration-workspace-service.ts';
import {
	IntegrationPreflightResultSchema,
	type IntegrationPreflightResult,
} from './integration-preflight-contracts.ts';

const ReservationSchema = v.object({
	integrationAttemptId: v.pipe(v.string(), v.uuid()),
	assemblyId: v.pipe(v.string(), v.uuid()),
	planSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
	taskId: WorkPlanTaskIdSchema,
});

export const IntegrationInvocationLeaseSchema = v.object({
	...ReservationSchema.entries,
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['reserved', 'running', 'awaiting_gates', 'succeeded', 'blocked', 'failed']),
	workerCalls: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1)),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	outcome: v.optional(IntegrationWorkerDispositionSchema),
	gateResults: v.optional(v.pipe(v.array(GateResultSchema), v.minLength(1), v.maxLength(50))),
	preflight: v.optional(v.object({
		result: IntegrationPreflightResultSchema,
		createdAt: v.string(),
	})),
	workerRun: v.optional(v.object({
		evidence: IntegrationWorkerRunEvidenceSchema,
		createdAt: v.string(),
	})),
});

export type IntegrationInvocationLease = v.InferOutput<typeof IntegrationInvocationLeaseSchema>;
export interface IntegrationPreflightClaim {
	lease: IntegrationInvocationLease;
	newlyClaimed: boolean;
}
export interface IntegrationParentContext {
	workspacePath: string;
	repository: RepositoryContract;
	baseCommit: string;
	assemblyPatchSha256: string;
	assemblyChangedPaths: string[];
	plan: MultiWorkerPlanV2;
	workItem: WorkItem;
}

export class IntegrationInvocationConflictError extends Error {}
export class IntegrationInvocationForbiddenError extends Error {}
export class IntegrationInvocationNotFoundError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function hash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

export function ensureIntegrationInvocationSchema(db: Database.Database): void {
	ensureMultiWorkerParentSchema(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_invocations (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, assembly_id TEXT NOT NULL UNIQUE,
			plan_sha256 TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
			worker_calls INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL,
			request_hash TEXT NOT NULL, outcome_json TEXT, created_at TEXT NOT NULL,
			started_at TEXT, finished_at TEXT, UNIQUE(owner_id, idempotency_key)
		);
		CREATE TABLE IF NOT EXISTS integration_gate_runs (
			invocation_id TEXT PRIMARY KEY, results_json TEXT NOT NULL, created_at TEXT NOT NULL,
			FOREIGN KEY(invocation_id) REFERENCES integration_invocations(id)
		);
		CREATE TABLE IF NOT EXISTS integration_preflights (
			invocation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
			FOREIGN KEY(invocation_id) REFERENCES integration_invocations(id)
		);
		CREATE TABLE IF NOT EXISTS integration_worker_runs (
			invocation_id TEXT PRIMARY KEY, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
			FOREIGN KEY(invocation_id) REFERENCES integration_invocations(id)
		);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (10, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (11, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (12, datetime('now'));
	`);
}

export class IntegrationInvocationStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureIntegrationInvocationSchema(this.#db);
		this.#now = now;
	}

	close(): void {
		this.#db.close();
	}

	reserve(input: unknown, ownerId: string, idempotencyKey: string): IntegrationInvocationLease {
		const reservation = v.parse(ReservationSchema, input);
		if (!ownerId || ownerId.length > 500) throw new Error('A bounded owner identity is required');
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded idempotency key is required');
		const requestHash = hash(reservation);
		return this.#db.transaction(() => {
			const parent = this.#db.prepare(`SELECT multi_worker_plans.owner_id, multi_worker_plans.plan_sha256,
				integration_assemblies.task_id, integration_assemblies.status
				FROM integration_assemblies JOIN multi_worker_plans ON multi_worker_plans.id = integration_assemblies.plan_id
				WHERE integration_assemblies.id = ?`).get(reservation.assemblyId) as {
					owner_id: string; plan_sha256: string; task_id: string; status: string;
				} | undefined;
			if (!parent) throw new IntegrationInvocationConflictError('Integration assembly has no durable parent');
			if (parent.owner_id !== ownerId) throw new IntegrationInvocationForbiddenError('Integration assembly belongs to another principal');
			if (parent.plan_sha256 !== reservation.planSha256 || parent.task_id !== reservation.taskId || parent.status !== 'assembled') {
				throw new IntegrationInvocationConflictError('Invocation does not match an assembled plan parent');
			}
			const replay = this.#db.prepare('SELECT id, request_hash FROM integration_invocations WHERE owner_id = ? AND idempotency_key = ?')
				.get(ownerId, idempotencyKey) as { id: string; request_hash: string } | undefined;
			if (replay) {
				if (replay.request_hash !== requestHash) throw new IntegrationInvocationConflictError('Idempotency key was used for different integration input');
				return this.get(replay.id, ownerId);
			}
			const existingAssembly = this.#db.prepare('SELECT id FROM integration_invocations WHERE assembly_id = ?').get(reservation.assemblyId);
			if (existingAssembly) throw new IntegrationInvocationConflictError('Assembly already has an integration invocation');
			const timestamp = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO integration_invocations
				(id, owner_id, assembly_id, plan_sha256, task_id, status, worker_calls, idempotency_key, request_hash, created_at)
				VALUES (?, ?, ?, ?, ?, 'reserved', 0, ?, ?, ?)`).run(
				reservation.integrationAttemptId, ownerId, reservation.assemblyId, reservation.planSha256,
				reservation.taskId, idempotencyKey, requestHash, timestamp,
			);
			return this.get(reservation.integrationAttemptId, ownerId);
		})();
	}

	recordPreflightAndClaim(integrationAttemptId: string, ownerId: string, inputResult: IntegrationPreflightResult): IntegrationPreflightClaim {
		const result = v.parse(IntegrationPreflightResultSchema, inputResult);
		if (result.integrationAttemptId !== integrationAttemptId) {
			throw new IntegrationInvocationConflictError('Integration preflight does not match its durable lease');
		}
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			const existing = lease.preflight?.result;
			if (existing) {
				if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(result))) {
					throw new IntegrationInvocationConflictError('Integration preflight conflicts with existing evidence');
				}
				return { lease, newlyClaimed: false };
			}
			if (lease.status !== 'reserved' || lease.workerCalls !== 0) {
				throw new IntegrationInvocationConflictError('Only an unclaimed reservation can record integration preflight');
			}
			const timestamp = this.#now().toISOString();
			this.#db.prepare('INSERT INTO integration_preflights (invocation_id, result_json, created_at) VALUES (?, ?, ?)')
				.run(integrationAttemptId, JSON.stringify(result), timestamp);
			const changed = result.status === 'passed'
				? this.#db.prepare(`UPDATE integration_invocations SET status = 'running', worker_calls = 1, started_at = ?
					WHERE id = ? AND owner_id = ? AND status = 'reserved' AND worker_calls = 0`)
					.run(timestamp, integrationAttemptId, ownerId)
				: this.#db.prepare(`UPDATE integration_invocations SET status = 'blocked', finished_at = ?
					WHERE id = ? AND owner_id = ? AND status = 'reserved' AND worker_calls = 0`)
					.run(timestamp, integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration preflight was settled concurrently');
			return { lease: this.get(integrationAttemptId, ownerId), newlyClaimed: result.status === 'passed' };
		})();
	}

	complete(integrationAttemptId: string, ownerId: string, workerOutcome: IntegrationWorkerOutcome, outcome: IntegrationWorkerDisposition): IntegrationInvocationLease {
		const evidence = v.parse(IntegrationWorkerRunEvidenceSchema, { status: 'completed', receipt: workerOutcome });
		if (evidence.status !== 'completed') throw new IntegrationInvocationConflictError('Completed worker evidence was not retained');
		const parsedOutcome = v.parse(IntegrationWorkerDispositionSchema, outcome);
		if (!samePaths(evidence.receipt.result.changedPaths, parsedOutcome.workerChangedPaths)) {
			throw new IntegrationInvocationConflictError('Worker receipt paths do not match trusted integration disposition');
		}
		if ((evidence.receipt.result.disposition === 'blocked') !== parsedOutcome.violations.includes('worker_blocked')) {
			throw new IntegrationInvocationConflictError('Worker receipt disposition does not match trusted integration disposition');
		}
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			if (lease.status !== 'running' || lease.workerCalls !== 1) throw new IntegrationInvocationConflictError('Only a running integration invocation can complete');
			if (parsedOutcome.integrationAttemptId !== lease.integrationAttemptId || parsedOutcome.taskId !== lease.taskId) {
				throw new IntegrationInvocationConflictError('Integration outcome does not match its durable lease');
			}
			const timestamp = this.#now().toISOString();
			const status = parsedOutcome.status === 'succeeded' ? 'awaiting_gates' : 'blocked';
			this.#db.prepare('INSERT INTO integration_worker_runs (invocation_id, evidence_json, created_at) VALUES (?, ?, ?)')
				.run(integrationAttemptId, JSON.stringify(evidence), timestamp);
			const changed = this.#db.prepare(`UPDATE integration_invocations SET status = ?, outcome_json = ?, finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'running' AND worker_calls = 1 AND outcome_json IS NULL`)
				.run(status, JSON.stringify(parsedOutcome), status === 'blocked' ? timestamp : null, integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration invocation was settled concurrently');
			return this.get(integrationAttemptId, ownerId);
		})();
	}

	settleGates(integrationAttemptId: string, ownerId: string, inputResults: GateResult[]): IntegrationInvocationLease {
		const results = v.parse(v.pipe(v.array(GateResultSchema), v.minLength(1), v.maxLength(50)), inputResults);
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			if (lease.status !== 'awaiting_gates' || lease.outcome?.status !== 'succeeded') {
				throw new IntegrationInvocationConflictError('Only a successful worker awaiting gates can settle gate evidence');
			}
			const timestamp = this.#now().toISOString();
			const status = results.every(({ status: gateStatus }) => gateStatus === 'passed') ? 'succeeded' : 'blocked';
			this.#db.prepare('INSERT INTO integration_gate_runs (invocation_id, results_json, created_at) VALUES (?, ?, ?)')
				.run(integrationAttemptId, JSON.stringify(results), timestamp);
			const changed = this.#db.prepare(`UPDATE integration_invocations SET status = ?, finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'awaiting_gates'`)
				.run(status, timestamp, integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration gates were settled concurrently');
			return this.get(integrationAttemptId, ownerId);
		})();
	}

	fail(integrationAttemptId: string, ownerId: string, detail: string): IntegrationInvocationLease {
		const evidence = v.parse(IntegrationWorkerRunEvidenceSchema, { status: 'failed', detail });
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			if (lease.status !== 'running' || lease.workerCalls !== 1) throw new IntegrationInvocationConflictError('Only a running integration invocation can fail');
			const timestamp = this.#now().toISOString();
			this.#db.prepare('INSERT INTO integration_worker_runs (invocation_id, evidence_json, created_at) VALUES (?, ?, ?)')
				.run(integrationAttemptId, JSON.stringify(evidence), timestamp);
			const changed = this.#db.prepare(`UPDATE integration_invocations SET status = 'failed', finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'running' AND worker_calls = 1 AND outcome_json IS NULL`)
				.run(timestamp, integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration invocation was settled concurrently');
			return this.get(integrationAttemptId, ownerId);
		})();
	}

	get(integrationAttemptId: string, ownerId: string): IntegrationInvocationLease {
		const row = this.#db.prepare('SELECT * FROM integration_invocations WHERE id = ?').get(integrationAttemptId) as Record<string, unknown> | undefined;
		if (!row) throw new IntegrationInvocationNotFoundError('Integration invocation does not exist');
		if (row.owner_id !== ownerId) throw new IntegrationInvocationForbiddenError('Integration invocation belongs to another principal');
		const gateRow = this.#db.prepare('SELECT results_json FROM integration_gate_runs WHERE invocation_id = ?')
			.get(integrationAttemptId) as { results_json: string } | undefined;
		const preflightRow = this.#db.prepare('SELECT result_json, created_at FROM integration_preflights WHERE invocation_id = ?')
			.get(integrationAttemptId) as { result_json: string; created_at: string } | undefined;
		const workerRow = this.#db.prepare('SELECT evidence_json, created_at FROM integration_worker_runs WHERE invocation_id = ?')
			.get(integrationAttemptId) as { evidence_json: string; created_at: string } | undefined;
		return v.parse(IntegrationInvocationLeaseSchema, {
			integrationAttemptId: row.id, ownerId: row.owner_id, assemblyId: row.assembly_id,
			planSha256: row.plan_sha256, taskId: row.task_id, status: row.status,
			workerCalls: row.worker_calls, createdAt: row.created_at,
			startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
			outcome: row.outcome_json ? JSON.parse(row.outcome_json as string) : undefined,
			gateResults: gateRow ? JSON.parse(gateRow.results_json) : undefined,
			preflight: preflightRow ? { result: JSON.parse(preflightRow.result_json), createdAt: preflightRow.created_at } : undefined,
			workerRun: workerRow ? { evidence: JSON.parse(workerRow.evidence_json), createdAt: workerRow.created_at } : undefined,
		});
	}

	getParentContext(integrationAttemptId: string, ownerId: string): IntegrationParentContext {
		this.get(integrationAttemptId, ownerId);
		const row = this.#db.prepare(`SELECT integration_assemblies.result_json, jobs.policy_snapshot_json,
			jobs.work_item_snapshot_json, multi_worker_plans.base_commit, multi_worker_plans.plan_json
			FROM integration_invocations
			JOIN integration_assemblies ON integration_assemblies.id = integration_invocations.assembly_id
			JOIN multi_worker_plans ON multi_worker_plans.id = integration_assemblies.plan_id
			JOIN jobs ON jobs.id = multi_worker_plans.job_id
			WHERE integration_invocations.id = ?`).get(integrationAttemptId) as {
				result_json: string; policy_snapshot_json: string; work_item_snapshot_json: string;
				base_commit: string; plan_json: string;
			} | undefined;
		if (!row) throw new IntegrationInvocationConflictError('Integration invocation has no complete gate parent chain');
		const assembly = v.parse(IntegrationWorkspaceResultSchema, JSON.parse(row.result_json));
		if (assembly.status !== 'assembled') throw new IntegrationInvocationConflictError('Integration invocation parent is not assembled');
		if (assembly.baseCommit !== row.base_commit) throw new IntegrationInvocationConflictError('Integration assembly base no longer matches its plan parent');
		return {
			workspacePath: assembly.workspacePath,
			repository: v.parse(RepositoryContractSchema, JSON.parse(row.policy_snapshot_json)),
			baseCommit: row.base_commit,
			assemblyPatchSha256: assembly.patchSha256,
			assemblyChangedPaths: assembly.changedPaths,
			plan: v.parse(MultiWorkerPlanV2Schema, JSON.parse(row.plan_json)),
			workItem: v.parse(WorkItemSchema, JSON.parse(row.work_item_snapshot_json)),
		};
	}
}
