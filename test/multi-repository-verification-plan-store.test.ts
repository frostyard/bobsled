import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import { MultiRepositoryChangeSetScheduleStore } from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import {
	MultiRepositoryVerificationPlanConflictError,
	MultiRepositoryVerificationPlanForbiddenError,
	MultiRepositoryVerificationPlanStore,
} from '../src/control-plane/multi-repository-verification-plan-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-verification-test' };
const now = () => new Date('2026-09-03T17:00:00.000Z');
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
	objective: 'Require every member result before planning compatibility verification.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Verification execution remains separately authorized.'],
};

function coordinatedRepositories(): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository, multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-verification-'));
	return { root, path: join(root, 'bobsled.db') };
}

function schedule(path: string) {
	const policy = coordinatedRepositories();
	const parents = new MultiRepositoryChangeSetStore(path, now, policy);
	let changeSetId = '';
	try { changeSetId = parents.admit({ plan, reason: 'Persist the coordinated parent before verification planning.' }, principal, 'parent').id; }
	finally { parents.close(); }
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, policy);
	let authorizationId = '';
	try { authorizationId = authorizations.authorize({ changeSetId, reason: 'Authorize the exact coordinated member set.' }, principal, 'authorization').id; }
	finally { authorizations.close(); }
	const schedules = new MultiRepositoryChangeSetScheduleStore(path, now, policy);
	try { return schedules.schedule({ authorizationId, reason: 'Snapshot policy and immutable dependency order.' }, principal, 'schedule'); }
	finally { schedules.close(); }
}

function completeMember(path: string, member: ReturnType<typeof schedule>['members'][number], index: number, approve = true): void {
	const attemptId = `00000000-0000-4000-8000-0000000000${index + 11}`;
	const evidence = {
		baseCommit: commits[index]!, headCommit: commits[index]!, headMoved: false,
		changedPaths: ['README.md'], filesChanged: 1, diffLines: 2, diffSha256: patches[index]!,
		protectedPaths: [], policyViolations: [], gates: [],
		workspacePath: `/tmp/member-${index}`, evidencePath: `/tmp/member-${index}/evidence`,
	};
	const db = new Database(path);
	try {
		db.transaction(() => {
			db.prepare("UPDATE runs SET status='succeeded', updated_at=? WHERE id=?").run(now().toISOString(), member.runId);
			db.prepare("UPDATE jobs SET status='succeeded', current_attempt=1, updated_at=? WHERE id=?").run(now().toISOString(), member.jobId);
			db.prepare("INSERT INTO attempts (id, job_id, number, status, finished_at, outcome_json) VALUES (?, ?, 1, 'succeeded', ?, ?)")
				.run(attemptId, member.jobId, now().toISOString(), JSON.stringify({ evidence }));
			db.prepare("INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, 'draft_patch', ?, ?, '{}', ?)")
				.run(`10000000-0000-4000-8000-0000000000${index + 11}`, member.jobId, attemptId, `workspace://member-${index}/draft.patch`, patches[index], now().toISOString());
			if (approve) {
				db.prepare("INSERT INTO reviews (id, job_id, attempt_id, number, status, finished_at) VALUES (?, ?, ?, 1, 'approved', ?)")
					.run(`20000000-0000-4000-8000-0000000000${index + 11}`, member.jobId, attemptId, now().toISOString());
				db.prepare("INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, 'review_draft_patch', ?, ?, '{}', ?)")
					.run(`30000000-0000-4000-8000-0000000000${index + 11}`, member.jobId, attemptId, `workspace://member-${index}/review.patch`, patches[index], now().toISOString());
			}
		})();
	} finally { db.close(); }
}

