import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { MultiWorkerPolicySchema, RepositoryPolicySnapshotSchema } from './contracts.ts';
import { ensureMultiWorkerParentSchema } from './multi-worker-parent-store.ts';
import { WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

export const InferenceProviderSchema = v.picklist(['openai-codex', 'github-copilot']);

export const MultiWorkerBudgetSchema = v.object({
	planId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	policy: MultiWorkerPolicySchema,
	createdAt: v.string(),
	deadlineAt: v.string(),
});

const MultiWorkerBudgetAttemptObjectSchema = v.object({
	attemptId: v.pipe(v.string(), v.uuid()),
	planId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	taskId: WorkPlanTaskIdSchema,
	attemptNumber: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4)),
	provider: InferenceProviderSchema,
	status: v.picklist(['preparing', 'running', 'succeeded', 'blocked', 'blocked_pre_dispatch', 'failed_pre_dispatch', 'failed_after_dispatch']),
	modelCalls: v.union([v.literal(0), v.literal(1)]),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))),
});

export const MultiWorkerBudgetAttemptSchema = v.pipe(
	MultiWorkerBudgetAttemptObjectSchema,
	v.check((attempt) => ['preparing', 'blocked_pre_dispatch', 'failed_pre_dispatch'].includes(attempt.status) ? attempt.modelCalls === 0 : attempt.modelCalls === 1,
		'Only pre-dispatch attempt states may have zero model calls'),
	v.check((attempt) => attempt.status === 'running' ? attempt.startedAt !== undefined && attempt.finishedAt === undefined : true,
		'Running attempts require a start time and no finish time'),
	v.check((attempt) => ['succeeded', 'blocked', 'blocked_pre_dispatch', 'failed_pre_dispatch', 'failed_after_dispatch'].includes(attempt.status) ? attempt.finishedAt !== undefined : true,
		'Terminal attempts require a finish time'),
);

export type MultiWorkerBudget = v.InferOutput<typeof MultiWorkerBudgetSchema>;
export type MultiWorkerBudgetAttempt = v.InferOutput<typeof MultiWorkerBudgetAttemptSchema>;
export type InferenceProvider = v.InferOutput<typeof InferenceProviderSchema>;

export class MultiWorkerBudgetConflictError extends Error {}
export class MultiWorkerBudgetForbiddenError extends Error {}
export class MultiWorkerBudgetNotFoundError extends Error {}

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

