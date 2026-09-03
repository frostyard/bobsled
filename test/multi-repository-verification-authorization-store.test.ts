import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { RepositoryContractSchema, type RepositoryContract } from '../src/control-plane/contracts.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import { MultiRepositoryChangeSetScheduleStore } from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import {
	MultiRepositoryVerificationAuthorizationConflictError,
	MultiRepositoryVerificationAuthorizationForbiddenError,
	MultiRepositoryVerificationAuthorizationPolicyError,
	MultiRepositoryVerificationAuthorizationStore,
} from '../src/control-plane/multi-repository-verification-authorization-store.ts';
import { MultiRepositoryVerificationPlanStore } from '../src/control-plane/multi-repository-verification-plan-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-verification-authorization-test' };
const now = () => new Date('2026-09-03T18:00:00.000Z');
const commits = ['1'.repeat(40), '2'.repeat(40)];
const patches = ['a'.repeat(64), 'b'.repeat(64)];

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function unit(repositoryId: string, dependsOn: string[] = []) {
	return {
		repositoryId, title: `Update ${repositoryId}`,
		objective: `Keep ${repositoryId} compatible with the coordinated change.`,
		acceptanceCriteria: [`${repositoryId} passes its declared gates.`], dependsOn,
		compatibilityContracts: dependsOn.map((dependencyRepositoryId) => ({
			dependencyRepositoryId, kind: 'api' as const,
			expectation: `${repositoryId} consumes the updated interface from ${dependencyRepositoryId}.`,
			verification: ['Run the dependent repository compatibility gate.'],
		})),
	};
}

const plan = {
	version: 1 as const, title: 'Coordinate a CLI and website contract',
	objective: 'Authorize only repository-declared compatibility commands.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Execution remains a later one-use boundary.'],
};

function coordinatedRepositories(withGate = true): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository,
		multiRepo: {
			coordinateWith: ids.filter((id) => id !== repository.id),
			compatibilityGates: withGate && repository.id === 'frostyard/frostyard-org' ? [{
				id: 'clix-api', name: 'Verify clix API compatibility', dependencyRepositoryId: 'frostyard/clix',
				command: 'npm run verify:clix-api', timeoutMinutes: 10, mutatesWorkspace: false as const, networkAccess: false as const,
			}] : [],
		},
	}));
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-verification-authorization-'));
	return { root, path: join(root, 'bobsled.db') };
}

function prepare(path: string, policy = coordinatedRepositories()) {
	const parents = new MultiRepositoryChangeSetStore(path, now, policy);
	let changeSetId = '';
	try { changeSetId = parents.admit({ plan, reason: 'Persist the coordinated parent for verification authorization.' }, principal, 'parent').id; }
	finally { parents.close(); }
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, policy);
	let changeSetAuthorizationId = '';
	try { changeSetAuthorizationId = authorizations.authorize({ changeSetId, reason: 'Authorize the exact coordinated member set.' }, principal, 'change-set-authorization').id; }
	finally { authorizations.close(); }
	const schedules = new MultiRepositoryChangeSetScheduleStore(path, now, policy);
	let schedule: ReturnType<MultiRepositoryChangeSetScheduleStore['schedule']>;
	try { schedule = schedules.schedule({ authorizationId: changeSetAuthorizationId, reason: 'Snapshot dependency and compatibility policy.' }, principal, 'schedule'); }
	finally { schedules.close(); }
	for (const [index, member] of schedule.members.entries()) completeMember(path, member, index);
	const verificationPlans = new MultiRepositoryVerificationPlanStore(path, now, policy);
	try { return verificationPlans.admit({ scheduleId: schedule.id, reason: 'Bind all completed member evidence before authorization.' }, principal, 'verification-plan'); }
	finally { verificationPlans.close(); }
}

