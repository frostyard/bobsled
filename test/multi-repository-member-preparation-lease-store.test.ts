import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import {
	MultiRepositoryMemberPreparationLeaseStore,
	MultiRepositoryPreparationLeaseConflictError,
	MultiRepositoryPreparationLeaseForbiddenError,
	MultiRepositoryPreparationLeaseNotReadyError,
	MultiRepositoryPreparationLeasePolicyError,
} from '../src/control-plane/multi-repository-member-preparation-lease-store.ts';
import { MultiRepositoryChangeSetScheduleStore } from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-lease-test' };
const now = () => new Date('2026-09-03T16:00:00.000Z');

function unit(repositoryId: string, dependsOn: string[] = []) {
	return {
		repositoryId, title: `Update ${repositoryId}`,
		objective: `Keep ${repositoryId} compatible with the coordinated change.`,
		acceptanceCriteria: [`${repositoryId} passes its declared gates.`], dependsOn,
		compatibilityContracts: dependsOn.map((dependencyRepositoryId) => ({
			dependencyRepositoryId, kind: 'api' as const,
			expectation: `${repositoryId} consumes the updated interface from ${dependencyRepositoryId}.`,
			verification: ['The dependent repository verifies the new interface.'],
		})),
	};
}

const plan = {
	version: 1 as const, title: 'Coordinate a CLI and website contract',
	objective: 'Reserve dependency-ready preparation without model authority.',
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
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-lease-'));
	return { root, path: join(root, 'bobsled.db') };
}

function schedule(path: string, policy = coordinatedRepositories()) {
	const parents = new MultiRepositoryChangeSetStore(path, now, policy);
	let changeSetId = '';
	try { changeSetId = parents.admit({ plan, reason: 'Persist member jobs before lease scheduling.' }, principal, 'parent').id; }
	finally { parents.close(); }
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, policy);
	let authorizationId = '';
	try {
		authorizationId = authorizations.authorize({ changeSetId, reason: 'Authorize the exact coordinated member set.' }, principal, 'authorization').id;
	} finally { authorizations.close(); }
	const schedules = new MultiRepositoryChangeSetScheduleStore(path, now, policy);
	try {
		return schedules.schedule({ authorizationId, reason: 'Snapshot current policy and dependency readiness.' }, principal, 'schedule');
	} finally { schedules.close(); }
}

