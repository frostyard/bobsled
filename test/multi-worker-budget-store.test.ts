import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { JobLedger } from '../src/control-plane/ledger.ts';
import {
	MultiWorkerBudgetConflictError,
	MultiWorkerBudgetForbiddenError,
	MultiWorkerBudgetStore,
} from '../src/control-plane/multi-worker-budget-store.ts';
import { MultiWorkerParentStore } from '../src/control-plane/multi-worker-parent-store.ts';
import { MultiWorkerScheduler } from '../src/control-plane/multi-worker-scheduler.ts';
import { MultiWorkerOperatorStore } from '../src/control-plane/multi-worker-operator-view.ts';

const ownerId = 'operator';

function fixture(overrides: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-m5-budget-'));
	const path = join(root, 'ledger.db');
	const ledger = new JobLedger(path);
	const run = ledger.admit({
		repositoryId: 'frostyard/clix',
		workItem: { source: 'manual', key: 'budget', title: 'Budgeted fan-out', body: '', labels: [] },
	}, { id: ownerId }, 'admit');
	ledger.close();
	const jobId = run.jobs[0]?.id;
	assert.ok(jobId);
	const db = new Database(path);
	const row = db.prepare('SELECT policy_snapshot_json FROM jobs WHERE id = ?').get(jobId) as { policy_snapshot_json: string };
	const repository = JSON.parse(row.policy_snapshot_json) as Record<string, unknown>;
	repository.multiWorkerPolicy = {
		enabled: true,
		maxConcurrentWorkers: 2,
		maxWorkerAttempts: 4,
		maxPreDispatchRetriesPerTask: 1,
		maxRuntimeMinutes: 60,
		subscriptionCalls: { openaiCodex: 3, githubCopilot: 1 },
		...overrides,
	};
	db.prepare('UPDATE jobs SET policy_snapshot_json = ? WHERE id = ?').run(JSON.stringify(repository), jobId);
	db.close();
	const parents = new MultiWorkerParentStore(path);
	const planId = randomUUID();
	parents.recordPlan({
		planId, jobId, baseCommit: 'a'.repeat(40),
		plan: {
			version: 2, summary: 'Two independent workers.', assumptions: [], risks: [],
			tasks: [
				{ id: 'api', title: 'API', objective: 'Build API.', acceptanceCriteria: ['API passes.'], dependsOn: [], fileScopes: [{ kind: 'directory', path: 'src/api' }] },
				{ id: 'ui', title: 'UI', objective: 'Build UI.', acceptanceCriteria: ['UI passes.'], dependsOn: [], fileScopes: [{ kind: 'directory', path: 'src/ui' }] },
				{ id: 'integration', title: 'Integration', objective: 'Join API and UI.', acceptanceCriteria: ['Integration passes.'], dependsOn: ['api', 'ui'], fileScopes: [{ kind: 'directory', path: 'src/integration' }] },
			],
		},
	}, ownerId, 'plan');
	parents.close();
	return { path, planId };
}

test('snapshots the immutable repository budget and bounds concurrent workspace attempts', () => {
	const value = fixture({ maxConcurrentWorkers: 1 });
	const first = new MultiWorkerBudgetStore(value.path);
	const second = new MultiWorkerBudgetStore(value.path);
	try {
		const budget = first.initialize(value.planId, ownerId);
		assert.equal(budget.policy.maxConcurrentWorkers, 1);
		const api = first.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'api-1');
		assert.equal(api.status, 'preparing');
		assert.throws(() => second.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'ui', provider: 'openai-codex' }, ownerId, 'ui-1'), MultiWorkerBudgetConflictError);
		first.settlePreDispatchFailure(api.attemptId, ownerId, 'workspace preparation failed');
		assert.equal(second.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'ui', provider: 'openai-codex' }, ownerId, 'ui-1').status, 'preparing');
	} finally { first.close(); second.close(); }
});

