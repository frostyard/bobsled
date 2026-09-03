import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import { MultiRepositoryMemberExecutionPreflightService } from '../src/control-plane/multi-repository-member-execution-preflight-service.ts';
import {
	MultiRepositoryMemberExecutionReservationConflictError,
	MultiRepositoryMemberExecutionReservationForbiddenError,
	MultiRepositoryMemberExecutionReservationPolicyError,
	MultiRepositoryMemberExecutionReservationStore,
} from '../src/control-plane/multi-repository-member-execution-reservation-store.ts';
import { MultiRepositoryMemberPreparationLeaseStore } from '../src/control-plane/multi-repository-member-preparation-lease-store.ts';
import { MultiRepositoryChangeSetScheduleStore } from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-execution-reservation-test' };
const now = () => new Date('2026-09-03T17:00:00.000Z');

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function unit(repositoryId: string, dependsOn: string[] = []) {
	return {
		repositoryId, title: `Update ${repositoryId}`, objective: `Keep ${repositoryId} compatible.`,
		acceptanceCriteria: [`${repositoryId} passes its declared gates.`], dependsOn,
		compatibilityContracts: dependsOn.map((dependencyRepositoryId) => ({
			dependencyRepositoryId, kind: 'api' as const, expectation: 'Consume the updated contract.',
			verification: ['Verify the updated contract.'],
		})),
	};
}

const plan = {
	version: 1 as const, title: 'Reserve a prepared coordinated member',
	objective: 'Bind clean preparation evidence before execution preflight.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Model dispatch remains a later boundary.'],
};

function coordinatedRepositories(): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository, multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

function fixture(policy = coordinatedRepositories()) {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-execution-reservation-'));
	const path = join(root, 'bobsled.db');
	const workspacePath = join(root, 'workspaces', 'prepared', 'repo');
	mkdirSync(workspacePath, { recursive: true });
	git(workspacePath, ['init', '-b', 'main']);
	writeFileSync(join(workspacePath, 'tracked.txt'), 'clean\n');
	git(workspacePath, ['add', 'tracked.txt']);
	git(workspacePath, ['-c', 'user.name=Bobsled Tests', '-c', 'user.email=bobsled@example.invalid', 'commit', '-m', 'base']);
	const baseCommit = git(workspacePath, ['rev-parse', 'HEAD']);
	const parents = new MultiRepositoryChangeSetStore(path, now, policy);
	const parent = parents.admit({ plan, reason: 'Persist coordinated member lineage before execution reservation.' }, principal, 'parent');
	parents.close();
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, policy);
	const authorization = authorizations.authorize({ changeSetId: parent.id, reason: 'Authorize the exact coordinated repository set.' }, principal, 'authorization');
	authorizations.close();
	const schedules = new MultiRepositoryChangeSetScheduleStore(path, now, policy);
	const schedule = schedules.schedule({ authorizationId: authorization.id, reason: 'Snapshot dependency-ready member policy.' }, principal, 'schedule');
	schedules.close();
	const leases = new MultiRepositoryMemberPreparationLeaseStore(path, now, policy);
	const lease = leases.reserve({ scheduleId: schedule.id, repositoryId: 'frostyard/clix', reason: 'Reserve and prepare the root repository workspace.' }, principal, 'lease');
	assert.equal(leases.claimPreparation(lease.id, principal).newlyClaimed, true);
	const prepared = leases.completePreparation(lease.id, principal, {
		leaseId: lease.id, repositoryId: lease.repositoryId,
		workspacePath, evidencePath: join(root, 'workspaces', 'prepared', 'evidence'),
		baseCommit, headCommit: baseCommit,
		preparation: { name: lease.policySnapshot.workspacePreparation.name, command: lease.policySnapshot.workspacePreparation.command,
			networkAccess: lease.policySnapshot.workspacePreparation.networkAccess, status: 'passed', exitCode: 0,
			durationMs: 12, stdout: '', stderr: '', truncated: false },
		changedPaths: [], status: 'passed', violations: [], detail: 'Clean workspace preparation passed.',
		workspaceReady: true, modelDispatchAuthorized: false, executionAuthorized: false, publicationAuthorized: false,
	});
	leases.close();
	return { root, path, policy, schedule, prepared, baseCommit, workspacePath };
}

