import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from '../src/control-plane/multi-repository-change-set-authorization-store.ts';
import { MultiRepositoryChangeSetScheduleStore } from '../src/control-plane/multi-repository-change-set-schedule-store.ts';
import { MultiRepositoryChangeSetStore } from '../src/control-plane/multi-repository-change-set-store.ts';
import { MultiRepositoryCompatibilityExecutionService } from '../src/control-plane/multi-repository-compatibility-execution-service.ts';
import { runIsolatedCompatibilityCommand } from '../src/control-plane/multi-repository-compatibility-command-service.ts';
import {
	MultiRepositoryCompatibilityExecutionConflictError,
	MultiRepositoryCompatibilityExecutionForbiddenError,
	MultiRepositoryCompatibilityExecutionStore,
} from '../src/control-plane/multi-repository-compatibility-execution-store.ts';
import { MultiRepositoryVerificationAuthorizationStore } from '../src/control-plane/multi-repository-verification-authorization-store.ts';
import { MultiRepositoryVerificationPlanStore } from '../src/control-plane/multi-repository-verification-plan-store.ts';
import {
	MultiRepositoryPublicationAuthorizationConflictError,
	MultiRepositoryPublicationAuthorizationForbiddenError,
	MultiRepositoryPublicationAuthorizationPolicyError,
	MultiRepositoryPublicationAuthorizationStore,
} from '../src/control-plane/multi-repository-publication-authorization-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal = { id: 'operator:compatibility-execution-test' };
const now = () => new Date('2026-09-03T19:00:00.000Z');

function coordinatedRepositories(): RepositoryContract[] {
	const ids = ['frostyard/clix', 'frostyard/frostyard-org'];
	return repositories.filter(({ id }) => ids.includes(id)).map((repository) => ({
		...repository,
		readOnly: false,
		capabilities: { ...repository.capabilities, writeCode: true, writeGitHub: true },
		publicationPolicy: { ...repository.publicationPolicy, enabled: true },
		multiRepo: {
			coordinateWith: ids.filter((id) => id !== repository.id),
			compatibilityGates: repository.id === 'frostyard/frostyard-org' ? [{
				id: 'clix-api', name: 'Verify clix API compatibility', dependencyRepositoryId: 'frostyard/clix',
				command: 'node scripts/verify-clix.mjs', timeoutMinutes: 1, mutatesWorkspace: false as const, networkAccess: false as const,
			}] : [],
		},
	}));
}

const plan = {
	version: 1 as const, title: 'Coordinate CLI and website', objective: 'Verify a dependency edge.', assumptions: [], risks: [],
	repositories: [
		{ repositoryId: 'frostyard/clix', title: 'Update clix', objective: 'Change the interface.', acceptanceCriteria: ['Patch passes.'], dependsOn: [], compatibilityContracts: [] },
		{ repositoryId: 'frostyard/frostyard-org', title: 'Update website', objective: 'Consume the interface.', acceptanceCriteria: ['Patch passes.'], dependsOn: ['frostyard/clix'], compatibilityContracts: [{ dependencyRepositoryId: 'frostyard/clix', kind: 'api' as const, expectation: 'Website consumes the interface.', verification: ['Run compatibility gate.'] }] },
	],
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-compatibility-execution-'));
	const workspaceRoot = join(root, 'workspaces'); mkdirSync(workspaceRoot, { recursive: true });
	return { root, path: join(root, 'bobsled.db'), workspaceRoot };
}

