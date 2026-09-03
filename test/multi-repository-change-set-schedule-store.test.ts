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
	MultiRepositoryChangeSetScheduleStore,
	MultiRepositoryScheduleConflictError,
	MultiRepositoryScheduleForbiddenError,
	MultiRepositorySchedulePolicyError,
} from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-schedule-test' };
const now = () => new Date('2026-09-03T15:00:00.000Z');

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
	objective: 'Schedule repository work without authorizing workspace creation.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Member preparation remains a later explicit boundary.'],
};

function coordinatedRepositories(): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository, multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

function fixture(): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-schedule-'));
	return { root, path: join(root, 'bobsled.db') };
}

function authorize(path: string, policy = coordinatedRepositories()) {
	const parents = new MultiRepositoryChangeSetStore(path, now, policy);
	let changeSetId = '';
	try {
		changeSetId = parents.admit({ plan, reason: 'Persist the complete repository parent set before scheduling.' }, principal, 'parent').id;
	} finally { parents.close(); }
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, policy);
	try {
		return authorizations.authorize({
			changeSetId, reason: 'Authorize the immutable participant set for coordinated scheduling only.',
		}, principal, 'authorization');
	} finally { authorizations.close(); }
}

test('schedules dependency-ready members with current policy snapshots but no execution authority', () => {
	const value = fixture();
	const authorization = authorize(value.path);
	const current = coordinatedRepositories().map((repository, index) => index === 0 ? {
		...repository, executionPolicy: { ...repository.executionPolicy, maxDiffLines: repository.executionPolicy.maxDiffLines + 1 },
	} : repository);
	const store = new MultiRepositoryChangeSetScheduleStore(value.path, now, current);
	try {
		const scheduled = store.schedule({
			authorizationId: authorization.id, reason: 'Snapshot current execution policy and derive dependency-ready repository members.',
		}, principal, 'schedule');
		assert.equal(scheduled.status, 'scheduled');
		assert.deepEqual(scheduled.dependencyLayers, [['frostyard/clix'], ['frostyard/frostyard-org']]);
		assert.deepEqual(scheduled.members.map(({ state }) => state), ['eligible', 'waiting']);
		assert.equal(scheduled.members[0]?.policySnapshot.executionPolicy.maxDiffLines, current[0]?.executionPolicy.maxDiffLines);
		assert.equal(scheduled.schedulingAuthorized, true);
		assert.equal(scheduled.preparationAuthorized, false);
		assert.equal(scheduled.modelDispatchAuthorized, false);
		assert.equal(scheduled.publicationAuthorized, false);
		assert.equal(store.getForAuthorization(authorization.id, principal).id, scheduled.id);
		const observer = new MultiRepositoryChangeSetScheduleStore(value.path, now, current);
		try {
			assert.equal(observer.schedule({
				authorizationId: authorization.id, reason: 'Snapshot current execution policy and derive dependency-ready repository members.',
			}, principal, 'schedule').id, scheduled.id);
		} finally { observer.close(); }
		assert.throws(() => store.get(scheduled.id, { id: 'operator:other' }), MultiRepositoryScheduleForbiddenError);
	} finally { store.close(); }

	const ledger = new JobLedger(value.path, now);
	try {
		for (const member of authorization.members) {
			const run = ledger.get(member.runId, principal);
			assert.equal(run.status, 'blocked');
			assert.equal(run.jobs[0]?.status, 'blocked');
			assert.equal(run.jobs[0]?.attempts.length, 0);
		}
	} finally { ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks revoked coordination, disabled execution, and changed member state', () => {
	const consentValue = fixture();
	const consentAuthorization = authorize(consentValue.path);
	const revoked = coordinatedRepositories().map((repository, index) => index === 0 ? { ...repository, multiRepo: { coordinateWith: [] } } : repository);
	const consentStore = new MultiRepositoryChangeSetScheduleStore(consentValue.path, now, revoked);
	try {
		assert.throws(() => consentStore.schedule({ authorizationId: consentAuthorization.id, reason: 'Revoked mutual consent must block scheduling.' }, principal, 'revoked'), MultiRepositorySchedulePolicyError);
	} finally { consentStore.close(); rmSync(consentValue.root, { recursive: true, force: true }); }

	const executionValue = fixture();
	const executionAuthorization = authorize(executionValue.path);
	const disabled = coordinatedRepositories().map((repository, index) => index === 0 ? {
		...repository, executionPolicy: { ...repository.executionPolicy, enabled: false },
	} : repository);
	const executionStore = new MultiRepositoryChangeSetScheduleStore(executionValue.path, now, disabled);
	try {
		assert.throws(() => executionStore.schedule({ authorizationId: executionAuthorization.id, reason: 'Disabled execution must block scheduling.' }, principal, 'disabled'), MultiRepositorySchedulePolicyError);
	} finally { executionStore.close(); rmSync(executionValue.root, { recursive: true, force: true }); }

	const stateValue = fixture();
	const stateAuthorization = authorize(stateValue.path);
	const db = new Database(stateValue.path);
	try { db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('admitted', stateAuthorization.members[0]!.jobId); } finally { db.close(); }
	const stateStore = new MultiRepositoryChangeSetScheduleStore(stateValue.path, now, coordinatedRepositories());
	try {
		assert.throws(() => stateStore.schedule({ authorizationId: stateAuthorization.id, reason: 'Changed member state must block scheduling.' }, principal, 'state'), MultiRepositoryScheduleConflictError);
	} finally { stateStore.close(); rmSync(stateValue.root, { recursive: true, force: true }); }
});

test('rejects competing schedules and fails closed on schedule evidence tampering', () => {
	const value = fixture();
	const authorization = authorize(value.path);
	const store = new MultiRepositoryChangeSetScheduleStore(value.path, now, coordinatedRepositories());
	let scheduleId = '';
	try {
		scheduleId = store.schedule({
			authorizationId: authorization.id, reason: 'Persist one immutable schedule for the authorized participant set.',
		}, principal, 'first').id;
		assert.throws(() => store.schedule({
			authorizationId: authorization.id, reason: 'A competing schedule cannot replace the first schedule.',
		}, principal, 'second'), MultiRepositoryScheduleConflictError);
		assert.throws(() => store.schedule({
			authorizationId: authorization.id, reason: 'Changed input cannot reuse the schedule idempotency key.',
		}, principal, 'first'), MultiRepositoryScheduleConflictError);
	} finally { store.close(); }

	const db = new Database(value.path);
	try { db.prepare('UPDATE multi_repository_change_set_schedule_members SET state = ? WHERE schedule_id = ? AND repository_id = ?').run('eligible', scheduleId, 'frostyard/frostyard-org'); }
	finally { db.close(); }
	const reopened = new MultiRepositoryChangeSetScheduleStore(value.path, now, coordinatedRepositories());
	try { assert.throws(() => reopened.get(scheduleId, principal), MultiRepositoryScheduleConflictError); }
	finally { reopened.close(); rmSync(value.root, { recursive: true, force: true }); }
});
