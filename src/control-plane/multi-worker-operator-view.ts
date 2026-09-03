import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { MultiWorkerPolicySchema, RepositoryPolicySnapshotSchema } from './contracts.ts';
import { ensureMultiWorkerBudgetSchema, MultiWorkerBudgetAttemptSchema } from './multi-worker-budget-store.ts';
import { MultiWorkerPlanV2Schema, WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

export const MultiWorkerOperatorTaskSchema = v.object({
	taskId: WorkPlanTaskIdSchema,
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	state: v.picklist(['queued', 'ready', 'preparing', 'running', 'retryable', 'succeeded', 'blocked']),
	attemptNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4))),
	provider: v.optional(v.picklist(['openai-codex', 'github-copilot'])),
	reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))),
});

export const MultiWorkerOperatorEvidenceSchema = v.object({
	planId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	status: v.picklist(['not_started', 'active', 'waiting', 'blocked', 'complete', 'expired']),
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	activeWorkers: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(16)),
	tasksSucceeded: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(32)),
	tasksTotal: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32)),
	budget: v.object({
		initialized: v.boolean(),
		attemptsUsed: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
		attemptsMax: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(128)),
		concurrentUsed: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(16)),
		concurrentMax: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)),
		openaiCodexCallsUsed: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
		openaiCodexCallsMax: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
		githubCopilotCallsUsed: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
		githubCopilotCallsMax: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
		deadlineAt: v.optional(v.string()),
	}),
	tasks: v.pipe(v.array(MultiWorkerOperatorTaskSchema), v.minLength(1), v.maxLength(32)),
	reasons: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))), v.maxLength(32)),
	updatedAt: v.string(),
	executionAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
});

export type MultiWorkerOperatorEvidence = v.InferOutput<typeof MultiWorkerOperatorEvidenceSchema>;

function latestByTask(attempts: v.InferOutput<typeof MultiWorkerBudgetAttemptSchema>[]) {
	const latest = new Map<string, v.InferOutput<typeof MultiWorkerBudgetAttemptSchema>>();
	for (const attempt of attempts) latest.set(attempt.taskId, attempt);
	return latest;
}

