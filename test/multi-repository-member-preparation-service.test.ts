import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import {
	MultiRepositoryMemberPreparationLeaseStore,
	MultiRepositoryPreparationLeaseConflictError,
} from '../src/control-plane/multi-repository-member-preparation-lease-store.ts';
import { MultiRepositoryMemberPreparationService } from '../src/control-plane/multi-repository-member-preparation-service.ts';
import { MultiRepositoryChangeSetScheduleStore } from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:multi-repository-preparation-service-test' };

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
	version: 1 as const, title: 'Prepare a coordinated member workspace',
	objective: 'Create one isolated member workspace without model authority.',
	repositories: [unit('frostyard/clix'), unit('frostyard/frostyard-org', ['frostyard/clix'])],
	assumptions: [], risks: ['Execution remains a later explicit boundary.'],
};

function coordinatedRepositories(): RepositoryContract[] {
	const ids = plan.repositories.map(({ repositoryId }) => repositoryId);
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository, multiRepo: { coordinateWith: ids.filter((id) => id !== repository.id) },
	}));
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(clock = { value: new Date('2026-09-03T16:00:00.000Z') }) {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-multi-repository-preparation-'));
	const path = join(root, 'bobsled.db');
	const sourceRoot = join(root, 'sources');
	const source = join(sourceRoot, 'frostyard', 'clix');
	mkdirSync(source, { recursive: true });
	git(source, ['init', '-b', 'main']);
	writeFileSync(join(source, 'tracked.txt'), 'clean\n');
	git(source, ['add', 'tracked.txt']);
	git(source, ['-c', 'user.name=Bobsled Tests', '-c', 'user.email=bobsled@example.invalid', 'commit', '-m', 'base']);
	const now = () => clock.value;
	const policy = coordinatedRepositories();
	const parents = new MultiRepositoryChangeSetStore(path, now, policy);
	const parent = parents.admit({ plan, reason: 'Persist member lineage before isolated preparation.' }, principal, 'parent');
	parents.close();
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, policy);
	const authorization = authorizations.authorize({ changeSetId: parent.id, reason: 'Authorize the exact coordinated member set.' }, principal, 'authorization');
	authorizations.close();
	const schedules = new MultiRepositoryChangeSetScheduleStore(path, now, policy);
	const schedule = schedules.schedule({ authorizationId: authorization.id, reason: 'Snapshot the dependency-ready repository policies.' }, principal, 'schedule');
	schedules.close();
	const store = new MultiRepositoryMemberPreparationLeaseStore(path, now, policy);
	const lease = store.reserve({
		scheduleId: schedule.id, repositoryId: 'frostyard/clix',
		reason: 'Reserve the root member workspace preparation boundary.',
	}, principal, 'lease');
	return { root, path, sourceRoot, source, workspaceRoot: join(root, 'workspaces'), store, lease, clock, policy };
}

