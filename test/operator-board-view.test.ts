import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { projectOperatorBoard, projectRunForBoard } from '../src/control-plane/operator-board-view.ts';
import type { DraftPublicationRecord } from '../src/control-plane/publication-contracts.ts';
import type { PublicationRebaseRecord } from '../src/control-plane/publication-rebase-contracts.ts';
import type { PublicationRebaseReviewRecord } from '../src/control-plane/publication-rebase-review-contracts.ts';

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
		assert.equal(card.phase, 'waiting on you');
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
		assert.equal(view.cards.find(({ id }) => id === blocked.id)?.actions.at(-1)?.kind, 'archive');
		assert.equal(view.cards.find(({ id }) => id === cancelled.id)?.lane, 'history');
	} finally { ledger.close(); }
});

test('archive is a reversible History overlay that suppresses attention state', () => {
	let tick = 0;
	const ledger = new JobLedger(':memory:', () => new Date(`2026-09-02T16:00:0${tick++}.000Z`));
	try {
		const blocked = ledger.admit({ repositoryId: 'frostyard/clix', workItem, triageDecision: needsSpec }, principal, 'archive-overlay');
		const archived = ledger.archive(blocked.id, { expectedVersion: blocked.version, reason: 'Testing is complete.' }, principal);
		const card = projectRunForBoard(archived);
		assert.equal(card.lane, 'history');
		assert.equal(card.phase, 'archived');
		assert.match(card.summary, /will not ask for attention or send notifications/);
		assert.deepEqual(card.actions.map(({ kind }) => kind), ['restore']);

		const restored = ledger.restore(blocked.id, { expectedVersion: archived.version, reason: 'Revisit it.' }, principal);
		const restoredCard = projectRunForBoard(restored);
		assert.equal(restoredCard.lane, 'attention');
		assert.equal(restoredCard.actions.at(-1)?.kind, 'archive');
	} finally { ledger.close(); }
});

test('externally merged and closed pull requests become terminal history', () => {
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-03T04:00:00.000Z'));
	try {
		const run = ledger.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'publication-lifecycle');
		const publication = {
			id: '11111111-1111-4111-8111-111111111111', ownerId: principal.id, runId: run.id,
			jobId: run.jobs[0]!.id, attemptId: '22222222-2222-4222-8222-222222222222',
			reviewId: '33333333-3333-4333-8333-333333333333', repositoryId: 'frostyard/clix',
			status: 'merged', baseCommit: 'a'.repeat(40), approvedPatchSha256: 'b'.repeat(64),
			branchName: 'bobsled/lifecycle', title: workItem.title, body: 'Durable draft body',
			marker: '<!-- bobsled-publication:lifecycle -->', requiredCheckNames: ['verify'],
			reason: 'Operator authorized draft publication.', attemptCount: 1, commitSha: 'c'.repeat(40),
			pullNumber: 42, pullUrl: 'https://github.com/frostyard/clix/pull/42', pullState: 'closed',
			pullDraft: false, pullMergedAt: '2026-09-03T04:05:00.000Z', pullClosedAt: '2026-09-03T04:05:00.000Z',
			checks: [], createdAt: '2026-09-03T04:01:00.000Z', updatedAt: '2026-09-03T04:05:00.000Z',
		} satisfies DraftPublicationRecord;
		const merged = projectRunForBoard(run, publication);
		assert.equal(merged.lane, 'history');
		assert.equal(merged.phase, 'merged');
		assert.deepEqual(merged.actions.map(({ kind }) => kind), ['open_pull_request']);

		const closed = projectRunForBoard(run, { ...publication, status: 'closed', pullMergedAt: undefined });
		assert.equal(closed.lane, 'history');
		assert.equal(closed.phase, 'closed, not merged');
		assert.deepEqual(closed.actions.map(({ kind }) => kind), ['refresh_checks', 'open_pull_request']);
	} finally { ledger.close(); }
});