test('distinguishes a new reservation from an idempotent cross-process replay', () => {
	const value = fixture();
	const first = new MultiWorkerBudgetStore(value.path);
	const second = new MultiWorkerBudgetStore(value.path);
	try {
		first.initialize(value.planId, ownerId);
		const request = { attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' };
		assert.equal(first.reserveAttemptClaim(request, ownerId, 'shared').newlyReserved, true);
		assert.equal(second.reserveAttemptClaim(request, ownerId, 'shared').newlyReserved, false);
	} finally { first.close(); second.close(); }
});

test('schedules only dependency-ready tasks within concurrency and converges on replay', () => {
	const value = fixture();
	const parents = new MultiWorkerParentStore(value.path);
	const budgets = new MultiWorkerBudgetStore(value.path);
	const scheduler = new MultiWorkerScheduler(parents, budgets);
	try {
		const first = scheduler.schedule(value.planId, ownerId);
		assert.equal(first.status, 'scheduled');
		assert.deepEqual(first.scheduled.map(({ taskId }) => taskId), ['api', 'ui']);
		assert.deepEqual(first.tasks.map(({ state }) => state), ['preparing', 'preparing', 'queued']);
		assert.equal(first.executionAuthorized, false);
		assert.equal(first.modelDispatchAuthorized, false);
		const replay = scheduler.schedule(value.planId, ownerId);
		assert.equal(replay.status, 'waiting');
		assert.equal(replay.scheduled.length, 0);
		assert.equal(budgets.listAttempts(value.planId, ownerId).length, 2);
	} finally { budgets.close(); parents.close(); }
});

test('unlocks dependent work only after every prerequisite succeeds', () => {
	const value = fixture();
	const parents = new MultiWorkerParentStore(value.path);
	const budgets = new MultiWorkerBudgetStore(value.path);
	const scheduler = new MultiWorkerScheduler(parents, budgets);
	try {
		const roots = scheduler.schedule(value.planId, ownerId).scheduled;
		for (const attempt of roots) {
			budgets.claimDispatch(attempt.attemptId, ownerId);
			budgets.settleAfterDispatch(attempt.attemptId, ownerId, 'succeeded');
		}
		const integration = scheduler.schedule(value.planId, ownerId);
		assert.deepEqual(integration.scheduled.map(({ taskId }) => taskId), ['integration']);
		assert.deepEqual(integration.tasks.map(({ state }) => state), ['succeeded', 'succeeded', 'preparing']);
	} finally { budgets.close(); parents.close(); }
});

test('projects terminal prerequisite failure without scheduling descendants', () => {
	const value = fixture();
	const parents = new MultiWorkerParentStore(value.path);
	const budgets = new MultiWorkerBudgetStore(value.path);
	const scheduler = new MultiWorkerScheduler(parents, budgets);
	try {
		const roots = scheduler.schedule(value.planId, ownerId).scheduled;
		for (const attempt of roots) {
			budgets.claimDispatch(attempt.attemptId, ownerId);
			budgets.settleAfterDispatch(attempt.attemptId, ownerId, attempt.taskId === 'api' ? 'blocked' : 'succeeded', attempt.taskId === 'api' ? 'scope violation' : undefined);
		}
		const result = scheduler.schedule(value.planId, ownerId);
		assert.equal(result.status, 'blocked');
		assert.equal(result.scheduled.length, 0);
		assert.deepEqual(result.tasks.map(({ state }) => state), ['blocked', 'succeeded', 'blocked']);
		assert.match(result.tasks[2]?.reason ?? '', /Dependency api/);
	} finally { budgets.close(); parents.close(); }
});

test('projects disabled and exhausted policies as terminal scheduler evidence', () => {
	const disabled = fixture({ enabled: false });
	const disabledParents = new MultiWorkerParentStore(disabled.path);
	const disabledBudgets = new MultiWorkerBudgetStore(disabled.path);
	try {
		const result = new MultiWorkerScheduler(disabledParents, disabledBudgets).schedule(disabled.planId, ownerId);
		assert.equal(result.status, 'blocked');
		assert.equal(result.scheduled.length, 0);
		assert.ok(result.tasks.every(({ state }) => state === 'blocked'));
		assert.match(result.reasons[0] ?? '', /disabled/);
	} finally { disabledBudgets.close(); disabledParents.close(); }

	const exhausted = fixture({ maxPreDispatchRetriesPerTask: 0 });
	const parents = new MultiWorkerParentStore(exhausted.path);
	const budgets = new MultiWorkerBudgetStore(exhausted.path);
	const scheduler = new MultiWorkerScheduler(parents, budgets);
	try {
		const api = scheduler.schedule(exhausted.planId, ownerId).scheduled.find(({ taskId }) => taskId === 'api');
		assert.ok(api);
		budgets.settlePreDispatchFailure(api.attemptId, ownerId, 'workspace failed');
		const result = scheduler.schedule(exhausted.planId, ownerId);
		assert.equal(result.status, 'waiting');
		assert.equal(result.tasks.find(({ taskId }) => taskId === 'api')?.state, 'blocked');
		assert.equal(result.tasks.find(({ taskId }) => taskId === 'integration')?.state, 'blocked');
		assert.match(result.reasons[0] ?? '', /retry budget is exhausted/);
	} finally { budgets.close(); parents.close(); }
});

test('schedules a same-provider retry only after zero-call pre-dispatch failure', () => {
	const value = fixture();
	const parents = new MultiWorkerParentStore(value.path);
	const budgets = new MultiWorkerBudgetStore(value.path);
	const scheduler = new MultiWorkerScheduler(parents, budgets);
	try {
		const api = scheduler.schedule(value.planId, ownerId).scheduled.find(({ taskId }) => taskId === 'api');
		assert.ok(api);
		budgets.settlePreDispatchFailure(api.attemptId, ownerId, 'workspace failed');
		const retry = scheduler.schedule(value.planId, ownerId).scheduled;
		assert.deepEqual(retry.map(({ taskId, attemptNumber }) => [taskId, attemptNumber]), [['api', 2]]);
	} finally { budgets.close(); parents.close(); }
});

test('consumes provider allowance atomically and forbids retries after dispatch', () => {
	const value = fixture({ subscriptionCalls: { openaiCodex: 1, githubCopilot: 1 } });
	const first = new MultiWorkerBudgetStore(value.path);
	const second = new MultiWorkerBudgetStore(value.path);
	try {
		first.initialize(value.planId, ownerId);
		const api = first.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'api-1');
		assert.equal(first.claimDispatch(api.attemptId, ownerId).modelCalls, 1);
		assert.throws(() => second.claimDispatch(api.attemptId, ownerId), MultiWorkerBudgetConflictError);
		first.settleAfterDispatch(api.attemptId, ownerId, 'failed_after_dispatch', 'provider result was ambiguous');
		assert.throws(() => first.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'api-2'), MultiWorkerBudgetConflictError);
		const ui = first.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'ui', provider: 'openai-codex' }, ownerId, 'ui-1');
		const blocked = first.claimDispatch(ui.attemptId, ownerId);
		assert.equal(blocked.status, 'blocked_pre_dispatch');
		assert.equal(blocked.modelCalls, 0);
		assert.match(blocked.reason ?? '', /Subscription-call budget is exhausted/);
	} finally { first.close(); second.close(); }
});