function memberWorkspace(workspaceRoot: string, index: number) {
	const workspacePath = join(workspaceRoot, `member-${index}`); mkdirSync(workspacePath, { recursive: true });
	execFileSync('git', ['init', '-q'], { cwd: workspacePath });
	execFileSync('git', ['config', 'user.name', 'Bobsled Test'], { cwd: workspacePath });
	execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workspacePath });
	writeFileSync(join(workspacePath, 'README.md'), `base-${index}\n`);
	execFileSync('git', ['add', '.'], { cwd: workspacePath }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: workspacePath });
	const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, encoding: 'utf8' }).trim();
	writeFileSync(join(workspacePath, 'README.md'), `base-${index}\nchange-${index}\n`);
	const patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', baseCommit, '--'], { cwd: workspacePath });
	const patchSha256 = createHash('sha256').update(patch).digest('hex');
	const artifact = join(workspaceRoot, `artifact-${index}.patch`); writeFileSync(artifact, patch);
	return { workspacePath, baseCommit, patchSha256, artifact };
}

function prepare(value: ReturnType<typeof fixture>) {
	const policy = coordinatedRepositories();
	const parents = new MultiRepositoryChangeSetStore(value.path, now, policy);
	const changeSet = parents.admit({ plan, reason: 'Persist the compatibility execution parent.' }, principal, 'parent'); parents.close();
	const authorizations = new MultiRepositoryChangeSetAuthorizationStore(value.path, now, policy);
	const parentAuthorization = authorizations.authorize({ changeSetId: changeSet.id, reason: 'Authorize the exact member set.' }, principal, 'parent-auth'); authorizations.close();
	const schedules = new MultiRepositoryChangeSetScheduleStore(value.path, now, policy);
	const schedule = schedules.schedule({ authorizationId: parentAuthorization.id, reason: 'Schedule the dependency graph.' }, principal, 'schedule'); schedules.close();
	const workspaces = schedule.members.map((member, index) => ({ member, ...memberWorkspace(value.workspaceRoot, index) }));
	const db = new Database(value.path);
	try {
		db.transaction(() => {
			for (const [index, item] of workspaces.entries()) {
				const attemptId = `00000000-0000-4000-8000-0000000000${index + 61}`;
				const reviewId = `10000000-0000-4000-8000-0000000000${index + 61}`;
				const evidence = { baseCommit: item.baseCommit, headCommit: item.baseCommit, headMoved: false, changedPaths: ['README.md'], filesChanged: 1, diffLines: 1, diffSha256: item.patchSha256, protectedPaths: [], policyViolations: [], gates: [], workspacePath: item.workspacePath, evidencePath: join(value.workspaceRoot, `evidence-${index}`) };
				db.prepare("UPDATE runs SET status='succeeded', updated_at=? WHERE id=?").run(now().toISOString(), item.member.runId);
				db.prepare("UPDATE jobs SET status='succeeded', current_attempt=1, updated_at=? WHERE id=?").run(now().toISOString(), item.member.jobId);
				db.prepare("INSERT INTO attempts (id, job_id, number, status, finished_at, outcome_json) VALUES (?, ?, 1, 'succeeded', ?, ?)").run(attemptId, item.member.jobId, now().toISOString(), JSON.stringify({ evidence }));
				db.prepare("INSERT INTO reviews (id, job_id, attempt_id, number, status, outcome_json, finished_at) VALUES (?, ?, ?, 1, 'approved', ?, ?)").run(reviewId, item.member.jobId, attemptId, JSON.stringify({ evidence }), now().toISOString());
				db.prepare("INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, 'review_draft_patch', ?, ?, ?, ?)").run(`20000000-0000-4000-8000-0000000000${index + 61}`, item.member.jobId, attemptId, `workspace://${item.artifact.slice(value.workspaceRoot.length + 1)}`, item.patchSha256, JSON.stringify({ reviewId }), now().toISOString());
			}
		})();
	} finally { db.close(); }
	const plans = new MultiRepositoryVerificationPlanStore(value.path, now, policy);
	const verificationPlan = plans.admit({ scheduleId: schedule.id, reason: 'Bind completed member evidence.' }, principal, 'plan'); plans.close();
	const auths = new MultiRepositoryVerificationAuthorizationStore(value.path, now, policy);
	const authorization = auths.authorize({ verificationPlanId: verificationPlan.id, reason: 'Authorize the declared compatibility gate.' }, principal, 'compat-auth'); auths.close();
	const executions = new MultiRepositoryCompatibilityExecutionStore(value.path, now, policy);
	const execution = executions.reserve({ authorizationId: authorization.id, reason: 'Run the exact compatibility gate once.' }, principal, 'execution'); executions.close();
	return { policy, execution, workspaces };
}