test('admits one immutable all-member verification plan without execution or publication authority', () => {
	const value = fixture();
	const scheduled = schedule(value.path);
	completeMember(value.path, scheduled.members[0]!, 0);
	completeMember(value.path, scheduled.members[1]!, 1);
	const store = new MultiRepositoryVerificationPlanStore(value.path, now, coordinatedRepositories());
	try {
		const result = store.admit({ scheduleId: scheduled.id, reason: 'Bind every completed member into compatibility and rollout planning.' }, principal, 'verification');
		assert.equal(result.status, 'ready_for_verification');
		assert.deepEqual(result.result.rolloutLayers, [['frostyard/clix'], ['frostyard/frostyard-org']]);
		assert.deepEqual(result.result.rollbackLayers, [['frostyard/frostyard-org'], ['frostyard/clix']]);
		assert.equal(result.result.compatibilityChecks.length, 1);
		assert.equal(result.result.compatibilityChecks[0]?.repositoryPatchSha256, patches[1]);
		assert.equal(result.result.compatibilityChecks[0]?.dependencyPatchSha256, patches[0]);
		assert.equal(result.result.verificationExecutionAuthorized, false);
		assert.equal(result.result.publicationAuthorized, false);
		assert.equal(result.result.mergeAuthorized, false);
		assert.equal(store.admit({ scheduleId: scheduled.id, reason: 'Bind every completed member into compatibility and rollout planning.' }, principal, 'verification').id, result.id);
		const observer = new MultiRepositoryVerificationPlanStore(value.path, now, coordinatedRepositories());
		try {
			assert.equal(observer.admit({ scheduleId: scheduled.id, reason: 'Bind every completed member into compatibility and rollout planning.' }, principal, 'verification').id, result.id);
		} finally { observer.close(); }
		assert.throws(() => store.get(result.id, { id: 'operator:other' }), MultiRepositoryVerificationPlanForbiddenError);
		const db = new Database(value.path, { readonly: true });
		try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=34').get() as { count: number }).count, 1); }
		finally { db.close(); }
	} finally { store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('refuses partial completion and missing policy-required review evidence', () => {
	const partial = fixture();
	const partialSchedule = schedule(partial.path);
	completeMember(partial.path, partialSchedule.members[0]!, 0);
	const partialStore = new MultiRepositoryVerificationPlanStore(partial.path, now, coordinatedRepositories());
	try {
		assert.throws(() => partialStore.admit({ scheduleId: partialSchedule.id, reason: 'Partial completion must not produce a verification plan.' }, principal, 'partial'), MultiRepositoryVerificationPlanConflictError);
	} finally { partialStore.close(); rmSync(partial.root, { recursive: true, force: true }); }

	const review = fixture();
	const reviewSchedule = schedule(review.path);
	completeMember(review.path, reviewSchedule.members[0]!, 0, false);
	completeMember(review.path, reviewSchedule.members[1]!, 1);
	const reviewStore = new MultiRepositoryVerificationPlanStore(review.path, now, coordinatedRepositories());
	try {
		assert.throws(() => reviewStore.admit({ scheduleId: reviewSchedule.id, reason: 'Missing review evidence must block coordinated verification.' }, principal, 'review'), MultiRepositoryVerificationPlanConflictError);
	} finally { reviewStore.close(); rmSync(review.root, { recursive: true, force: true }); }
});

test('rejects competing plans and fails closed on stored or current evidence drift', () => {
	const value = fixture();
	const scheduled = schedule(value.path);
	completeMember(value.path, scheduled.members[0]!, 0);
	completeMember(value.path, scheduled.members[1]!, 1);
	const store = new MultiRepositoryVerificationPlanStore(value.path, now, coordinatedRepositories());
	let verificationId = '';
	try {
		verificationId = store.admit({ scheduleId: scheduled.id, reason: 'Persist one immutable verification plan for drift tests.' }, principal, 'first').id;
		assert.throws(() => store.admit({ scheduleId: scheduled.id, reason: 'A competing plan cannot replace immutable evidence.' }, principal, 'second'), MultiRepositoryVerificationPlanConflictError);
		assert.throws(() => store.admit({ scheduleId: scheduled.id, reason: 'Changed input cannot reuse an idempotency key.' }, principal, 'first'), MultiRepositoryVerificationPlanConflictError);
	} finally { store.close(); }
	const db = new Database(value.path);
	let originalResult = '';
	try {
		originalResult = (db.prepare('SELECT result_json FROM multi_repository_verification_plans WHERE id=?').get(verificationId) as { result_json: string }).result_json;
		const parsed = JSON.parse(originalResult) as { compatibilityChecks: Array<{ repositoryPatchSha256: string }> };
		parsed.compatibilityChecks[0]!.repositoryPatchSha256 = 'c'.repeat(64);
		const forgedResult = JSON.stringify(parsed);
		db.prepare('UPDATE multi_repository_verification_plans SET result_json=?, result_sha256=? WHERE id=?').run(forgedResult, digest(parsed), verificationId);
	}
	finally { db.close(); }
	const tampered = new MultiRepositoryVerificationPlanStore(value.path, now, coordinatedRepositories());
	try { assert.throws(() => tampered.get(verificationId, principal), MultiRepositoryVerificationPlanConflictError); }
	finally { tampered.close(); }
	const restore = new Database(value.path);
	try {
		restore.prepare('UPDATE multi_repository_verification_plans SET result_json=?, result_sha256=? WHERE id=?').run(originalResult, digest(JSON.parse(originalResult)), verificationId);
		restore.prepare('UPDATE artifacts SET digest=? WHERE kind=? AND job_id=?').run('c'.repeat(64), 'review_draft_patch', scheduled.members[0]!.jobId);
	}
	finally { restore.close(); }
	const drifted = new MultiRepositoryVerificationPlanStore(value.path, now, coordinatedRepositories());
	try { assert.throws(() => drifted.get(verificationId, principal), MultiRepositoryVerificationPlanConflictError); }
	finally { drifted.close(); rmSync(value.root, { recursive: true, force: true }); }
});
