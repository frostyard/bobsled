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
		subscriptionCalls: { openaiCodex: 1, githubCopilot: 1 },
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

test('consumes provider allowance atomically and forbids retries after dispatch', () => {
	const value = fixture();
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
