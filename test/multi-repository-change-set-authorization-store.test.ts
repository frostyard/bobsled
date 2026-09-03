import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import {
	MultiRepositoryAuthorizationConflictError,
	MultiRepositoryAuthorizationForbiddenError,
	MultiRepositoryAuthorizationPolicyDriftError,
	MultiRepositoryChangeSetAuthorizationStore,
} from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-authorization-test' };
const now = () => new Date('2026-09-03T14:00:00.000Z');

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
	objective: 'Authorize the participant set without authorizing execution.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Workspace creation remains a later explicit boundary.'],
};

function coordinatedRepositories(): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository, multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

function fixture(): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-authorization-'));
	return { root, path: join(root, 'bobsled.db') };
}

function parent(path: string, repositoryContracts = coordinatedRepositories()) {
	const parents = new MultiRepositoryChangeSetStore(path, now, repositoryContracts);
	try {
		return parents.admit({ plan, reason: 'Create immutable participant jobs before coordinated authorization.' }, principal, 'parent');
	} finally { parents.close(); }
}

test('authorizes the exact pristine member set atomically without granting execution', () => {
	const value = fixture();
	const admitted = parent(value.path);
	const store = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, coordinatedRepositories());
	try {
		const authorized = store.authorize({
			changeSetId: admitted.id,
			reason: 'Authorize only the complete immutable participant set for later coordinated scheduling.',
		}, principal, 'authorize-members');
		assert.equal(authorized.status, 'authorized');
		assert.equal(authorized.coordinationAuthorized, true);
		assert.equal(authorized.workspaceAuthorized, false);
		assert.equal(authorized.modelDispatchAuthorized, false);
		assert.equal(authorized.publicationAuthorized, false);
		assert.deepEqual(authorized.members.map(({ repositoryId }) => repositoryId), plan.repositories.map(({ repositoryId }) => repositoryId));
		assert.match(authorized.memberSetSha256, /^[a-f0-9]{64}$/);
		assert.equal(store.authorize({
			changeSetId: admitted.id,
			reason: 'Authorize only the complete immutable participant set for later coordinated scheduling.',
		}, principal, 'authorize-members').id, authorized.id);
		assert.equal(store.getForChangeSet(admitted.id, principal).id, authorized.id);
		const observer = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, coordinatedRepositories());
		try {
			assert.equal(observer.authorize({
				changeSetId: admitted.id,
				reason: 'Authorize only the complete immutable participant set for later coordinated scheduling.',
			}, principal, 'authorize-members').id, authorized.id);
		} finally { observer.close(); }
		assert.throws(() => store.get(authorized.id, { id: 'operator:other' }), MultiRepositoryAuthorizationForbiddenError);
	} finally { store.close(); }

	const ledger = new JobLedger(value.path, now);
	try {
		for (const member of admitted.members) {
			const run = ledger.get(member.runId, principal);
			assert.equal(run.status, 'blocked');
			assert.equal(run.jobs[0]?.status, 'blocked');
			assert.equal(run.jobs[0]?.currentAttempt, 0);
			assert.equal(run.jobs[0]?.attempts.length, 0);
		}
	} finally { ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('fails closed on revoked coordination consent and pristine-ledger drift', () => {
	const value = fixture();
	const admitted = parent(value.path);
	const drifted = coordinatedRepositories().map((repository, index) => index === 0 ? { ...repository, multiRepo: { coordinateWith: [] } } : repository);
	const policyStore = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, drifted);
	try {
		assert.throws(() => policyStore.authorize({
			changeSetId: admitted.id, reason: 'Revoked coordination consent must block the all-members decision.',
		}, principal, 'policy-drift'), MultiRepositoryAuthorizationPolicyDriftError);
	} finally { policyStore.close(); }
	const unrelatedPolicyEdit = coordinatedRepositories().map((repository, index) => index === 0 ? { ...repository, description: `${repository.description} refreshed` } : repository);
	const allowedStore = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, unrelatedPolicyEdit);
	try {
		assert.equal(allowedStore.authorize({
			changeSetId: admitted.id, reason: 'Unrelated policy metadata must not invalidate current mutual consent.',
		}, principal, 'unrelated-policy-edit').coordinationAuthorized, true);
	} finally { allowedStore.close(); }
	rmSync(value.root, { recursive: true, force: true });

	const stateValue = fixture();
	const stateParent = parent(stateValue.path);

	const db = new Database(stateValue.path);
	try { db.prepare('UPDATE runs SET status = ? WHERE id = ?').run('pending', stateParent.members[0]!.runId); } finally { db.close(); }
	const stateStore = new MultiRepositoryChangeSetAuthorizationStore(stateValue.path, now, coordinatedRepositories());
	try {
		assert.throws(() => stateStore.authorize({
			changeSetId: stateParent.id, reason: 'Changed member state must block coordinated authorization.',
		}, principal, 'state-drift'), MultiRepositoryAuthorizationConflictError);
	} finally { stateStore.close(); rmSync(stateValue.root, { recursive: true, force: true }); }
});

test('rejects competing authorization and fails closed on stored evidence tampering', () => {
	const value = fixture();
	const admitted = parent(value.path);
	const store = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, coordinatedRepositories());
	let authorizationId = '';
	const originalReason = 'Persist one all-members decision and reject competing authority.';
	try {
		authorizationId = store.authorize({
			changeSetId: admitted.id, reason: originalReason,
		}, principal, 'one-decision').id;
		assert.throws(() => store.authorize({
			changeSetId: admitted.id, reason: 'A second decision cannot replace immutable coordinated authority.',
		}, principal, 'second-decision'), MultiRepositoryAuthorizationConflictError);
		assert.throws(() => store.authorize({
			changeSetId: admitted.id, reason: 'Changed input cannot reuse an authorization idempotency key.',
		}, principal, 'one-decision'), MultiRepositoryAuthorizationConflictError);
	} finally { store.close(); }

	const db = new Database(value.path);
	try { db.prepare('UPDATE multi_repository_change_set_authorizations SET reason = ? WHERE id = ?').run('Tampered authorization reason.', authorizationId); } finally { db.close(); }
	const reopened = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, coordinatedRepositories());
	try { assert.throws(() => reopened.get(authorizationId, principal), MultiRepositoryAuthorizationConflictError); }
	finally { reopened.close(); }
	const memberDb = new Database(value.path);
	try {
		memberDb.prepare('UPDATE multi_repository_change_set_authorizations SET reason = ?, member_set_sha256 = ? WHERE id = ?')
			.run(originalReason, '0'.repeat(64), authorizationId);
	} finally { memberDb.close(); }
	const memberReopened = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, coordinatedRepositories());
	try { assert.throws(() => memberReopened.get(authorizationId, principal), MultiRepositoryAuthorizationConflictError); }
	finally { memberReopened.close(); rmSync(value.root, { recursive: true, force: true }); }
});