export function ensureMultiWorkerBudgetSchema(db: Database.Database): void {
	ensureMultiWorkerParentSchema(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS multi_worker_budgets (
			plan_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, policy_json TEXT NOT NULL,
			created_at TEXT NOT NULL, deadline_at TEXT NOT NULL,
			FOREIGN KEY(plan_id) REFERENCES multi_worker_plans(id)
		);
		CREATE TABLE IF NOT EXISTS multi_worker_budget_attempts (
			id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			task_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, provider TEXT NOT NULL,
			status TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0,
			idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
			created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, reason TEXT,
			UNIQUE(owner_id, idempotency_key), UNIQUE(plan_id, task_id, attempt_number),
			FOREIGN KEY(plan_id) REFERENCES multi_worker_budgets(plan_id)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS one_active_multi_worker_attempt_per_task
			ON multi_worker_budget_attempts(plan_id, task_id)
			WHERE status IN ('preparing', 'running');
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (20, datetime('now'));
	`);
}

export class MultiWorkerBudgetStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiWorkerBudgetSchema(this.#db);
		this.#now = now;
	}

	close(): void { this.#db.close(); }

	initialize(planId: string, ownerId: string): MultiWorkerBudget {
		return this.#db.transaction(() => {
			const existing = this.#budgetRow(planId);
			if (existing) {
				if (existing.owner_id !== ownerId) throw new MultiWorkerBudgetForbiddenError('Multi-worker budget belongs to another principal');
				return this.getBudget(planId, ownerId);
			}
			const parent = this.#db.prepare(`SELECT multi_worker_plans.owner_id, jobs.policy_snapshot_json
				FROM multi_worker_plans JOIN jobs ON jobs.id = multi_worker_plans.job_id
				WHERE multi_worker_plans.id = ?`).get(planId) as { owner_id: string; policy_snapshot_json: string } | undefined;
			if (!parent) throw new MultiWorkerBudgetNotFoundError('Multi-worker plan does not exist');
			if (parent.owner_id !== ownerId) throw new MultiWorkerBudgetForbiddenError('Multi-worker plan belongs to another principal');
			const repository = v.parse(RepositoryPolicySnapshotSchema, JSON.parse(parent.policy_snapshot_json));
			if (!repository.multiWorkerPolicy?.enabled) throw new MultiWorkerBudgetConflictError('Multi-worker execution is disabled by the immutable repository policy');
			const policy = v.parse(MultiWorkerPolicySchema, repository.multiWorkerPolicy);
			const createdAt = this.#now();
			const deadlineAt = new Date(createdAt.getTime() + policy.maxRuntimeMinutes * 60_000);
			this.#db.prepare(`INSERT INTO multi_worker_budgets (plan_id, owner_id, policy_json, created_at, deadline_at)
				VALUES (?, ?, ?, ?, ?)`).run(planId, ownerId, JSON.stringify(policy), createdAt.toISOString(), deadlineAt.toISOString());
			return this.getBudget(planId, ownerId);
		}).immediate();
	}

	reserveAttempt(input: unknown, ownerId: string, idempotencyKey: string): MultiWorkerBudgetAttempt {
		const request = v.parse(v.object({
			attemptId: v.pipe(v.string(), v.uuid()), planId: v.pipe(v.string(), v.uuid()),
			taskId: WorkPlanTaskIdSchema, provider: InferenceProviderSchema,
		}), input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded idempotency key is required');
		const requestHash = hash(request);
		return this.#db.transaction(() => {
			const replay = this.#db.prepare('SELECT id, request_hash FROM multi_worker_budget_attempts WHERE owner_id = ? AND idempotency_key = ?')
				.get(ownerId, idempotencyKey) as { id: string; request_hash: string } | undefined;
			if (replay) {
				if (replay.request_hash !== requestHash) throw new MultiWorkerBudgetConflictError('Idempotency key was used for different budget input');
				return this.getAttempt(replay.id, ownerId);
			}
			const budget = this.getBudget(request.planId, ownerId);
			if (this.#now().getTime() >= Date.parse(budget.deadlineAt)) throw new MultiWorkerBudgetConflictError('Multi-worker runtime budget has expired');
			const task = this.#db.prepare(`SELECT 1 FROM multi_worker_plans, json_each(multi_worker_plans.plan_json, '$.tasks')
				WHERE multi_worker_plans.id = ? AND json_extract(json_each.value, '$.id') = ?`).get(request.planId, request.taskId);
			if (!task) throw new MultiWorkerBudgetConflictError('Task is not present in the immutable multi-worker plan');
			const totals = this.#db.prepare(`SELECT COUNT(*) AS attempts,
				SUM(CASE WHEN status IN ('preparing', 'running') THEN 1 ELSE 0 END) AS active
				FROM multi_worker_budget_attempts WHERE plan_id = ?`).get(request.planId) as { attempts: number; active: number | null };
			if (totals.attempts >= budget.policy.maxWorkerAttempts) throw new MultiWorkerBudgetConflictError('Multi-worker attempt budget is exhausted');
			if ((totals.active ?? 0) >= budget.policy.maxConcurrentWorkers) throw new MultiWorkerBudgetConflictError('Multi-worker concurrency budget is exhausted');
			const prior = this.#db.prepare(`SELECT attempt_number, status, model_calls, provider FROM multi_worker_budget_attempts
				WHERE plan_id = ? AND task_id = ? ORDER BY attempt_number DESC LIMIT 1`).get(request.planId, request.taskId) as
				{ attempt_number: number; status: string; model_calls: number; provider: string } | undefined;
			if (prior && (prior.status !== 'failed_pre_dispatch' || prior.model_calls !== 0)) {
				throw new MultiWorkerBudgetConflictError('Task cannot retry after model dispatch or a non-retryable outcome');
			}
			if (prior && prior.provider !== request.provider) throw new MultiWorkerBudgetConflictError('Task retry must preserve its selected inference provider');
			const attemptNumber = (prior?.attempt_number ?? 0) + 1;
			if (attemptNumber > budget.policy.maxPreDispatchRetriesPerTask + 1) throw new MultiWorkerBudgetConflictError('Task retry budget is exhausted');
			const createdAt = this.#now().toISOString();
			try {
				this.#db.prepare(`INSERT INTO multi_worker_budget_attempts
					(id, plan_id, owner_id, task_id, attempt_number, provider, status, model_calls, idempotency_key, request_hash, created_at)
					VALUES (?, ?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?)`).run(
					request.attemptId, request.planId, ownerId, request.taskId, attemptNumber, request.provider,
					idempotencyKey, requestHash, createdAt,
				);
			} catch (error) {
				throw new MultiWorkerBudgetConflictError(`Budget attempt conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			return this.getAttempt(request.attemptId, ownerId);
		}).immediate();
	}

	claimDispatch(attemptId: string, ownerId: string): MultiWorkerBudgetAttempt {
		return this.#db.transaction(() => {
			const attempt = this.getAttempt(attemptId, ownerId);
			if (attempt.status !== 'preparing' || attempt.modelCalls !== 0) throw new MultiWorkerBudgetConflictError('Only a preparing attempt can claim model dispatch');
			const budget = this.getBudget(attempt.planId, ownerId);
			if (this.#now().getTime() >= Date.parse(budget.deadlineAt)) throw new MultiWorkerBudgetConflictError('Multi-worker runtime budget has expired');
			const used = this.#db.prepare(`SELECT COUNT(*) AS count FROM multi_worker_budget_attempts
				WHERE plan_id = ? AND provider = ? AND model_calls = 1`).get(attempt.planId, attempt.provider) as { count: number };
			const limit = attempt.provider === 'openai-codex' ? budget.policy.subscriptionCalls.openaiCodex : budget.policy.subscriptionCalls.githubCopilot;
			if (used.count >= limit) {
				const reason = `Subscription-call budget is exhausted for ${attempt.provider}`;
				const timestamp = this.#now().toISOString();
				const changed = this.#db.prepare(`UPDATE multi_worker_budget_attempts
					SET status = 'blocked_pre_dispatch', finished_at = ?, reason = ?
					WHERE id = ? AND owner_id = ? AND status = 'preparing' AND model_calls = 0`)
					.run(timestamp, reason, attemptId, ownerId);
				if (changed.changes !== 1) throw new MultiWorkerBudgetConflictError('Provider-budget block was settled concurrently');
				return this.getAttempt(attemptId, ownerId);
			}
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare(`UPDATE multi_worker_budget_attempts SET status = 'running', model_calls = 1, started_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'preparing' AND model_calls = 0`).run(timestamp, attemptId, ownerId);
			if (changed.changes !== 1) throw new MultiWorkerBudgetConflictError('Model dispatch was claimed concurrently');
			return this.getAttempt(attemptId, ownerId);
		}).immediate();
	}

	settlePreDispatchFailure(attemptId: string, ownerId: string, reason: string): MultiWorkerBudgetAttempt {
		return this.#settle(attemptId, ownerId, 'preparing', 0, 'failed_pre_dispatch', reason);
	}

	settleAfterDispatch(attemptId: string, ownerId: string, status: 'succeeded' | 'blocked' | 'failed_after_dispatch', reason?: string): MultiWorkerBudgetAttempt {
		return this.#settle(attemptId, ownerId, 'running', 1, status, reason);
	}

	getBudget(planId: string, ownerId: string): MultiWorkerBudget {
		const row = this.#budgetRow(planId);
		if (!row) throw new MultiWorkerBudgetNotFoundError('Multi-worker budget does not exist');
		if (row.owner_id !== ownerId) throw new MultiWorkerBudgetForbiddenError('Multi-worker budget belongs to another principal');
		return v.parse(MultiWorkerBudgetSchema, {
			planId: row.plan_id, ownerId: row.owner_id, policy: JSON.parse(row.policy_json as string),
			createdAt: row.created_at, deadlineAt: row.deadline_at,
		});
	}

	getAttempt(attemptId: string, ownerId: string): MultiWorkerBudgetAttempt {
		const row = this.#db.prepare('SELECT * FROM multi_worker_budget_attempts WHERE id = ?').get(attemptId) as Record<string, unknown> | undefined;
		if (!row) throw new MultiWorkerBudgetNotFoundError('Multi-worker budget attempt does not exist');
		if (row.owner_id !== ownerId) throw new MultiWorkerBudgetForbiddenError('Multi-worker budget attempt belongs to another principal');
		return v.parse(MultiWorkerBudgetAttemptSchema, {
			attemptId: row.id, planId: row.plan_id, ownerId: row.owner_id, taskId: row.task_id,
			attemptNumber: row.attempt_number, provider: row.provider, status: row.status,
			modelCalls: row.model_calls, createdAt: row.created_at, startedAt: row.started_at ?? undefined,
			finishedAt: row.finished_at ?? undefined, reason: row.reason ?? undefined,
		});
	}

	#budgetRow(planId: string): Record<string, unknown> | undefined {
		return this.#db.prepare('SELECT * FROM multi_worker_budgets WHERE plan_id = ?').get(planId) as Record<string, unknown> | undefined;
	}

	#settle(attemptId: string, ownerId: string, expectedStatus: string, expectedCalls: number, status: string, reason?: string): MultiWorkerBudgetAttempt {
		if (reason !== undefined) v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)), reason);
		return this.#db.transaction(() => {
			const attempt = this.getAttempt(attemptId, ownerId);
			if (attempt.status !== expectedStatus || attempt.modelCalls !== expectedCalls) throw new MultiWorkerBudgetConflictError('Budget attempt cannot settle from its current state');
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare(`UPDATE multi_worker_budget_attempts SET status = ?, finished_at = ?, reason = ?
				WHERE id = ? AND owner_id = ? AND status = ? AND model_calls = ?`).run(status, timestamp, reason ?? null, attemptId, ownerId, expectedStatus, expectedCalls);
			if (changed.changes !== 1) throw new MultiWorkerBudgetConflictError('Budget attempt was settled concurrently');
			return this.getAttempt(attemptId, ownerId);
		}).immediate();
	}
}