function completeMember(path: string, member: ReturnType<MultiRepositoryChangeSetScheduleStore['schedule']>['members'][number], index: number): void {
	const attemptId = `00000000-0000-4000-8000-0000000000${index + 21}`;
	const evidence = {
		baseCommit: commits[index]!, headCommit: commits[index]!, headMoved: false,
		changedPaths: ['README.md'], filesChanged: 1, diffLines: 2, diffSha256: patches[index]!,
		protectedPaths: [], policyViolations: [], gates: [], workspacePath: `/tmp/member-${index}`,
		evidencePath: `/tmp/member-${index}/evidence`,
	};
	const db = new Database(path);
	try {
		db.transaction(() => {
			db.prepare("UPDATE runs SET status='succeeded', updated_at=? WHERE id=?").run(now().toISOString(), member.runId);
			db.prepare("UPDATE jobs SET status='succeeded', current_attempt=1, updated_at=? WHERE id=?").run(now().toISOString(), member.jobId);
			db.prepare("INSERT INTO attempts (id, job_id, number, status, finished_at, outcome_json) VALUES (?, ?, 1, 'succeeded', ?, ?)")
				.run(attemptId, member.jobId, now().toISOString(), JSON.stringify({ evidence }));
			db.prepare("INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, 'draft_patch', ?, ?, '{}', ?)")
				.run(`10000000-0000-4000-8000-0000000000${index + 21}`, member.jobId, attemptId, `workspace://member-${index}/draft.patch`, patches[index], now().toISOString());
			db.prepare("INSERT INTO reviews (id, job_id, attempt_id, number, status, finished_at) VALUES (?, ?, ?, 1, 'approved', ?)")
				.run(`20000000-0000-4000-8000-0000000000${index + 21}`, member.jobId, attemptId, now().toISOString());
			db.prepare("INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, 'review_draft_patch', ?, ?, '{}', ?)")
				.run(`30000000-0000-4000-8000-0000000000${index + 21}`, member.jobId, attemptId, `workspace://member-${index}/review.patch`, patches[index], now().toISOString());
		})();
	} finally { db.close(); }
}

