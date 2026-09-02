import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import {
	IntegrationWorkerDispositionSchema,
	type IntegrationWorkerDisposition,
} from './integration-worker-contracts.ts';
import { WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const ReservationSchema = v.object({
	integrationAttemptId: v.pipe(v.string(), v.uuid()),
	assemblyId: v.pipe(v.string(), v.uuid()),
	planSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
	taskId: WorkPlanTaskIdSchema,
});

export const IntegrationInvocationLeaseSchema = v.object({
	...ReservationSchema.entries,
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['reserved', 'running', 'succeeded', 'blocked', 'failed']),
	workerCalls: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1)),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	outcome: v.optional(IntegrationWorkerDispositionSchema),
});

export type IntegrationInvocationLease = v.InferOutput<typeof IntegrationInvocationLeaseSchema>;

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

export function ensureIntegrationInvocationSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_invocations (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, assembly_id TEXT NOT NULL UNIQUE,
			plan_sha256 TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
			worker_calls INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL,
			request_hash TEXT NOT NULL, outcome_json TEXT, created_at TEXT NOT NULL,
			started_at TEXT, finished_at TEXT, UNIQUE(owner_id, idempotency_key)
		);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));
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

	claim(integrationAttemptId: string, ownerId: string): IntegrationInvocationLease {
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			if (lease.status !== 'reserved' || lease.workerCalls !== 0) {
				throw new IntegrationInvocationConflictError('Integration invocation is not available for its sole worker call');
			}
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare(`UPDATE integration_invocations
				SET status = 'running', worker_calls = 1, started_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'reserved' AND worker_calls = 0`)
				.run(timestamp, integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration invocation was claimed concurrently');
			return this.get(integrationAttemptId, ownerId);
		})();
	}

	complete(integrationAttemptId: string, ownerId: string, outcome: IntegrationWorkerDisposition): IntegrationInvocationLease {
		const parsedOutcome = v.parse(IntegrationWorkerDispositionSchema, outcome);
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			if (lease.status !== 'running' || lease.workerCalls !== 1) throw new IntegrationInvocationConflictError('Only a running integration invocation can complete');
			if (parsedOutcome.integrationAttemptId !== lease.integrationAttemptId || parsedOutcome.taskId !== lease.taskId) {
				throw new IntegrationInvocationConflictError('Integration outcome does not match its durable lease');
			}
			const timestamp = this.#now().toISOString();
			const status = parsedOutcome.status;
			const changed = this.#db.prepare(`UPDATE integration_invocations SET status = ?, outcome_json = ?, finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'running' AND worker_calls = 1 AND outcome_json IS NULL`)
				.run(status, JSON.stringify(parsedOutcome), timestamp, integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration invocation was settled concurrently');
			return this.get(integrationAttemptId, ownerId);
		})();
	}

	fail(integrationAttemptId: string, ownerId: string): IntegrationInvocationLease {
		return this.#db.transaction(() => {
			const lease = this.get(integrationAttemptId, ownerId);
			if (lease.status !== 'running' || lease.workerCalls !== 1) throw new IntegrationInvocationConflictError('Only a running integration invocation can fail');
			const changed = this.#db.prepare(`UPDATE integration_invocations SET status = 'failed', finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'running' AND worker_calls = 1 AND outcome_json IS NULL`)
				.run(this.#now().toISOString(), integrationAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationInvocationConflictError('Integration invocation was settled concurrently');
			return this.get(integrationAttemptId, ownerId);
		})();
	}

	get(integrationAttemptId: string, ownerId: string): IntegrationInvocationLease {
		const row = this.#db.prepare('SELECT * FROM integration_invocations WHERE id = ?').get(integrationAttemptId) as Record<string, unknown> | undefined;
		if (!row) throw new IntegrationInvocationNotFoundError('Integration invocation does not exist');
		if (row.owner_id !== ownerId) throw new IntegrationInvocationForbiddenError('Integration invocation belongs to another principal');
		return v.parse(IntegrationInvocationLeaseSchema, {
			integrationAttemptId: row.id, ownerId: row.owner_id, assemblyId: row.assembly_id,
			planSha256: row.plan_sha256, taskId: row.task_id, status: row.status,
			workerCalls: row.worker_calls, createdAt: row.created_at,
			startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
			outcome: row.outcome_json ? JSON.parse(row.outcome_json as string) : undefined,
		});
	}
}
