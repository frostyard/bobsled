import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { projectOperatorBoard, projectRunForBoard } from '../src/control-plane/operator-board-view.ts';

const principal = { id: 'operator:board-test' };
const workItem = { source: 'manual' as const, key: 'manual:board', title: 'Exercise the board', body: 'Keep operator state obvious.', labels: [] };
const needsSpec = {
	route: 'needs_spec' as const, risk: 'low' as const, confidence: 0.9,
	summary: 'The task needs one decision.', rationale: 'Expected behavior is not yet explicit.',
	acceptanceCriteria: ['Record the decision.'], missingInformation: ['Which behavior is intended?'],
	suggestedLabels: ['bobsled:needs-spec' as const], eligibleForOneClick: false,
};

test('board projection gives ready work an obvious primary action', () => {
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-02T16:00:00.000Z'));
	try {
		const run = ledger.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'ready');
		const card = projectRunForBoard(run);
		assert.equal(card.lane, 'ready');
		assert.equal(card.phase, 'ready to start');
		assert.deepEqual(card.actions.map(({ kind }) => kind), ['go_fix', 'cancel']);
	} finally { ledger.close(); }
});

test('human-gated work is attention, while cancelled work moves to history', () => {
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-02T16:00:00.000Z'));
	try {
		const blocked = ledger.admit({ repositoryId: 'frostyard/clix', workItem, triageDecision: needsSpec }, principal, 'blocked');
		const ready = ledger.admit({ repositoryId: 'frostyard/clix', workItem: { ...workItem, key: 'manual:cancelled' } }, principal, 'cancelled');
		const cancelled = ledger.cancel(ready.id, { expectedVersion: ready.version, reason: 'Archive this test run.' }, principal);
		const view = projectOperatorBoard([blocked, cancelled], [], new Date('2026-09-02T16:01:00.000Z'));
		assert.equal(view.cards.find(({ id }) => id === blocked.id)?.lane, 'attention');
		assert.equal(view.cards.find(({ id }) => id === blocked.id)?.actions[0]?.kind, 'human_override');
		assert.equal(view.cards.find(({ id }) => id === cancelled.id)?.lane, 'history');
	} finally { ledger.close(); }
});

test('multi-worker evidence controls active and exhausted board states without adding actions', () => {
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-03T03:00:00.000Z'));
	try {
		const run = ledger.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'fanout');
		const jobId = run.jobs[0]!.id;
		const base = {
			planId: '11111111-1111-4111-8111-111111111111', jobId,
			activeWorkers: 2, tasksSucceeded: 0, tasksTotal: 3,
			budget: { initialized: true, attemptsUsed: 2, attemptsMax: 4, concurrentUsed: 2, concurrentMax: 2,
				openaiCodexCallsUsed: 2, openaiCodexCallsMax: 3, githubCopilotCallsUsed: 0, githubCopilotCallsMax: 1,
				deadlineAt: '2026-09-03T04:00:00.000Z' },
			tasks: [
				{ taskId: 'api', title: 'API', state: 'running' as const, attemptNumber: 1, provider: 'openai-codex' as const },
				{ taskId: 'ui', title: 'UI', state: 'running' as const, attemptNumber: 1, provider: 'openai-codex' as const },
				{ taskId: 'integration', title: 'Integration', state: 'queued' as const },
			],
			reasons: [], updatedAt: '2026-09-03T03:01:00.000Z', executionAuthorized: false as const, modelDispatchAuthorized: false as const,
		};
		const active = projectRunForBoard(run, undefined, { ...base, status: 'active', summary: '2 workers active; 0/3 tasks succeeded.' });
		assert.equal(active.lane, 'working');
		assert.equal(active.phase, 'multi-worker fan-out');
		assert.equal(active.updatedAt, base.updatedAt);
		assert.equal(active.metrics.activeWorkers, 2);
		assert.equal(active.actions.length, 0);

		const blocked = projectRunForBoard(run, undefined, {
			...base, status: 'blocked', activeWorkers: 0, summary: 'Subscription-call budget is exhausted.',
			reasons: ['Subscription-call budget is exhausted for openai-codex'], updatedAt: '2026-09-03T03:02:00.000Z',
		});
		assert.equal(blocked.lane, 'attention');
		assert.equal(blocked.phase, 'fan-out blocked');
		assert.match(blocked.attention ?? '', /Subscription-call budget/);
		assert.equal(blocked.actions.length, 0);

		const cancelledRun = ledger.cancel(run.id, { expectedVersion: run.version, reason: 'Stop the parent run.' }, principal);
		const cancelled = projectRunForBoard(cancelledRun, undefined, { ...base, status: 'active', summary: 'Stale active evidence.' });
		assert.equal(cancelled.lane, 'history');
		assert.equal(cancelled.phase, 'cancelled');
	} finally { ledger.close(); }
});
