import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { JobLedger, LedgerConflictError } from '../src/control-plane/ledger.ts';
import {
	MultiRepositoryChangeSetConflictError,
	MultiRepositoryChangeSetForbiddenError,
	MultiRepositoryChangeSetStore,
	MultiRepositoryCoordinationBlockedError,
} from '../src/control-plane/multi-repository-change-set-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-parent-test' };
const now = () => new Date('2026-09-03T13:00:00.000Z');

function unit(repositoryId: string, dependsOn: string[] = []) {
	return {
		repositoryId,
		title: `Update ${repositoryId}`,
		objective: `Keep ${repositoryId} compatible with the coordinated change.`,
		acceptanceCriteria: [`${repositoryId} passes its declared gates.`],
		dependsOn,
		compatibilityContracts: dependsOn.map((dependencyRepositoryId) => ({
			dependencyRepositoryId, kind: 'api' as const,
			expectation: `${repositoryId} consumes the updated interface from ${dependencyRepositoryId}.`,
			verification: ['The dependent repository verifies the new interface.'],
		})),
	};
}

const plan = {
	version: 1 as const,
	title: 'Coordinate a CLI and website contract',
	objective: 'Keep two repository deliverables compatible without granting execution.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Execution remains a later explicit boundary.'],
};

function coordinatedRepositories(): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository, multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

function fixture(): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-parent-'));
	return { root, path: join(root, 'bobsled.db') };
}

test('persists one blocked repository job and immutable policy snapshot per change-set member', () => {
	const value = fixture();
	const store = new MultiRepositoryChangeSetStore(value.path, now, coordinatedRepositories());
	try {
		const admitted = store.admit({ plan, reason: 'Persist independent repository parentage before any coordinated execution.' }, principal, 'change-set-parent');
		assert.equal(admitted.status, 'planned');
		assert.equal(admitted.members.length, 2);
		assert.equal(new Set(admitted.members.map(({ runId }) => runId)).size, 2);
		assert.equal(new Set(admitted.members.map(({ jobId }) => jobId)).size, 2);
		assert.deepEqual(admitted.members.map(({ repositoryId }) => repositoryId), plan.repositories.map(({ repositoryId }) => repositoryId));
		assert.equal(admitted.executionAuthorized, false);
		assert.equal(admitted.publicationAuthorized, false);

		const ledger = new JobLedger(value.path, now);
		try {
			for (const member of admitted.members) {
				const run = ledger.get(member.runId, principal);
				assert.equal(run.status, 'blocked');
				assert.equal(run.jobs[0]?.status, 'blocked');
				assert.equal(run.jobs[0]?.currentAttempt, 0);
				assert.deepEqual(member.policySnapshot, run.jobs[0]?.policySnapshot);
				assert.match(member.policySnapshotSha256, /^[a-f0-9]{64}$/);
				assert.throws(() => ledger.overrideBlocked(run.id, { expectedVersion: run.version, reason: 'Do not detach this coordinated member.' }, principal), LedgerConflictError);
				assert.throws(() => ledger.cancel(run.id, { expectedVersion: run.version, reason: 'Do not detach this coordinated member.' }, principal), LedgerConflictError);
				assert.throws(() => ledger.admit({ repositoryId: member.repositoryId, workItem: run.jobs[0]!.workItemSnapshot, supersedesRunId: run.id }, principal, `detached-${member.repositoryId}`), LedgerConflictError);
			}
		} finally { ledger.close(); }
		assert.equal(store.admit({ plan, reason: 'Persist independent repository parentage before any coordinated execution.' }, principal, 'change-set-parent').id, admitted.id);
		const observer = new MultiRepositoryChangeSetStore(value.path, now, coordinatedRepositories());
		try {
			assert.equal(observer.admit({ plan, reason: 'Persist independent repository parentage before any coordinated execution.' }, principal, 'change-set-parent').id, admitted.id);
		} finally { observer.close(); }
	} finally { store.close(); }

	const reopened = new MultiRepositoryChangeSetStore(value.path, now, coordinatedRepositories());
	try {
		const listed = reopened.list(principal);
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.members.length, 2);
		assert.throws(() => reopened.get(listed[0]!.id, { id: 'operator:other' }), MultiRepositoryChangeSetForbiddenError);
	} finally { reopened.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks enrollment policy before creating jobs and rejects changed idempotency input', () => {
	const value = fixture();
	const denied = new MultiRepositoryChangeSetStore(value.path, now, repositories);
	try {
		assert.throws(() => denied.admit({ plan, reason: 'This policy must fail before local job admission occurs.' }, principal, 'denied'), MultiRepositoryCoordinationBlockedError);
		const ledger = new JobLedger(value.path, now);
		try { assert.equal(ledger.list(principal).length, 0); } finally { ledger.close(); }
	} finally { denied.close(); }

	const store = new MultiRepositoryChangeSetStore(value.path, now, coordinatedRepositories());
	try {
		store.admit({ plan, reason: 'Persist independent repository parentage before any coordinated execution.' }, principal, 'same-key');
		assert.throws(() => store.admit({ plan, reason: 'A different reason cannot reuse the same idempotency key.' }, principal, 'same-key'), MultiRepositoryChangeSetConflictError);
		assert.throws(() => store.admit({ plan, reason: 'A second parent cannot duplicate the same immutable plan.' }, principal, 'different-key'), MultiRepositoryChangeSetConflictError);
	} finally { store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('fails closed when persisted member evidence no longer matches its digest or ledger parent', () => {
	const value = fixture();
	const store = new MultiRepositoryChangeSetStore(value.path, now, coordinatedRepositories());
	let id = '';
	try {
		id = store.admit({ plan, reason: 'Persist evidence that must remain bound to its original ledger snapshot.' }, principal, 'tamper-proof').id;
	} finally { store.close(); }
	const db = new Database(value.path);
	try {
		db.prepare('UPDATE multi_repository_change_set_members SET unit_sha256 = ? WHERE change_set_id = ? AND repository_id = ?')
			.run('0'.repeat(64), id, 'frostyard/clix');
	} finally { db.close(); }
	const reopened = new MultiRepositoryChangeSetStore(value.path, now, coordinatedRepositories());
	try {
		assert.throws(() => reopened.get(id, principal), MultiRepositoryChangeSetConflictError);
	} finally { reopened.close(); rmSync(value.root, { recursive: true, force: true }); }
});