test('reserves one root preparation lease without unblocking execution or dispatch', () => {
	const value = fixture();
	const scheduled = schedule(value.path);
	const store = new MultiRepositoryMemberPreparationLeaseStore(value.path, now, coordinatedRepositories());
	try {
		const lease = store.reserve({
			scheduleId: scheduled.id, repositoryId: 'frostyard/clix',
			reason: 'Reserve only the dependency-ready root workspace preparation boundary.',
		}, principal, 'root-lease');
		assert.equal(lease.status, 'reserved');
		assert.equal(lease.workspacePreparationAuthorized, true);
		assert.equal(lease.modelDispatchAuthorized, false);
		assert.equal(lease.executionAuthorized, false);
		assert.equal(lease.publicationAuthorized, false);
		assert.equal(lease.expiresAt, '2026-09-03T16:15:00.000Z');
		assert.equal(store.reserve({
			scheduleId: scheduled.id, repositoryId: 'frostyard/clix',
			reason: 'Reserve only the dependency-ready root workspace preparation boundary.',
		}, principal, 'root-lease').id, lease.id);
		const observer = new MultiRepositoryMemberPreparationLeaseStore(value.path, now, coordinatedRepositories());
		try {
			assert.equal(observer.reserve({
				scheduleId: scheduled.id, repositoryId: 'frostyard/clix',
				reason: 'Reserve only the dependency-ready root workspace preparation boundary.',
			}, principal, 'root-lease').id, lease.id);
		} finally { observer.close(); }
		assert.throws(() => store.get(lease.id, { id: 'operator:other' }), MultiRepositoryPreparationLeaseForbiddenError);
		assert.throws(() => store.reserve({
			scheduleId: scheduled.id, repositoryId: 'frostyard/clix', reason: 'A competing lease cannot replace the first.',
		}, principal, 'competing'), MultiRepositoryPreparationLeaseConflictError);
	} finally { store.close(); }
	const ledger = new JobLedger(value.path, now);
	try {
		const root = scheduled.members[0]!;
		const run = ledger.get(root.runId, principal);
		assert.equal(run.status, 'blocked');
		assert.equal(run.jobs[0]?.status, 'blocked');
		assert.equal(run.jobs[0]?.attempts.length, 0);
	} finally { ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('requires durable successful implementation and policy-required review before a dependent lease', () => {
	const value = fixture();
	const scheduled = schedule(value.path);
	const store = new MultiRepositoryMemberPreparationLeaseStore(value.path, now, coordinatedRepositories());
	try {
		assert.throws(() => store.reserve({
			scheduleId: scheduled.id, repositoryId: 'frostyard/frostyard-org',
			reason: 'A dependent cannot prepare before its prerequisite evidence is complete.',
		}, principal, 'dependent'), MultiRepositoryPreparationLeaseNotReadyError);
	} finally { store.close(); }

	const root = scheduled.members[0]!;
	const attemptId = '00000000-0000-4000-8000-000000000011';
	const db = new Database(value.path);
	try {
		db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(root.runId);
		db.prepare("UPDATE jobs SET status = 'succeeded', current_attempt = 1 WHERE id = ?").run(root.jobId);
		db.prepare("INSERT INTO attempts (id, job_id, number, status, finished_at) VALUES (?, ?, 1, 'succeeded', ?)").run(attemptId, root.jobId, now().toISOString());
	} finally { db.close(); }
	const reviewRequired = new MultiRepositoryMemberPreparationLeaseStore(value.path, now, coordinatedRepositories());
	try {
		assert.throws(() => reviewRequired.reserve({
			scheduleId: scheduled.id, repositoryId: 'frostyard/frostyard-org',
			reason: 'A required adversarial review must complete before dependent preparation.',
		}, principal, 'dependent'), MultiRepositoryPreparationLeaseNotReadyError);
	} finally { reviewRequired.close(); }

	const reviewDb = new Database(value.path);
	try {
		reviewDb.prepare(`INSERT INTO reviews (id, job_id, attempt_id, number, status, finished_at)
			VALUES (?, ?, ?, 1, 'approved', ?)`).run('00000000-0000-4000-8000-000000000012', root.jobId, attemptId, now().toISOString());
	} finally { reviewDb.close(); }
	const ready = new MultiRepositoryMemberPreparationLeaseStore(value.path, now, coordinatedRepositories());
	try {
		assert.equal(ready.reserve({
			scheduleId: scheduled.id, repositoryId: 'frostyard/frostyard-org',
			reason: 'Trusted prerequisite implementation and review now permit dependent preparation.',
		}, principal, 'dependent').repositoryId, 'frostyard/frostyard-org');
	} finally { ready.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks revoked policy, changed target state, and stored lease tampering', () => {
	const policyValue = fixture();
	const policySchedule = schedule(policyValue.path);
	const revoked = coordinatedRepositories().map((repository, index) => index === 0 ? { ...repository, multiRepo: { coordinateWith: [] } } : repository);
	const policyStore = new MultiRepositoryMemberPreparationLeaseStore(policyValue.path, now, revoked);
	try {
		assert.throws(() => policyStore.reserve({
			scheduleId: policySchedule.id, repositoryId: 'frostyard/clix', reason: 'Revoked consent must block workspace authority.',
		}, principal, 'revoked'), MultiRepositoryPreparationLeasePolicyError);
	} finally { policyStore.close(); rmSync(policyValue.root, { recursive: true, force: true }); }

	const stateValue = fixture();
	const stateSchedule = schedule(stateValue.path);
	const stateDb = new Database(stateValue.path);
	try { stateDb.prepare("UPDATE jobs SET status = 'admitted' WHERE id = ?").run(stateSchedule.members[0]!.jobId); }
	finally { stateDb.close(); }
	const stateStore = new MultiRepositoryMemberPreparationLeaseStore(stateValue.path, now, coordinatedRepositories());
	try {
		assert.throws(() => stateStore.reserve({
			scheduleId: stateSchedule.id, repositoryId: 'frostyard/clix', reason: 'Changed target state must block workspace authority.',
		}, principal, 'state'), MultiRepositoryPreparationLeaseConflictError);
	} finally { stateStore.close(); rmSync(stateValue.root, { recursive: true, force: true }); }

	const tamperValue = fixture();
	const tamperSchedule = schedule(tamperValue.path);
	const tamperStore = new MultiRepositoryMemberPreparationLeaseStore(tamperValue.path, now, coordinatedRepositories());
	let leaseId = '';
	try {
		leaseId = tamperStore.reserve({
			scheduleId: tamperSchedule.id, repositoryId: 'frostyard/clix', reason: 'Persist policy-bound workspace preparation authority.',
		}, principal, 'tamper').id;
	} finally { tamperStore.close(); }
	const tamperDb = new Database(tamperValue.path);
	try { tamperDb.prepare('UPDATE multi_repository_member_preparation_leases SET policy_snapshot_sha256 = ? WHERE id = ?').run('0'.repeat(64), leaseId); }
	finally { tamperDb.close(); }
	const reopened = new MultiRepositoryMemberPreparationLeaseStore(tamperValue.path, now, coordinatedRepositories());
	try { assert.throws(() => reopened.get(leaseId, principal), MultiRepositoryPreparationLeaseConflictError); }
	finally { reopened.close(); }
	const expiryDb = new Database(tamperValue.path);
	try {
		expiryDb.prepare('UPDATE multi_repository_member_preparation_leases SET policy_snapshot_sha256 = ?, expires_at = ? WHERE id = ?')
			.run(tamperSchedule.members[0]!.policySnapshotSha256, '2026-09-03T17:00:00.000Z', leaseId);
	} finally { expiryDb.close(); }
	const expiryReopened = new MultiRepositoryMemberPreparationLeaseStore(tamperValue.path, now, coordinatedRepositories());
	try { assert.throws(() => expiryReopened.get(leaseId, principal), MultiRepositoryPreparationLeaseConflictError); }
	finally { expiryReopened.close(); rmSync(tamperValue.root, { recursive: true, force: true }); }
});