test('creates one isolated clean workspace and persists bounded preparation evidence', async () => {
	const value = fixture();
	let calls = 0;
	const service = new MultiRepositoryMemberPreparationService(value.store, {
		workspaceRoot: value.workspaceRoot, repositorySourceRoot: value.sourceRoot,
		now: () => value.clock.value,
		runner: async (_command, context) => {
			calls += 1;
			assert.equal(context.repository.id, 'frostyard/clix');
			return { status: 'passed', exitCode: 0, durationMs: 12, stdout: 'prepared', stderr: '', truncated: false };
		},
	});
	try {
		const prepared = await service.run(value.lease.id, principal.id);
		assert.equal(prepared.status, 'prepared');
		assert.equal(prepared.workspacePreparationAuthorized, false);
		assert.equal(prepared.modelDispatchAuthorized, false);
		assert.equal(prepared.executionAuthorized, false);
		assert.equal(prepared.preparation?.result.status, 'passed');
		assert.equal(prepared.preparation?.result.workspaceReady, true);
		assert.deepEqual(prepared.preparation?.result.changedPaths, []);
		assert.equal(git(prepared.preparation!.result.workspacePath, ['rev-parse', 'HEAD']), prepared.preparation?.result.baseCommit);
		assert.equal(git(prepared.preparation!.result.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']), '');
		assert.match(readFileSync(join(prepared.preparation!.result.evidencePath, 'workspace-preparation.json'), 'utf8'), /"workspaceReady": true/);
		assert.equal(statSync(join(prepared.preparation!.result.evidencePath, 'workspace-preparation.json')).mode & 0o777, 0o600);
		assert.equal((await service.run(value.lease.id, principal.id)).status, 'prepared');
		assert.equal(calls, 1);
		const db = new Database(value.path);
		try { db.prepare('UPDATE multi_repository_member_preparations SET result_sha256 = ? WHERE lease_id = ?').run('0'.repeat(64), value.lease.id); }
		finally { db.close(); }
		assert.throws(() => value.store.get(value.lease.id, principal), MultiRepositoryPreparationLeaseConflictError);
	} finally { value.store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks a preparation command that changes tracked content and never replays it', async () => {
	const value = fixture();
	let calls = 0;
	const service = new MultiRepositoryMemberPreparationService(value.store, {
		workspaceRoot: value.workspaceRoot, repositorySourceRoot: value.sourceRoot,
		now: () => value.clock.value,
		runner: async (_command, context) => {
			calls += 1;
			writeFileSync(join(context.workspacePath, 'tracked.txt'), 'changed by preparation\n');
			return { status: 'passed', exitCode: 0, durationMs: 5, stdout: '', stderr: '', truncated: false };
		},
	});
	try {
		const blocked = await service.run(value.lease.id, principal.id);
		assert.equal(blocked.status, 'blocked');
		assert.deepEqual(blocked.preparation?.result.violations, ['preparation_changed_workspace']);
		assert.equal(blocked.preparation?.result.workspaceReady, false);
		assert.equal((await service.run(value.lease.id, principal.id)).status, 'blocked');
		assert.equal(calls, 1);
	} finally { value.store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('expires before workspace creation and blocks unavailable sources with zero model authority', async () => {
	const expired = fixture();
	expired.clock.value = new Date('2026-09-03T16:16:00.000Z');
	let expiredCalls = 0;
	const expiredService = new MultiRepositoryMemberPreparationService(expired.store, {
		workspaceRoot: expired.workspaceRoot, repositorySourceRoot: expired.sourceRoot, now: () => expired.clock.value,
		runner: async () => { expiredCalls += 1; return { status: 'passed', exitCode: 0, durationMs: 0, stdout: '', stderr: '', truncated: false }; },
	});
	try {
		const lease = await expiredService.run(expired.lease.id, principal.id);
		assert.equal(lease.status, 'expired');
		assert.equal(lease.preparation, undefined);
		assert.equal(expiredCalls, 0);
	} finally { expired.store.close(); rmSync(expired.root, { recursive: true, force: true }); }

	const missing = fixture();
	let missingCalls = 0;
	const missingService = new MultiRepositoryMemberPreparationService(missing.store, {
		workspaceRoot: missing.workspaceRoot, repositorySourceRoot: join(missing.root, 'missing-sources'), now: () => missing.clock.value,
		runner: async () => { missingCalls += 1; return { status: 'passed', exitCode: 0, durationMs: 0, stdout: '', stderr: '', truncated: false }; },
	});
	try {
		const lease = await missingService.run(missing.lease.id, principal.id);
		assert.equal(lease.status, 'blocked');
		assert.deepEqual(lease.preparation?.result.violations, ['source_unavailable']);
		assert.equal(lease.preparation?.result.modelDispatchAuthorized, false);
		assert.equal(missingCalls, 0);
	} finally { missing.store.close(); rmSync(missing.root, { recursive: true, force: true }); }
});

test('settles an expired ambiguous preparation without rerunning its command', async () => {
	const value = fixture();
	const first = value.store.claimPreparation(value.lease.id, principal);
	assert.equal(first.newlyClaimed, true);
	value.clock.value = new Date('2026-09-03T16:16:00.000Z');
	let calls = 0;
	const service = new MultiRepositoryMemberPreparationService(value.store, {
		workspaceRoot: value.workspaceRoot, repositorySourceRoot: value.sourceRoot, now: () => value.clock.value,
		runner: async () => { calls += 1; return { status: 'passed', exitCode: 0, durationMs: 0, stdout: '', stderr: '', truncated: false }; },
	});
	try {
		const blocked = await service.run(value.lease.id, principal.id);
		assert.equal(blocked.status, 'blocked');
		assert.deepEqual(blocked.preparation?.result.violations, ['preparation_ambiguous']);
		assert.equal(blocked.preparation?.result.preparation, undefined);
		assert.equal(calls, 0);
	} finally { value.store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('serializes preparation claims across database connections', async () => {
	const value = fixture();
	const observerStore = new MultiRepositoryMemberPreparationLeaseStore(value.path, () => value.clock.value, value.policy);
	let calls = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const runner = async () => {
		calls += 1;
		await held;
		return { status: 'passed' as const, exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
	};
	const first = new MultiRepositoryMemberPreparationService(value.store, {
		workspaceRoot: value.workspaceRoot, repositorySourceRoot: value.sourceRoot, runner, now: () => value.clock.value,
	});
	const second = new MultiRepositoryMemberPreparationService(observerStore, {
		workspaceRoot: value.workspaceRoot, repositorySourceRoot: value.sourceRoot, runner, now: () => value.clock.value,
	});
	try {
		const firstRun = first.run(value.lease.id, principal.id);
		while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		const observed = await second.run(value.lease.id, principal.id);
		assert.equal(observed.status, 'preparing');
		assert.equal(calls, 1);
		release();
		assert.equal((await firstRun).status, 'prepared');
		assert.equal(calls, 1);
	} finally { observerStore.close(); value.store.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('caps the preparation command by the lease remaining lifetime', async () => {
	const value = fixture();
	value.clock.value = new Date('2026-09-03T16:14:00.000Z');
	let grantedTimeoutMs = 0;
	const service = new MultiRepositoryMemberPreparationService(value.store, {
		workspaceRoot: value.workspaceRoot, repositorySourceRoot: value.sourceRoot, now: () => value.clock.value,
		runner: async (_command, _context, timeoutMs) => {
			grantedTimeoutMs = timeoutMs;
			return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
		},
	});
	try {
		assert.equal((await service.run(value.lease.id, principal.id)).status, 'prepared');
		assert.equal(grantedTimeoutMs, 60_000);
	} finally { value.store.close(); rmSync(value.root, { recursive: true, force: true }); }
});