test('runs the authorized compatibility gate once and preserves all member workspaces', async () => {
	const value = fixture(); const prepared = prepare(value); let calls = 0;
	const store = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	const service = new MultiRepositoryCompatibilityExecutionService({ path: value.path, store, workspaceRoot: value.workspaceRoot, runner: async (_command, context) => {
		calls += 1; assert.equal(context.manifest.members.length, 2); assert.equal(readFileSync(context.manifestPath, 'utf8').includes('frostyard/clix'), true);
		return { status: 'passed', exitCode: 0, durationMs: 5, stdout: 'compatible\n', stderr: '', truncated: false };
	} });
	try {
		const result = await service.run(prepared.execution.id, principal.id);
		assert.equal(result.status, 'succeeded'); assert.equal(result.commandsStarted, 1); assert.equal(calls, 1);
		assert.equal((await service.run(prepared.execution.id, principal.id)).status, 'succeeded'); assert.equal(calls, 1);
		for (const [index, item] of prepared.workspaces.entries()) assert.equal(readFileSync(join(item.workspacePath, 'README.md'), 'utf8'), `base-${index}\nchange-${index}\n`);
		const db = new Database(value.path, { readonly: true });
		try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=36').get() as { count: number }).count, 1); }
		finally { db.close(); }
	} finally { service.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks workspace mutation and serializes the one-use execution claim', async () => {
	const value = fixture(); const prepared = prepare(value); let calls = 0;
	const first = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	const service = new MultiRepositoryCompatibilityExecutionService({ path: value.path, store: first, workspaceRoot: value.workspaceRoot, runner: async (_command, context) => {
		calls += 1; writeFileSync(join(context.targetWorkspacePath, 'README.md'), 'tampered\n');
		return { status: 'passed', exitCode: 0, durationMs: 5, stdout: '', stderr: '', truncated: false };
	} });
	try {
		const result = await service.run(prepared.execution.id, principal.id);
		assert.equal(result.status, 'blocked'); assert.match(result.result?.reason ?? '', /changed/); assert.equal(calls, 1);
		const observer = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
		try { assert.equal(observer.claim(prepared.execution.id, principal).newlyClaimed, false); }
		finally { observer.close(); }
	} finally { service.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('fails before command authority when trusted patch bytes are changed', async () => {
	const value = fixture(); const prepared = prepare(value); let calls = 0;
	writeFileSync(prepared.workspaces[0]!.artifact, 'forged');
	const store = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	const service = new MultiRepositoryCompatibilityExecutionService({ path: value.path, store, workspaceRoot: value.workspaceRoot, runner: async () => {
		calls += 1; return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
	} });
	try {
		await assert.rejects(service.run(prepared.execution.id, principal.id), /patch bytes changed/);
		assert.equal(calls, 0); assert.equal(store.get(prepared.execution.id, principal).status, 'reserved');
	} finally { service.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('serializes claims and command starts across database connections', () => {
	const value = fixture(); const prepared = prepare(value);
	const manifest = { version: 1 as const, executionId: prepared.execution.id, members: prepared.workspaces.map((item) => ({ repositoryId: item.member.repositoryId, baseCommit: item.baseCommit, patchSha256: item.patchSha256, workspacePath: item.workspacePath })), workspaceMutationAuthorized: false as const, networkAccessAuthorized: false as const };
	const first = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	const second = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	try {
		first.recordPreflight(prepared.execution.id, manifest, principal);
		assert.equal(first.claim(prepared.execution.id, principal).newlyClaimed, true);
		assert.equal(second.claim(prepared.execution.id, principal).newlyClaimed, false);
		first.recordCommandStart(prepared.execution.id, principal, 0);
		assert.throws(() => second.recordCommandStart(prepared.execution.id, principal, 0), MultiRepositoryCompatibilityExecutionConflictError);
		assert.throws(() => second.get(prepared.execution.id, { id: 'operator:other' }), MultiRepositoryCompatibilityExecutionForbiddenError);
		assert.throws(() => second.reserve({ authorizationId: prepared.execution.authorizationId, reason: 'Changed replay input cannot reuse the key.' }, principal, 'execution'), MultiRepositoryCompatibilityExecutionConflictError);
	} finally { second.close(); first.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('authorizes one immutable all-member publication barrier after compatibility success', async () => {
	const value = fixture(); const prepared = prepare(value);
	const executionStore = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	const executionService = new MultiRepositoryCompatibilityExecutionService({
		path: value.path, store: executionStore, workspaceRoot: value.workspaceRoot,
		runner: async () => ({ status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }),
	});
	try {
		const execution = await executionService.run(prepared.execution.id, principal.id);
		assert.equal(execution.status, 'succeeded');
		const first = new MultiRepositoryPublicationAuthorizationStore(value.path, now, prepared.policy);
		const second = new MultiRepositoryPublicationAuthorizationStore(value.path, now, prepared.policy);
		try {
			const authorization = first.authorize({ compatibilityExecutionId: execution.id, reason: 'Bind every approved patch before any linked draft publication.' }, principal, 'publication-barrier');
			assert.equal(authorization.status, 'ready_for_linked_publication');
			assert.equal(authorization.publicationBarrierSatisfied, true);
			assert.equal(authorization.draftPublicationExecutionAuthorized, false);
			assert.equal(authorization.githubMutationAuthorized, false);
			assert.equal(authorization.rolloutAuthorized, false);
			assert.equal(authorization.mergeAuthorized, false);
			assert.deepEqual(authorization.rolloutLayers, [['frostyard/clix'], ['frostyard/frostyard-org']]);
			assert.deepEqual(authorization.rollbackLayers, [['frostyard/frostyard-org'], ['frostyard/clix']]);
			assert.equal(authorization.members.length, 2);
			assert.equal(authorization.members.every((member) => member.filesChanged === 1 && member.policySnapshot.publicationPolicy.enabled), true);
			assert.equal(second.authorize({ compatibilityExecutionId: execution.id, reason: 'Bind every approved patch before any linked draft publication.' }, principal, 'publication-barrier').id, authorization.id);
			assert.throws(() => second.authorize({ compatibilityExecutionId: execution.id, reason: 'Competing linked publication authorization is not allowed.' }, principal, 'publication-barrier-2'), MultiRepositoryPublicationAuthorizationConflictError);
			assert.throws(() => second.get(authorization.id, { id: 'operator:other' }), MultiRepositoryPublicationAuthorizationForbiddenError);
			const db = new Database(value.path);
			try {
				assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=37').get() as { count: number }).count, 1);
				const stored = db.prepare('SELECT members_json FROM multi_repository_publication_authorizations WHERE id=?').get(authorization.id) as { members_json: string };
				const members = JSON.parse(stored.members_json) as Array<Record<string, unknown>>;
				members[0]!.patchSha256 = 'f'.repeat(64);
				db.prepare('UPDATE multi_repository_publication_authorizations SET members_json=? WHERE id=?').run(JSON.stringify(members), authorization.id);
			} finally { db.close(); }
			assert.throws(() => first.get(authorization.id, principal), MultiRepositoryPublicationAuthorizationConflictError);
		} finally { second.close(); first.close(); }
	} finally { executionService.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('blocks linked publication before side effects when compatibility or current policy is insufficient', async () => {
	const value = fixture(); const prepared = prepare(value);
	const beforeExecution = new MultiRepositoryPublicationAuthorizationStore(value.path, now, prepared.policy);
	try {
		assert.throws(() => beforeExecution.authorize({ compatibilityExecutionId: prepared.execution.id, reason: 'Compatibility has not reached a publishable terminal state.' }, principal, 'too-early'), MultiRepositoryPublicationAuthorizationConflictError);
	} finally { beforeExecution.close(); }
	const executionStore = new MultiRepositoryCompatibilityExecutionStore(value.path, now, prepared.policy);
	const executionService = new MultiRepositoryCompatibilityExecutionService({
		path: value.path, store: executionStore, workspaceRoot: value.workspaceRoot,
		runner: async () => ({ status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }),
	});
	try {
		const execution = await executionService.run(prepared.execution.id, principal.id);
		const revoked = prepared.policy.map((repository) => repository.id === 'frostyard/clix'
			? { ...repository, publicationPolicy: { ...repository.publicationPolicy, enabled: false } }
			: repository);
		const publications = new MultiRepositoryPublicationAuthorizationStore(value.path, now, revoked);
		try {
			assert.throws(() => publications.authorize({ compatibilityExecutionId: execution.id, reason: 'Current policy must authorize every linked draft.' }, principal, 'policy-blocked'), MultiRepositoryPublicationAuthorizationPolicyError);
			const db = new Database(value.path, { readonly: true });
			try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM multi_repository_publication_authorizations').get() as { count: number }).count, 0); }
			finally { db.close(); }
		} finally { publications.close(); }
	} finally { executionService.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('Linux runner removes networking and bind-mounts every peer workspace read-only', {
	skip: process.platform !== 'linux' || spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--net', 'true']).status !== 0,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-compatibility-isolation-'));
	const first = join(root, 'first'); const second = join(root, 'second'); const home = join(root, 'home');
	mkdirSync(first); mkdirSync(second); mkdirSync(join(home, 'tmp'), { recursive: true }); writeFileSync(join(first, 'file'), 'original');
	const outside = join(root, 'outside'); writeFileSync(outside, 'original');
	const manifest = { version: 1 as const, executionId: '00000000-0000-4000-8000-000000000099', members: [
		{ repositoryId: 'frostyard/clix', baseCommit: '1'.repeat(40), patchSha256: 'a'.repeat(64), workspacePath: first },
		{ repositoryId: 'frostyard/frostyard-org', baseCommit: '2'.repeat(40), patchSha256: 'b'.repeat(64), workspacePath: second },
	], workspaceMutationAuthorized: false as const, networkAccessAuthorized: false as const };
	const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
	try {
		const isolated = await runIsolatedCompatibilityCommand("node -e \"process.stdout.write('node-ok')\" && ! grep -q 'eth0:' /proc/net/dev && printf okay > \"$HOME/probe\"", { manifestPath, manifest, targetWorkspacePath: first, sandboxHomePath: home, toolDataPath: root, executablePath: '/usr/bin:/bin' }, 10_000);
		assert.equal(isolated.status, 'passed', isolated.stderr);
		assert.equal(isolated.stdout, 'node-ok');
		const mutation = await runIsolatedCompatibilityCommand('printf changed >> file', { manifestPath, manifest, targetWorkspacePath: first, sandboxHomePath: home, toolDataPath: root, executablePath: '/usr/bin:/bin' }, 10_000);
		assert.equal(mutation.status, 'failed'); assert.equal(readFileSync(join(first, 'file'), 'utf8'), 'original');
		const outsideMutation = await runIsolatedCompatibilityCommand(`printf changed >> "${outside}"`, { manifestPath, manifest, targetWorkspacePath: first, sandboxHomePath: home, toolDataPath: root, executablePath: '/usr/bin:/bin' }, 10_000);
		assert.equal(outsideMutation.status, 'failed'); assert.equal(readFileSync(outside, 'utf8'), 'original');
	} finally { rmSync(root, { recursive: true, force: true }); }
});