test('reserves immutable preflight authority without creating an attempt or model-call authority', () => {
	const value = fixture();
	const store = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	try {
		const request = { leaseId: value.prepared.id, reason: 'Bind clean preparation evidence before the execution preflight.' };
		const reservation = store.reserve(request, principal, 'execution-reservation');
		assert.equal(reservation.status, 'reserved');
		assert.equal(reservation.preflightAuthorized, true);
		assert.equal(reservation.modelDispatchAuthorized, false);
		assert.equal(reservation.executionAuthorized, false);
		assert.equal(reservation.publicationAuthorized, false);
		assert.equal(reservation.baseCommit, value.baseCommit);
		assert.equal(store.reserve(request, principal, 'execution-reservation').id, reservation.id);
		const observer = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
		try { assert.equal(observer.reserve(request, principal, 'execution-reservation').id, reservation.id); }
		finally { observer.close(); }
		assert.throws(() => store.get(reservation.id, { id: 'operator:other' }), MultiRepositoryMemberExecutionReservationForbiddenError);
		assert.throws(() => store.reserve(request, principal, 'competing-reservation'), MultiRepositoryMemberExecutionReservationConflictError);
	} finally { store.close(); }
	const ledger = new JobLedger(value.path, now);
	try {
		const run = ledger.get(value.prepared.runId, principal);
		assert.equal(run.status, 'blocked');
		assert.equal(run.jobs[0]?.status, 'blocked');
		assert.equal(run.jobs[0]?.attempts.length, 0);
	} finally { ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('rejects unprepared members and policy drift before reserving execution preflight', () => {
	const value = fixture();
	const db = new Database(value.path);
	try { db.prepare("DELETE FROM multi_repository_member_execution_reservations").run(); db.prepare("UPDATE multi_repository_member_preparation_leases SET status = 'preparing' WHERE id = ?").run(value.prepared.id); }
	finally { db.close(); }
	const unprepared = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	try {
		assert.throws(() => unprepared.reserve({ leaseId: value.prepared.id, reason: 'Unprepared members must remain unable to execute.' }, principal, 'unprepared'), /Stored preparation lease failed/);
	} finally { unprepared.close(); }
	const reset = new Database(value.path);
	try { reset.prepare("UPDATE multi_repository_member_preparation_leases SET status = 'prepared' WHERE id = ?").run(value.prepared.id); }
	finally { reset.close(); }
	const driftedPolicy = value.policy.map((repository) => repository.id === value.prepared.repositoryId
		? { ...repository, executionPolicy: { ...repository.executionPolicy, maxFiles: repository.executionPolicy.maxFiles + 1 } }
		: repository);
	const drifted = new MultiRepositoryMemberExecutionReservationStore(value.path, now, driftedPolicy);
	try {
		assert.throws(() => drifted.reserve({ leaseId: value.prepared.id, reason: 'Policy drift requires a fresh coordinated path.' }, principal, 'drifted'), MultiRepositoryMemberExecutionReservationPolicyError);
	} finally { drifted.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('fails closed when durable preparation, ledger parentage, or reservation evidence is changed', () => {
	const value = fixture();
	const store = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	let reservationId = '';
	try {
		reservationId = store.reserve({ leaseId: value.prepared.id, reason: 'Persist evidence that will be checked for tampering.' }, principal, 'reservation').id;
	} finally { store.close(); }
	const db = new Database(value.path);
	try { db.prepare('UPDATE multi_repository_member_execution_reservations SET base_commit = ? WHERE id = ?').run('2'.repeat(40), reservationId); }
	finally { db.close(); }
	const observer = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	try { assert.throws(() => observer.get(reservationId, principal), MultiRepositoryMemberExecutionReservationConflictError); }
	finally { observer.close(); }
	const parentDb = new Database(value.path);
	try { parentDb.prepare("UPDATE jobs SET status = 'admitted' WHERE id = ?").run(value.prepared.jobId); }
	finally { parentDb.close(); }
	const parentObserver = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	try {
		assert.throws(() => parentObserver.reserve({ leaseId: value.prepared.id, reason: 'Changed ledger state must block a fresh reservation.' }, principal, 'changed-parent'), MultiRepositoryMemberExecutionReservationConflictError);
	} finally { parentObserver.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('preflights the prepared workspace and atomically claims one ledger attempt and model call', async () => {
	const value = fixture();
	const store = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	const reservation = store.reserve({ leaseId: value.prepared.id, reason: 'Claim one prepared member execution after trusted preflight.' }, principal, 'reservation');
	const service = new MultiRepositoryMemberExecutionPreflightService(store);
	try {
		const first = await service.run(reservation.id, principal.id);
		assert.equal(first.newlyClaimed, true);
		assert.equal(first.reservation.status, 'running');
		assert.equal(first.reservation.workerCalls, 1);
		assert.equal(first.reservation.modelDispatchClaimed, true);
		assert.equal(first.reservation.modelDispatchAuthorized, false);
		assert.equal(first.reservation.preflight?.result.status, 'passed');
		assert.equal((await service.run(reservation.id, principal.id)).newlyClaimed, false);
	} finally { store.close(); }
	const ledger = new JobLedger(value.path, now);
	try {
		const run = ledger.get(value.prepared.runId, principal);
		assert.equal(run.status, 'active');
		assert.equal(run.jobs[0]?.status, 'running');
		assert.equal(run.jobs[0]?.currentAttempt, 1);
		assert.equal(run.jobs[0]?.attempts.length, 1);
		assert.equal(run.jobs[0]?.attempts[0]?.status, 'running');
		assert.equal(run.approvals.filter(({ kind }) => kind === 'multi_repository_execution').length, 1);
		assert.equal(run.audit.filter(({ type }) => type === 'multi_repository.execution_started').length, 1);
	} finally { ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks a dirty or unreadable prepared workspace with zero attempts and zero model calls', async () => {
	const dirty = fixture();
	writeFileSync(join(dirty.workspacePath, 'untracked.txt'), 'unexpected\n');
	const dirtyStore = new MultiRepositoryMemberExecutionReservationStore(dirty.path, now, dirty.policy);
	const dirtyReservation = dirtyStore.reserve({ leaseId: dirty.prepared.id, reason: 'Dirty workspace evidence must block before dispatch.' }, principal, 'dirty');
	try {
		const blocked = await new MultiRepositoryMemberExecutionPreflightService(dirtyStore).run(dirtyReservation.id, principal.id);
		assert.equal(blocked.newlyClaimed, false);
		assert.equal(blocked.reservation.status, 'blocked');
		assert.equal(blocked.reservation.workerCalls, 0);
		assert.deepEqual(blocked.reservation.preflight?.result.violations, ['dirty_worktree']);
	} finally { dirtyStore.close(); }
	let db = new Database(dirty.path);
	try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM attempts').get() as { count: number }).count, 0); }
	finally { db.close(); rmSync(dirty.root, { recursive: true, force: true }); }

	const unreadable = fixture();
	const unreadableStore = new MultiRepositoryMemberExecutionReservationStore(unreadable.path, now, unreadable.policy);
	const unreadableReservation = unreadableStore.reserve({ leaseId: unreadable.prepared.id, reason: 'Inspection failures must block before dispatch.' }, principal, 'unreadable');
	try {
		const blocked = await new MultiRepositoryMemberExecutionPreflightService(unreadableStore, async () => { throw new Error('inspection unavailable'); })
			.run(unreadableReservation.id, principal.id);
		assert.equal(blocked.reservation.status, 'blocked');
		assert.equal(blocked.reservation.workerCalls, 0);
		assert.deepEqual(blocked.reservation.preflight?.result.violations, ['inspection_failed']);
	} finally { unreadableStore.close(); }
	db = new Database(unreadable.path);
	try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM attempts').get() as { count: number }).count, 0); }
	finally { db.close(); rmSync(unreadable.root, { recursive: true, force: true }); }
});

test('serializes concurrent passing preflights into one immutable attempt claim', async () => {
	const value = fixture();
	const firstStore = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	const reservation = firstStore.reserve({ leaseId: value.prepared.id, reason: 'Concurrent preflights must converge on one claim.' }, principal, 'reservation');
	const secondStore = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	const inspector = async () => ({ headCommit: value.baseCommit, dirtyPaths: [] });
	try {
		const claims = await Promise.all([
			new MultiRepositoryMemberExecutionPreflightService(firstStore, inspector).run(reservation.id, principal.id),
			new MultiRepositoryMemberExecutionPreflightService(secondStore, inspector).run(reservation.id, principal.id),
		]);
		assert.deepEqual(claims.map(({ newlyClaimed }) => newlyClaimed).sort(), [false, true]);
		assert.equal(claims[0]?.reservation.attemptId, claims[1]?.reservation.attemptId);
	} finally { secondStore.close(); firstStore.close(); }
	const db = new Database(value.path);
	try {
		assert.equal((db.prepare('SELECT COUNT(*) AS count FROM attempts').get() as { count: number }).count, 1);
		assert.equal((db.prepare('SELECT worker_calls FROM multi_repository_member_execution_reservations WHERE id = ?').get(reservation.id) as { worker_calls: number }).worker_calls, 1);
		db.prepare("UPDATE attempts SET status = 'queued' WHERE id = (SELECT attempt_id FROM multi_repository_member_execution_reservations WHERE id = ?)").run(reservation.id);
	} finally { db.close(); }
	const tampered = new MultiRepositoryMemberExecutionReservationStore(value.path, now, value.policy);
	try { assert.throws(() => tampered.get(reservation.id, principal), MultiRepositoryMemberExecutionReservationConflictError); }
	finally { tampered.close(); rmSync(value.root, { recursive: true, force: true }); }
});