test('allows only bounded zero-call retries', () => {
	const value = fixture();
	const store = new MultiWorkerBudgetStore(value.path);
	try {
		store.initialize(value.planId, ownerId);
		const first = store.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'api-1');
		store.settlePreDispatchFailure(first.attemptId, ownerId, 'checkout failed');
		const retry = store.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'api-2');
		assert.equal(retry.attemptNumber, 2);
		store.settlePreDispatchFailure(retry.attemptId, ownerId, 'checkout failed again');
		assert.throws(() => store.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'api-3'), /retry budget is exhausted/);
		assert.throws(() => store.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'github-copilot' }, ownerId, 'api-other-provider'), /preserve its selected inference provider|retry budget is exhausted/);
	} finally { store.close(); }
});

test('fails closed when policy is disabled, deadline expires, task is unknown, or principal differs', () => {
	const disabled = fixture({ enabled: false });
	const disabledStore = new MultiWorkerBudgetStore(disabled.path);
	assert.throws(() => disabledStore.initialize(disabled.planId, ownerId), /disabled/);
	disabledStore.close();

	let now = new Date('2026-09-03T00:00:00.000Z');
	const value = fixture({ maxRuntimeMinutes: 1 });
	const store = new MultiWorkerBudgetStore(value.path, () => now);
	try {
		store.initialize(value.planId, ownerId);
		assert.throws(() => store.getBudget(value.planId, 'another-user'), MultiWorkerBudgetForbiddenError);
		assert.throws(() => store.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'missing', provider: 'openai-codex' }, ownerId, 'missing'), /not present/);
		now = new Date('2026-09-03T00:01:00.000Z');
		assert.throws(() => store.reserveAttempt({ attemptId: randomUUID(), planId: value.planId, taskId: 'api', provider: 'openai-codex' }, ownerId, 'expired'), /expired/);
	} finally { store.close(); }
});

test('projects active fan-out and provider exhaustion without reserving or dispatching work', () => {
	const value = fixture({ subscriptionCalls: { openaiCodex: 1, githubCopilot: 0 } });
	const parents = new MultiWorkerParentStore(value.path);
	const budgets = new MultiWorkerBudgetStore(value.path);
	const operator = new MultiWorkerOperatorStore(value.path);
	try {
		const scheduled = new MultiWorkerScheduler(parents, budgets).schedule(value.planId, ownerId).scheduled;
		assert.equal(scheduled.length, 2);
		const first = budgets.claimDispatch(scheduled[0]!.attemptId, ownerId);
		assert.equal(first.status, 'running');
		const exhausted = budgets.claimDispatch(scheduled[1]!.attemptId, ownerId);
		assert.equal(exhausted.status, 'blocked_pre_dispatch');

		const active = operator.list(ownerId)[0];
		assert.equal(active?.status, 'active');
		assert.equal(active?.activeWorkers, 1);
		assert.equal(active?.budget.openaiCodexCallsUsed, 1);
		assert.equal(active?.budget.openaiCodexCallsMax, 1);
		assert.equal(active?.tasks.find(({ taskId }) => taskId === exhausted.taskId)?.state, 'blocked');
		assert.match(active?.reasons[0] ?? '', /Subscription-call budget is exhausted/);
		assert.equal(budgets.listAttempts(value.planId, ownerId).length, 2, 'operator reads must not reserve attempts');

		budgets.settleAfterDispatch(first.attemptId, ownerId, 'succeeded');
		const blocked = operator.list(ownerId)[0];
		assert.equal(blocked?.status, 'blocked');
		assert.equal(blocked?.activeWorkers, 0);
		assert.equal(blocked?.tasks.find(({ taskId }) => taskId === 'integration')?.state, 'blocked');
		assert.equal(operator.list('another-user').length, 0);
	} finally { operator.close(); budgets.close(); parents.close(); }
});