export class MultiWorkerOperatorStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		this.#db = path === ':memory:' ? new Database(path) : new Database(path, { readonly: true, fileMustExist: true });
		this.#db.pragma('busy_timeout = 5000');
		if (path === ':memory:') {
			this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
			ensureMultiWorkerBudgetSchema(this.#db);
		}
		this.#now = now;
	}

	close(): void { this.#db.close(); }

	list(ownerId: string): MultiWorkerOperatorEvidence[] {
		if (!ownerId || ownerId.length > 500) throw new Error('A bounded operator principal is required');
		const rows = this.#db.prepare(`SELECT multi_worker_plans.*, jobs.policy_snapshot_json
			FROM multi_worker_plans JOIN jobs ON jobs.id = multi_worker_plans.job_id
			WHERE multi_worker_plans.owner_id = ? ORDER BY multi_worker_plans.created_at, multi_worker_plans.id`).all(ownerId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.#project(row, ownerId));
	}

	#project(row: Record<string, unknown>, ownerId: string): MultiWorkerOperatorEvidence {
		const plan = v.parse(MultiWorkerPlanV2Schema, JSON.parse(row.plan_json as string));
		const repository = v.parse(RepositoryPolicySnapshotSchema, JSON.parse(row.policy_snapshot_json as string));
		const policy = v.parse(MultiWorkerPolicySchema, repository.multiWorkerPolicy ?? {
			enabled: false, maxConcurrentWorkers: 1, maxWorkerAttempts: 1, maxPreDispatchRetriesPerTask: 0,
			maxRuntimeMinutes: 1, subscriptionCalls: { openaiCodex: 0, githubCopilot: 0 },
		});
		const budgetRow = this.#db.prepare('SELECT * FROM multi_worker_budgets WHERE plan_id = ? AND owner_id = ?')
			.get(row.id, ownerId) as Record<string, unknown> | undefined;
		const attemptRows = budgetRow ? this.#db.prepare(`SELECT * FROM multi_worker_budget_attempts
			WHERE plan_id = ? AND owner_id = ? ORDER BY attempt_number, created_at`).all(row.id, ownerId) as Array<Record<string, unknown>> : [];
		const attempts = attemptRows.map((attempt) => v.parse(MultiWorkerBudgetAttemptSchema, {
			attemptId: attempt.id, planId: attempt.plan_id, ownerId: attempt.owner_id, taskId: attempt.task_id,
			attemptNumber: attempt.attempt_number, provider: attempt.provider, status: attempt.status,
			modelCalls: attempt.model_calls, createdAt: attempt.created_at, startedAt: attempt.started_at ?? undefined,
			finishedAt: attempt.finished_at ?? undefined, reason: attempt.reason ?? undefined,
		}));
		const latest = latestByTask(attempts);
		const terminalBlock = (status?: string) => ['blocked', 'blocked_pre_dispatch', 'failed_after_dispatch'].includes(status ?? '');
		const blockedTasks = new Set(plan.tasks.filter((task) => terminalBlock(latest.get(task.id)?.status)).map(({ id }) => id));
		let changed = true;
		while (changed) {
			changed = false;
			for (const task of plan.tasks) if (!blockedTasks.has(task.id) && task.dependsOn.some((id) => blockedTasks.has(id))) {
				blockedTasks.add(task.id); changed = true;
			}
		}
		const tasks = plan.tasks.map((task) => {
			const attempt = latest.get(task.id);
			const blockedDependency = task.dependsOn.find((id) => blockedTasks.has(id));
			if (blockedDependency) return { taskId: task.id, title: task.title, state: 'blocked' as const, reason: `Dependency ${blockedDependency} cannot continue` };
			if (!attempt) return {
				taskId: task.id, title: task.title,
				state: task.dependsOn.every((id) => latest.get(id)?.status === 'succeeded') ? 'ready' as const : 'queued' as const,
			};
			if (attempt.status === 'failed_pre_dispatch') {
				const retryable = attempt.attemptNumber <= policy.maxPreDispatchRetriesPerTask;
				return { taskId: task.id, title: task.title, state: retryable ? 'retryable' as const : 'blocked' as const,
					attemptNumber: attempt.attemptNumber, provider: attempt.provider,
					reason: retryable ? attempt.reason : 'Pre-dispatch retry budget is exhausted' };
			}
			if (terminalBlock(attempt.status)) return { taskId: task.id, title: task.title, state: 'blocked' as const,
				attemptNumber: attempt.attemptNumber, provider: attempt.provider, reason: attempt.reason ?? 'Task reached a non-retryable terminal state' };
			return { taskId: task.id, title: task.title, state: attempt.status, attemptNumber: attempt.attemptNumber, provider: attempt.provider };
		});
		const activeWorkers = attempts.filter(({ status }) => status === 'preparing' || status === 'running').length;
		const tasksSucceeded = tasks.filter(({ state }) => state === 'succeeded').length;
		const deadlineAt = budgetRow?.deadline_at as string | undefined;
		const expired = deadlineAt ? this.#now().getTime() >= Date.parse(deadlineAt) : false;
		const reasons = [...new Set(tasks.filter(({ state, reason }) => state === 'blocked' && reason).map(({ reason }) => reason as string))];
		if (!policy.enabled) reasons.unshift('Multi-worker execution is disabled by repository policy');
		if (expired) reasons.unshift('Multi-worker runtime budget has expired');
		const attemptBudgetExhausted = attempts.length >= policy.maxWorkerAttempts && tasksSucceeded !== tasks.length;
		if (attemptBudgetExhausted) reasons.unshift('Multi-worker attempt budget is exhausted');
		const status = !budgetRow ? (policy.enabled ? 'not_started' : 'blocked')
			: expired && tasksSucceeded !== tasks.length ? 'expired'
				: tasksSucceeded === tasks.length ? 'complete'
					: activeWorkers > 0 ? 'active'
						: tasks.some(({ state }) => state === 'blocked') || attemptBudgetExhausted ? 'blocked' : 'waiting';
		const summary = status === 'active' ? `${activeWorkers} worker${activeWorkers === 1 ? '' : 's'} active; ${tasksSucceeded}/${tasks.length} tasks succeeded.`
			: status === 'complete' ? `All ${tasks.length} worker tasks succeeded.`
				: status === 'expired' ? 'The plan runtime budget expired before all tasks completed.'
					: status === 'blocked' ? (reasons[0] ?? 'The multi-worker plan cannot continue.')
						: status === 'not_started' ? 'The multi-worker plan is recorded but its budget has not been initialized.'
							: `${tasksSucceeded}/${tasks.length} tasks succeeded; no worker is currently active.`;
		const updatedAt = attempts.map(({ finishedAt, startedAt, createdAt }) => finishedAt ?? startedAt ?? createdAt)
			.concat(String(row.created_at)).sort().at(-1) as string;
		return v.parse(MultiWorkerOperatorEvidenceSchema, {
			planId: row.id, jobId: row.job_id, status, summary, activeWorkers, tasksSucceeded, tasksTotal: tasks.length,
			budget: {
				initialized: Boolean(budgetRow), attemptsUsed: attempts.length, attemptsMax: policy.maxWorkerAttempts,
				concurrentUsed: activeWorkers, concurrentMax: policy.maxConcurrentWorkers,
				openaiCodexCallsUsed: attempts.filter(({ provider, modelCalls }) => provider === 'openai-codex' && modelCalls === 1).length,
				openaiCodexCallsMax: policy.subscriptionCalls.openaiCodex,
				githubCopilotCallsUsed: attempts.filter(({ provider, modelCalls }) => provider === 'github-copilot' && modelCalls === 1).length,
				githubCopilotCallsMax: policy.subscriptionCalls.githubCopilot,
				...(deadlineAt ? { deadlineAt } : {}),
			},
			tasks, reasons, updatedAt, executionAuthorized: false, modelDispatchAuthorized: false,
		});
	}
}
