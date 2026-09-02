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
