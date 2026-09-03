import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { InferenceProviderSchema, MultiWorkerBudgetConflictError, MultiWorkerBudgetStore } from './multi-worker-budget-store.ts';
import { MultiWorkerParentStore } from './multi-worker-parent-store.ts';
import { WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const ScheduledAttemptSchema = v.object({
	attemptId: v.pipe(v.string(), v.uuid()),
	taskId: WorkPlanTaskIdSchema,
	attemptNumber: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4)),
	provider: InferenceProviderSchema,
	status: v.literal('preparing'),
	modelCalls: v.literal(0),
});

export const MultiWorkerScheduleTaskSchema = v.object({
	taskId: WorkPlanTaskIdSchema,
	state: v.picklist(['queued', 'ready', 'preparing', 'running', 'retryable', 'succeeded', 'blocked']),
	reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))),
});

export const MultiWorkerScheduleResultSchema = v.object({
	planId: v.pipe(v.string(), v.uuid()),
	status: v.picklist(['scheduled', 'waiting', 'blocked', 'complete']),
	tasks: v.pipe(v.array(MultiWorkerScheduleTaskSchema), v.minLength(1), v.maxLength(32)),
	scheduled: v.pipe(v.array(ScheduledAttemptSchema), v.maxLength(16)),
	reasons: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2_000))), v.maxLength(32)),
	executionAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
});

export type MultiWorkerScheduleResult = v.InferOutput<typeof MultiWorkerScheduleResultSchema>;

function deterministicAttemptId(planId: string, taskId: string, attemptNumber: number): string {
	const hex = createHash('sha256').update(`${planId}\0${taskId}\0${attemptNumber}`).digest('hex');
	const variant = (8 + (Number.parseInt(hex[16] ?? '0', 16) % 4)).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class MultiWorkerScheduler {
	readonly #parents: MultiWorkerParentStore;
	readonly #budgets: MultiWorkerBudgetStore;

	constructor(parents: MultiWorkerParentStore, budgets: MultiWorkerBudgetStore) {
		this.#parents = parents;
		this.#budgets = budgets;
	}

	schedule(planId: string, ownerId: string): MultiWorkerScheduleResult {
		const plan = this.#parents.getPlan(planId, ownerId);
		let budget;
		try {
			budget = this.#budgets.initialize(planId, ownerId);
		} catch (error) {
			if (!(error instanceof MultiWorkerBudgetConflictError)) throw error;
			return v.parse(MultiWorkerScheduleResultSchema, {
				planId, status: 'blocked',
				tasks: plan.plan.tasks.map((task) => ({ taskId: task.id, state: 'blocked', reason: error.message })),
				scheduled: [], reasons: [error.message], executionAuthorized: false, modelDispatchAuthorized: false,
			});
		}
		let attempts = this.#budgets.listAttempts(planId, ownerId);
		const latest = () => new Map(plan.plan.tasks.map((task) => [
			task.id,
			attempts.filter((attempt) => attempt.taskId === task.id).at(-1),
		]));
		const terminalBlock = (status: string | undefined) => ['blocked', 'blocked_pre_dispatch', 'failed_after_dispatch'].includes(status ?? '');
		const reasons: string[] = [];
		const schedulerBlocks = new Map<string, string>();
		const scheduled = [];

		for (const task of plan.plan.tasks) {
			const byTask = latest();
			const current = byTask.get(task.id);
			if (current && current.status !== 'failed_pre_dispatch') continue;
			const blockedDependency = task.dependsOn.find((dependency) => terminalBlock(byTask.get(dependency)?.status));
			if (blockedDependency) continue;
			if (!task.dependsOn.every((dependency) => byTask.get(dependency)?.status === 'succeeded')) continue;
			const active = attempts.filter((attempt) => ['preparing', 'running'].includes(attempt.status)).length;
			if (active >= budget.policy.maxConcurrentWorkers) break;
			const nextAttempt = (current?.attemptNumber ?? 0) + 1;
			const attemptId = deterministicAttemptId(planId, task.id, nextAttempt);
			try {
				const claim = this.#budgets.reserveAttemptClaim({
					attemptId, planId, taskId: task.id, provider: 'openai-codex',
				}, ownerId, `scheduler:${planId}:${task.id}:${nextAttempt}`);
				if (claim.newlyReserved) {
					const reserved = claim.attempt;
					scheduled.push({
						attemptId: reserved.attemptId, taskId: reserved.taskId, attemptNumber: reserved.attemptNumber,
						provider: reserved.provider, status: reserved.status, modelCalls: reserved.modelCalls,
					});
				}
				attempts = this.#budgets.listAttempts(planId, ownerId);
			} catch (error) {
				if (!(error instanceof MultiWorkerBudgetConflictError)) throw error;
				reasons.push(`${task.id}: ${error.message}`);
				if (!/concurrency budget is exhausted/.test(error.message)) schedulerBlocks.set(task.id, error.message);
				attempts = this.#budgets.listAttempts(planId, ownerId);
				break;
			}
		}

		const byTask = latest();
		const blockedTasks = new Set(plan.plan.tasks
			.filter((task) => terminalBlock(byTask.get(task.id)?.status) || schedulerBlocks.has(task.id))
			.map(({ id }) => id));
		let changed = true;
		while (changed) {
			changed = false;
			for (const task of plan.plan.tasks) {
				if (!blockedTasks.has(task.id) && task.dependsOn.some((dependency) => blockedTasks.has(dependency))) {
					blockedTasks.add(task.id);
					changed = true;
				}
			}
		}
		const tasks = plan.plan.tasks.map((task) => {
			const current = byTask.get(task.id);
			const schedulerBlock = schedulerBlocks.get(task.id);
			if (schedulerBlock) return { taskId: task.id, state: 'blocked' as const, reason: schedulerBlock };
			const blockedDependency = task.dependsOn.find((dependency) => blockedTasks.has(dependency));
			if (blockedDependency) return { taskId: task.id, state: 'blocked' as const, reason: `Dependency ${blockedDependency} cannot continue` };
			if (!current) {
				const ready = task.dependsOn.every((dependency) => byTask.get(dependency)?.status === 'succeeded');
				return { taskId: task.id, state: ready ? 'ready' as const : 'queued' as const };
			}
			if (current.status === 'failed_pre_dispatch') return { taskId: task.id, state: 'retryable' as const, reason: current.reason };
			if (terminalBlock(current.status)) return { taskId: task.id, state: 'blocked' as const, reason: current.reason ?? 'Task reached a non-retryable terminal state' };
			return { taskId: task.id, state: current.status };
		});
		const status = tasks.every(({ state }) => state === 'succeeded') ? 'complete'
			: tasks.some(({ state }) => state === 'blocked') && !tasks.some(({ state }) => state === 'preparing' || state === 'running') ? 'blocked'
				: scheduled.length > 0 ? 'scheduled' : 'waiting';
		return v.parse(MultiWorkerScheduleResultSchema, {
			planId, status, tasks, scheduled, reasons,
			executionAuthorized: false, modelDispatchAuthorized: false,
		});
	}
}
