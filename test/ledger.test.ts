import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
	JobLedger,
	LedgerConflictError,
	LedgerForbiddenError,
} from '../src/control-plane/ledger.ts';

const principal = { id: 'operator:primary' };
const otherPrincipal = { id: 'operator:someone-else' };
const workItem = {
	source: 'manual' as const,
	key: 'manual:docs',
	title: 'Document cancellation behavior',
	body: 'Clarify cancellation behavior in the README.',
	labels: [],
};
const needsSpec = {
	route: 'needs_spec' as const,
	risk: 'low' as const,
	confidence: 0.9,
	summary: 'Behavior needs specification.',
	rationale: 'The public behavior is ambiguous.',
	acceptanceCriteria: ['Document the agreed behavior.'],
	missingInformation: ['Which behavior is intended?'],
	suggestedLabels: ['bobsled:needs-spec' as const],
	eligibleForOneClick: false,
};

function ledger() {
	return new JobLedger(':memory:', () => new Date('2026-09-01T12:00:00.000Z'));
}

test('admission snapshots policy and is idempotent for identical input', () => {
	const store = ledger();
	try {
		const input = { repositoryId: 'frostyard/clix', workItem };
		const first = store.admit(input, principal, 'same-request');
		const repeated = store.admit(input, principal, 'same-request');
		assert.equal(repeated.id, first.id);
		assert.equal(first.jobs[0]?.policySnapshot.id, 'frostyard/clix');
		assert.equal(first.audit[0]?.type, 'run.admitted');
		assert.throws(
			() => store.admit({ ...input, workItem: { ...workItem, title: 'Different' } }, principal, 'same-request'),
			LedgerConflictError,
		);
	} finally {
		store.close();
	}
});

test('non-ready triage blocks without becoming a dead end', () => {
	const store = ledger();
	try {
		const run = store.admit({ repositoryId: 'frostyard/clix', workItem, triageDecision: needsSpec }, principal, 'blocked');
		assert.equal(run.status, 'blocked');
		assert.equal(run.jobs[0]?.status, 'blocked');

		const overridden = store.overrideBlocked(run.id, {
			expectedVersion: run.version,
			reason: 'Human reviewed the ambiguity and accepts the documented assumption.',
		}, principal);
		assert.equal(overridden.status, 'pending');
		assert.equal(overridden.jobs[0]?.status, 'admitted');
		assert.equal(overridden.audit.at(-1)?.type, 'run.override_granted');
	} finally {
		store.close();
	}
});

test('ownership and optimistic version checks protect deliberate actions', () => {
	const store = ledger();
	try {
		const run = store.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'owned');
		assert.throws(() => store.get(run.id, otherPrincipal), LedgerForbiddenError);
		assert.throws(
			() => store.cancel(run.id, { expectedVersion: 99, reason: 'Stop this run' }, principal),
			LedgerConflictError,
		);
		const cancelled = store.cancel(run.id, { expectedVersion: run.version, reason: 'Stop this run' }, principal);
		assert.equal(cancelled.status, 'cancelled');
		assert.equal(cancelled.jobs[0]?.status, 'cancelled');
	} finally {
		store.close();
	}
});

test('cancelled work can be superseded without rewriting history', () => {
	const store = ledger();
	try {
		const original = store.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'original');
		store.cancel(original.id, { expectedVersion: original.version, reason: 'Replace the approach' }, principal);
		const replacement = store.admit({
			repositoryId: 'frostyard/clix',
			workItem: { ...workItem, body: 'Use the revised approach.' },
			supersedesRunId: original.id,
		}, principal, 'replacement');
		assert.equal(replacement.supersedesRunId, original.id);
		assert.equal(replacement.status, 'pending');
	} finally {
		store.close();
	}
});

test('an executed blocked run can be superseded with a fresh policy snapshot', () => {
	const store = ledger();
	try {
		const original = store.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'blocked-original');
		const execution = store.authorizeExecution(original.id, {
			expectedVersion: original.version,
			reason: 'Operator authorizes the bounded attempt used by this test.',
		}, principal);
		store.markExecutionRunning(execution, principal);
		const blocked = store.completeExecution(execution, 'blocked', { evidence: 'no patch' }, [], principal);
		const replacement = store.admit({
			repositoryId: 'frostyard/clix',
			workItem,
			supersedesRunId: blocked.id,
		}, principal, 'blocked-replacement');
		assert.equal(replacement.supersedesRunId, blocked.id);
		assert.equal(replacement.status, 'pending');
		assert.equal(replacement.jobs[0]?.policySnapshot.executionPolicy?.workerNetwork?.mode, 'public_dependencies');
		assert.equal(store.get(blocked.id, principal).status, 'blocked');
	} finally {
		store.close();
	}
});

test('ledger migrations and admitted work survive process-style reopen', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-ledger-'));
	const path = join(directory, 'ledger.db');
	try {
		const first = new JobLedger(path);
		const admitted = first.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'durable');
		first.close();

		const reopened = new JobLedger(path);
		assert.equal(reopened.get(admitted.id, principal).jobs[0]?.workItemSnapshot.title, workItem.title);
		reopened.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('historical policy snapshots remain readable but cannot silently gain M3 execution authority', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-legacy-policy-'));
	const path = join(directory, 'ledger.db');
	try {
		const first = new JobLedger(path);
		const admitted = first.admit({ repositoryId: 'frostyard/clix', workItem }, principal, 'legacy-policy');
		first.close();

		const database = new Database(path);
		const job = database.prepare('SELECT id, policy_snapshot_json FROM jobs WHERE run_id = ?').get(admitted.id) as { id: string; policy_snapshot_json: string };
		const snapshot = JSON.parse(job.policy_snapshot_json) as Record<string, unknown>;
		delete snapshot.githubRepositoryId;
		delete snapshot.executionPolicy;
		delete snapshot.workspacePreparation;
		database.prepare('UPDATE jobs SET policy_snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), job.id);
		database.close();

		const reopened = new JobLedger(path);
		const historical = reopened.get(admitted.id, principal);
		assert.equal(historical.jobs[0]?.policySnapshot.id, 'frostyard/clix');
		assert.equal(historical.jobs[0]?.policySnapshot.executionPolicy, undefined);
		assert.throws(() => reopened.authorizeExecution(admitted.id, {
			expectedVersion: historical.version,
			reason: 'Attempting to execute an old snapshot must require explicit supersession.',
		}, principal), /predates the M3 execution contract/);
		reopened.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