test('stale-base recovery advances through explicit replay, review, and promotion actions', () => {
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-03T10:00:00.000Z'));
	try {
		const run = ledger.admit({ repositoryId: 'frostyard/frostyard-org', workItem }, principal, 'stale-recovery');
		const publication = {
			id: '11111111-1111-4111-8111-111111111111', ownerId: principal.id, runId: run.id, jobId: run.jobs[0]!.id,
			attemptId: '22222222-2222-4222-8222-222222222222', reviewId: '33333333-3333-4333-8333-333333333333',
			repositoryId: 'frostyard/frostyard-org', status: 'blocked', baseCommit: 'a'.repeat(40), approvedPatchSha256: 'b'.repeat(64),
			branchName: 'bobsled/stale', title: workItem.title, body: 'Durable draft body', marker: '<!-- marker -->',
			requiredCheckNames: ['verify'], reason: 'Prepare the reviewed draft.', blockedReason: 'Remote main moved beyond the approved base commit',
			attemptCount: 0, checks: [], createdAt: '2026-09-03T10:01:00.000Z', updatedAt: '2026-09-03T10:01:00.000Z',
		} satisfies DraftPublicationRecord;
		const available = projectRunForBoard(run, publication);
		assert.equal(available.phase, 'main moved on'); assert.deepEqual(available.actions.map(({ kind }) => kind), ['replay_publication']);

		const rebase = {
			id: '44444444-4444-4444-8444-444444444444', ownerId: principal.id, sourcePublicationId: publication.id,
			repositoryId: publication.repositoryId, status: 'validated', oldBaseCommit: publication.baseCommit, newBaseCommit: 'c'.repeat(40),
			approvedPatchSha256: publication.approvedPatchSha256, replayedPatchSha256: 'd'.repeat(64), sourceChangedPaths: ['src/app.ts'],
			replayedChangedPaths: ['src/app.ts'], conflictPaths: [], workspacePath: '/trusted/replay',
			preparation: { name: 'prepare', command: 'mise install', networkAccess: true, status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false },
			gates: [{ id: 'verify', name: 'Verify', command: 'npm test', status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }],
			modelCalls: 0, reviewRequired: true, reviewAuthorized: false, publicationAuthorized: false, reason: 'Replay on current base.',
			createdAt: '2026-09-03T10:02:00.000Z', updatedAt: '2026-09-03T10:03:00.000Z',
		} satisfies PublicationRebaseRecord;
		const pendingReplay = projectRunForBoard(run, publication, undefined, {
			sourcePublicationId: publication.id, rebase: { ...rebase, status: 'pending' },
		});
		assert.equal(pendingReplay.phase, 'rebuild waiting'); assert.equal(pendingReplay.actions[0]?.label, 'Resume the rebuild');
		const replayed = projectRunForBoard(run, publication, undefined, { sourcePublicationId: publication.id, rebase });
		assert.equal(replayed.lane, 'review'); assert.deepEqual(replayed.actions.map(({ kind }) => kind), ['review_publication_replay']);

		const review = {
			id: '55555555-5555-4555-8555-555555555555', ownerId: principal.id, rebaseId: rebase.id, sourcePublicationId: publication.id,
			repositoryId: publication.repositoryId, status: 'approved', baseCommit: rebase.newBaseCommit!, patchSha256: rebase.replayedPatchSha256!,
			changedPaths: rebase.replayedChangedPaths, workspacePath: rebase.workspacePath!, repositoryContextPath: '/trusted/context',
			report: { verdict: 'approve', summary: 'Fresh review approved.', findings: [], testedClaims: [], residualRisks: [] },
			conversationId: 'conversation', submissionId: 'submission', modelCalls: 1, promotionAuthorized: false, publicationAuthorized: false,
			reason: 'Run fresh review.', createdAt: '2026-09-03T10:04:00.000Z', updatedAt: '2026-09-03T10:05:00.000Z',
		} satisfies PublicationRebaseReviewRecord;
		const pendingReview = projectRunForBoard(run, publication, undefined, {
			sourcePublicationId: publication.id, rebase,
			review: { ...review, status: 'pending', modelCalls: 0, report: undefined, repositoryContextPath: undefined, conversationId: undefined, submissionId: undefined },
		});
		assert.equal(pendingReview.phase, 'review starting'); assert.equal(pendingReview.actions[0]?.label, 'Resume the review');
		const approved = projectRunForBoard(run, publication, undefined, { sourcePublicationId: publication.id, rebase, review });
		assert.equal(approved.lane, 'delivery'); assert.deepEqual(approved.actions.map(({ kind }) => kind), ['promote_publication_replay']);

		const resolved = projectRunForBoard(run, publication, undefined, {
			sourcePublicationId: publication.id, rebase,
			resolution: {
				id: '66666666-6666-4666-8666-666666666666', ownerId: principal.id, sourcePublicationId: publication.id,
				supersedingPublicationId: '77777777-7777-4777-8777-777777777777', repositoryId: publication.repositoryId,
				disposition: 'superseded_by_merged_publication', modelCalls: 0, githubMutations: 0,
				reason: 'The later merged publication delivered this task.', createdAt: '2026-09-03T10:06:00.000Z',
			},
			supersedingCandidate: { publicationId: '77777777-7777-4777-8777-777777777777', pullNumber: 7, pullUrl: 'https://github.com/frostyard/frostyard-org/pull/7' },
		});
		assert.equal(resolved.lane, 'history'); assert.equal(resolved.phase, 'shipped another way');
		assert.equal(resolved.updatedAt, '2026-09-03T10:06:00.000Z');
		assert.deepEqual(resolved.actions.map(({ kind }) => kind), ['open_pull_request']);
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
		assert.equal(active.phase, 'split across workers');
		assert.equal(active.updatedAt, base.updatedAt);
		assert.equal(active.metrics.activeWorkers, 2);
		assert.equal(active.actions.length, 0);

		const blocked = projectRunForBoard(run, undefined, {
			...base, status: 'blocked', activeWorkers: 0, summary: 'Subscription-call budget is exhausted.',
			reasons: ['Subscription-call budget is exhausted for openai-codex'], updatedAt: '2026-09-03T03:02:00.000Z',
		});
		assert.equal(blocked.lane, 'attention');
		assert.equal(blocked.phase, 'split stopped');
		assert.match(blocked.attention ?? '', /Subscription-call budget/);
		assert.equal(blocked.actions.length, 0);

		const cancelledRun = ledger.cancel(run.id, { expectedVersion: run.version, reason: 'Stop the parent run.' }, principal);
		const cancelled = projectRunForBoard(cancelledRun, undefined, { ...base, status: 'active', summary: 'Stale active evidence.' });
		assert.equal(cancelled.lane, 'history');
		assert.equal(cancelled.phase, 'dropped');
	} finally { ledger.close(); }
});