test('authorizes the exact scheduled compatibility gate set without granting execution side effects', () => {
	const value = fixture();
	const verificationPlan = prepare(value.path);
	const policy = coordinatedRepositories();
	const store = new MultiRepositoryVerificationAuthorizationStore(value.path, now, policy);
	try {
		const authorization = store.authorize({
			verificationPlanId: verificationPlan.id, reason: 'Authorize only the immutable repository-declared compatibility gate set.',
		}, principal, 'compatibility-authorization');
		assert.equal(authorization.status, 'authorized');
		assert.equal(authorization.gates.length, 1);
		assert.equal(authorization.gates[0]?.gate.id, 'clix-api');
		assert.equal(authorization.gates[0]?.repositoryPatchSha256, patches[1]);
		assert.equal(authorization.gates[0]?.dependencyPatchSha256, patches[0]);
		assert.equal(authorization.compatibilityExecutionAuthorized, true);
		assert.equal(authorization.workspaceMutationAuthorized, false);
		assert.equal(authorization.modelDispatchAuthorized, false);
		assert.equal(authorization.publicationAuthorized, false);
		assert.equal(authorization.rolloutAuthorized, false);
		assert.equal(authorization.mergeAuthorized, false);
		const observer = new MultiRepositoryVerificationAuthorizationStore(value.path, now, policy);
		try {
			assert.equal(observer.authorize({
				verificationPlanId: verificationPlan.id, reason: 'Authorize only the immutable repository-declared compatibility gate set.',
			}, principal, 'compatibility-authorization').id, authorization.id);
		} finally { observer.close(); }
		assert.throws(() => store.get(authorization.id, { id: 'operator:other' }), MultiRepositoryVerificationAuthorizationForbiddenError);
		const db = new Database(value.path, { readonly: true });
		try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=35').get() as { count: number }).count, 1); }
		finally { db.close(); }
	} finally { store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks missing gates and current compatibility-policy drift before authorization', () => {
	const missing = fixture();
	const missingPlan = prepare(missing.path, coordinatedRepositories(false));
	const missingStore = new MultiRepositoryVerificationAuthorizationStore(missing.path, now, coordinatedRepositories(false));
	try {
		assert.throws(() => missingStore.authorize({ verificationPlanId: missingPlan.id, reason: 'Missing repository gates must block shell authority.' }, principal, 'missing'), MultiRepositoryVerificationAuthorizationPolicyError);
	} finally { missingStore.close(); rmSync(missing.root, { recursive: true, force: true }); }

	const drift = fixture();
	const driftPlan = prepare(drift.path);
	const driftStore = new MultiRepositoryVerificationAuthorizationStore(drift.path, now, coordinatedRepositories(false));
	try {
		assert.throws(() => driftStore.authorize({ verificationPlanId: driftPlan.id, reason: 'Changed current gate policy must not inherit stale authority.' }, principal, 'drift'), MultiRepositoryVerificationAuthorizationPolicyError);
	} finally { driftStore.close(); rmSync(drift.root, { recursive: true, force: true }); }
});

test('repository compatibility gates are bounded, unique, non-mutating, and coordination-scoped', () => {
	const repository = coordinatedRepositories()[1]!;
	const gate = repository.multiRepo.compatibilityGates![0]!;
	assert.equal(v.parse(RepositoryContractSchema, repository).multiRepo.compatibilityGates?.length, 1);
	assert.throws(() => v.parse(RepositoryContractSchema, {
		...repository, multiRepo: { ...repository.multiRepo, compatibilityGates: [gate, gate] },
	}));
	assert.throws(() => v.parse(RepositoryContractSchema, {
		...repository, multiRepo: { ...repository.multiRepo, compatibilityGates: [{ ...gate, dependencyRepositoryId: 'frostyard/unknown' }] },
	}));
	assert.throws(() => v.parse(RepositoryContractSchema, {
		...repository, multiRepo: { ...repository.multiRepo, compatibilityGates: [{ ...gate, mutatesWorkspace: true }] },
	}));
	assert.throws(() => v.parse(RepositoryContractSchema, {
		...repository, multiRepo: { ...repository.multiRepo, compatibilityGates: [{ ...gate, networkAccess: true }] },
	}));
});

test('rejects competing authorization and a forged schema-valid gate set with matching digest', () => {
	const value = fixture();
	const verificationPlan = prepare(value.path);
	const policy = coordinatedRepositories();
	const store = new MultiRepositoryVerificationAuthorizationStore(value.path, now, policy);
	let authorizationId = '';
	try {
		authorizationId = store.authorize({ verificationPlanId: verificationPlan.id, reason: 'Persist one immutable compatibility execution decision.' }, principal, 'first').id;
		assert.throws(() => store.authorize({ verificationPlanId: verificationPlan.id, reason: 'A competing decision cannot replace the first.' }, principal, 'second'), MultiRepositoryVerificationAuthorizationConflictError);
		assert.throws(() => store.authorize({ verificationPlanId: verificationPlan.id, reason: 'Changed input cannot reuse the first key.' }, principal, 'first'), MultiRepositoryVerificationAuthorizationConflictError);
	} finally { store.close(); }
	const db = new Database(value.path);
	try {
		const row = db.prepare('SELECT gates_json FROM multi_repository_verification_authorizations WHERE id=?').get(authorizationId) as { gates_json: string };
		const gates = JSON.parse(row.gates_json) as Array<{ gate: { command: string } }>;
		gates[0]!.gate.command = 'echo forged';
		db.prepare('UPDATE multi_repository_verification_authorizations SET gates_json=?, gate_set_sha256=? WHERE id=?').run(JSON.stringify(gates), digest(gates), authorizationId);
	} finally { db.close(); }
	const reopened = new MultiRepositoryVerificationAuthorizationStore(value.path, now, policy);
	try { assert.throws(() => reopened.get(authorizationId, principal), MultiRepositoryVerificationAuthorizationConflictError); }
	finally { reopened.close(); rmSync(value.root, { recursive: true, force: true }); }
});
