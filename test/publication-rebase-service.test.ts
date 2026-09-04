import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import type { DraftPatchEvidence } from '../src/control-plane/execution-contracts.ts';
import type { IntegrationCommandRunner } from '../src/control-plane/integration-command-service.ts';
import type { GitHubInstallationAuthority, ScopedInstallationAuthority } from '../src/control-plane/github-installation.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { DraftPublicationService, PublicationPolicyBlockedError } from '../src/control-plane/publication-service.ts';
import {
	PublicationRebaseConflictError,
	PublicationRebaseForbiddenError,
	PublicationRebaseService,
	type PublicationRebaseSourceContext,
} from '../src/control-plane/publication-rebase-service.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const owner = { id: 'operator:rebase-owner' };

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(): RepositoryContract {
	const enrolled = getRepository('frostyard/frostyard-org');
	if (!enrolled) throw new Error('Website fixture is not enrolled');
	return {
		...enrolled,
		qualityGates: [{ id: 'verify', name: 'Verify replay', command: 'verify', kind: 'ci', mutatesWorkspace: false }],
		executionPolicy: { ...enrolled.executionPolicy, requiredGateIds: ['verify'] },
		workspacePreparation: { name: 'Prepare replay', command: 'prepare', timeoutMinutes: 1, networkAccess: false },
	};
}

function fixture(options: { conflict?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-publication-rebase-'));
	const sourceRoot = join(root, 'sources');
	const source = join(sourceRoot, 'frostyard', 'frostyard-org');
	const oldWorkspace = join(root, 'approved-workspace');
	mkdirSync(source, { recursive: true });
	git(source, ['init', '--quiet', '--initial-branch=main']);
	git(source, ['config', 'user.name', 'Bobsled Test']);
	git(source, ['config', 'user.email', 'bobsled@example.invalid']);
	writeFileSync(join(source, 'app.txt'), 'line one\nline two\nline three\n');
	writeFileSync(join(source, 'other.txt'), 'base\n');
	git(source, ['add', '.']); git(source, ['commit', '--quiet', '-m', 'base']);
	const oldBaseCommit = git(source, ['rev-parse', 'HEAD']);
	git(source, ['worktree', 'add', '--quiet', '--detach', oldWorkspace, oldBaseCommit]);
	writeFileSync(join(oldWorkspace, 'app.txt'), 'line one\napproved change\nline three\n');
	const patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', oldBaseCommit, '--'], { cwd: oldWorkspace, encoding: 'utf8' });
	const approvedPatchSha256 = createHash('sha256').update(patch).digest('hex');
	if (options.conflict) writeFileSync(join(source, 'app.txt'), 'line one\nupstream conflict\nline three\n');
	else writeFileSync(join(source, 'other.txt'), 'base\nupstream addition\n');
	git(source, ['add', '.']); git(source, ['commit', '--quiet', '-m', 'advance main']);
	const newBaseCommit = git(source, ['rev-parse', 'HEAD']);
	const evidence: DraftPatchEvidence = {
		baseCommit: oldBaseCommit, headCommit: oldBaseCommit, headMoved: false, changedPaths: ['app.txt'], filesChanged: 1,
		diffLines: 2, diffSha256: approvedPatchSha256, protectedPaths: [], policyViolations: [], gates: [{
			id: 'verify', name: 'Original verification', command: 'verify', status: 'passed', exitCode: 0,
			durationMs: 1, stdout: '', stderr: '', truncated: false,
		}],
		workspacePath: oldWorkspace, evidencePath: join(root, 'old-evidence'),
	};
	const sourcePublicationId = randomUUID();
	const context: PublicationRebaseSourceContext = {
		sourcePublicationId, repository: repository(), evidence, oldBaseCommit, approvedPatchSha256,
	};
	return { root, sourceRoot, source, oldWorkspace, oldBaseCommit, newBaseCommit, sourcePublicationId, context };
}

function makeTrustedSourceStale(value: ReturnType<typeof fixture>, remoteRepositoryId = 'frostyard/frostyard-org'): string {
	const remote = join(value.root, 'remote.git');
	execFileSync('git', ['init', '--quiet', '--bare', remote]);
	git(value.source, ['push', '--quiet', remote, 'main:main']);
	git(value.source, ['reset', '--quiet', '--hard', value.oldBaseCommit]);
	git(value.source, ['reflog', 'expire', '--expire=now', '--all']);
	git(value.source, ['gc', '--quiet', '--prune=now']);
	const githubUrl = `https://github.com/${remoteRepositoryId}.git`;
	git(value.source, ['remote', 'add', 'origin', githubUrl]);
	git(value.source, ['config', `url.file://${remote}/.insteadOf`, githubUrl]);
	return remote;
}

function service(value: ReturnType<typeof fixture>, runner?: IntegrationCommandRunner) {
	const calls: string[] = [];
	const commandRunner: IntegrationCommandRunner = runner ?? (async (command) => {
		calls.push(command);
		return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
	});
	const instance = new PublicationRebaseService({
		path: join(value.root, 'bobsled.db'), workspaceRoot: join(value.root, 'workspaces'), repositorySourceRoot: value.sourceRoot,
		runner: commandRunner, remoteBaseResolver: async () => value.newBaseCommit,
		sourceResolver: (id, principal) => {
			if (principal.id !== owner.id) throw new PublicationRebaseForbiddenError('Source publication belongs to another principal');
			if (id !== value.sourcePublicationId) throw new PublicationRebaseConflictError('Unexpected source publication');
			return value.context;
		},
	});
	return { instance, calls };
}

test('replays the exact approved patch on a descendant base and records zero-model gate evidence', async () => {
	const value = fixture(); const { instance, calls } = service(value);
	try {
		const admitted = instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'Replay the exact approved patch on the current base.' }, owner, 'clean-replay');
		const duplicate = instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'Replay the exact approved patch on the current base.' }, owner, 'clean-replay');
		assert.equal(duplicate.id, admitted.id);
		assert.throws(() => instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'A competing replay must not consume the same source.' }, owner, 'competing-replay'), PublicationRebaseConflictError);
		const result = await instance.execute(admitted.id, owner);
		assert.equal(result.status, 'validated');
		assert.equal(result.oldBaseCommit, value.oldBaseCommit);
		assert.equal(result.newBaseCommit, value.newBaseCommit);
		assert.deepEqual(result.sourceChangedPaths, ['app.txt']);
		assert.deepEqual(result.replayedChangedPaths, ['app.txt']);
		assert.equal(result.modelCalls, 0);
		assert.equal(result.reviewRequired, true);
		assert.equal(result.reviewAuthorized, false);
		assert.equal(result.publicationAuthorized, false);
		assert.deepEqual(calls, ['prepare', 'verify']);
		assert.match(readFileSync(join(result.workspacePath!, 'app.txt'), 'utf8'), /approved change/);
		assert.throws(() => instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'A validated replay cannot be duplicated.' }, owner, 'after-validation'), PublicationRebaseConflictError);
	} finally { instance.close(); }
});

test('fetches an exact missing remote base without advancing or dirtying the trusted checkout', async () => {
	const value = fixture(); makeTrustedSourceStale(value); const { instance, calls } = service(value);
	try {
		assert.equal(git(value.source, ['rev-parse', 'main']), value.oldBaseCommit);
		const admitted = instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'Refresh the trusted source before exact replay.' }, owner, 'source-refresh');
		const result = await instance.execute(admitted.id, owner);
		assert.equal(result.status, 'validated');
		assert.equal(result.newBaseCommit, value.newBaseCommit);
		assert.equal(result.modelCalls, 0);
		assert.deepEqual(calls, ['prepare', 'verify']);
		assert.equal(git(value.source, ['rev-parse', 'main']), value.oldBaseCommit);
		assert.equal(git(value.source, ['rev-parse', 'refs/bobsled/remotes/main']), value.newBaseCommit);
		assert.equal(git(value.source, ['status', '--porcelain=v1', '--untracked-files=all']), '');
	} finally { instance.close(); }
});

test('refuses dirty or unexpected trusted sources before refresh, preparation, or model spend', async () => {
	const dirty = fixture(); makeTrustedSourceStale(dirty); writeFileSync(join(dirty.source, 'untrusted.txt'), 'not part of the trusted source\n');
	const first = service(dirty);
	try {
		const admitted = first.instance.admit({ sourcePublicationId: dirty.sourcePublicationId, reason: 'A dirty trusted source must fail closed.' }, owner, 'dirty-source-refresh');
		const result = await first.instance.execute(admitted.id, owner);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockReason, 'local_source_stale');
		assert.match(result.detail ?? '', /dirty/);
		assert.equal(result.modelCalls, 0);
		assert.deepEqual(first.calls, []);
		assert.equal(git(dirty.source, ['rev-parse', 'main']), dirty.oldBaseCommit);
	} finally { first.instance.close(); }

	const unexpected = fixture(); makeTrustedSourceStale(unexpected, 'frostyard/not-the-enrolled-repository');
	const second = service(unexpected);
	try {
		const admitted = second.instance.admit({ sourcePublicationId: unexpected.sourcePublicationId, reason: 'An unexpected origin must fail closed.' }, owner, 'unexpected-origin-refresh');
		const result = await second.instance.execute(admitted.id, owner);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockReason, 'local_source_stale');
		assert.match(result.detail ?? '', /does not match/);
		assert.equal(result.modelCalls, 0);
		assert.deepEqual(second.calls, []);
		assert.equal(git(unexpected.source, ['rev-parse', 'main']), unexpected.oldBaseCommit);
	} finally { second.instance.close(); }
});

test('rejects a fetched branch that does not equal GitHub’s authoritative commit', async () => {
	const value = fixture(); makeTrustedSourceStale(value);
	const calls: string[] = [];
	const instance = new PublicationRebaseService({
		path: join(value.root, 'bobsled-mismatch.db'), workspaceRoot: join(value.root, 'workspaces-mismatch'), repositorySourceRoot: value.sourceRoot,
		remoteBaseResolver: async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		runner: async (command) => { calls.push(command); return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }; },
		sourceResolver: () => value.context,
	});
	try {
		const admitted = instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'Reject remote evidence that differs from GitHub.' }, owner, 'mismatched-refresh');
		const result = await instance.execute(admitted.id, owner);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockReason, 'local_source_stale');
		assert.match(result.detail ?? '', /does not match GitHub/);
		assert.equal(result.modelCalls, 0);
		assert.deepEqual(calls, []);
		assert.equal(git(value.source, ['rev-parse', 'main']), value.oldBaseCommit);
	} finally { instance.close(); }
});

test('blocks a conflicting exact replay without gates, model calls, or publication authority', async () => {
	const value = fixture({ conflict: true }); const { instance, calls } = service(value);
	try {
		const admitted = instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'Attempt a bounded stale-base replay without implementation.' }, owner, 'conflicting-replay');
		const result = await instance.execute(admitted.id, owner);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockReason, 'patch_conflict');
		assert.deepEqual(result.conflictPaths, ['app.txt']);
		assert.equal(result.modelCalls, 0);
		assert.equal(result.publicationAuthorized, false);
		assert.deepEqual(calls, ['prepare']);
		const superseding = instance.admit({ sourcePublicationId: value.sourcePublicationId, reason: 'A blocked zero-model replay may be superseded safely.' }, owner, 'superseding-replay');
		assert.equal(superseding.status, 'pending');
	} finally { instance.close(); }
});

test('blocks source tampering and post-gate mutation with immutable typed evidence', async () => {
	const tampered = fixture(); const first = service(tampered);
	try {
		const admitted = first.instance.admit({ sourcePublicationId: tampered.sourcePublicationId, reason: 'Detect a changed approved source before replay.' }, owner, 'tampered-source');
		writeFileSync(join(tampered.oldWorkspace, 'app.txt'), 'tampered\n');
		const result = await first.instance.execute(admitted.id, owner);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockReason, 'source_evidence_changed');
		assert.deepEqual(first.calls, []);
	} finally { first.instance.close(); }

	const mutated = fixture();
	const runner: IntegrationCommandRunner = async (command, context) => {
		if (command === 'verify') writeFileSync(join(context.workspacePath, 'app.txt'), `${readFileSync(join(context.workspacePath, 'app.txt'), 'utf8')}gate mutation\n`);
		return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
	};
	const second = service(mutated, runner);
	try {
		const admitted = second.instance.admit({ sourcePublicationId: mutated.sourcePublicationId, reason: 'Detect mutation after trusted gates complete.' }, owner, 'mutating-gate');
		const result = await second.instance.execute(admitted.id, owner);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockReason, 'post_gate_changed');
		assert.equal(result.modelCalls, 0);
	} finally { second.instance.close(); }
});

test('reconstructs stale publication lineage from the durable ledger before replay', async () => {
	const value = fixture(); const databasePath = join(value.root, 'durable-bobsled.db');
	const ledger = new JobLedger(databasePath, () => new Date('2026-09-03T05:00:00.000Z'));
	const workItem = { source: 'manual' as const, key: 'stale-lineage', title: 'Replay approved metadata', body: 'Preserve the approved metadata change.', labels: [] };
	let run = ledger.admit({ repositoryId: 'frostyard/frostyard-org', workItem }, owner, 'stale-lineage-run');
	const execution = ledger.authorizeExecution(run.id, { expectedVersion: run.version, reason: 'Create a durable successful implementation fixture.' }, owner);
	ledger.markExecutionRunning(execution, owner);
	const websiteEvidence = { ...value.context.evidence, gates: [{
		id: 'ci', name: 'Repository CI', command: 'npm run ci', status: 'passed' as const, exitCode: 0,
		durationMs: 1, stdout: '', stderr: '', truncated: false,
	}] };
	run = ledger.completeExecution(execution, 'succeeded', { evidence: websiteEvidence }, [{
		kind: 'draft_patch', uri: 'workspace://stale-lineage/draft.patch', digest: websiteEvidence.diffSha256, metadata: {},
	}], owner);
	const review = ledger.authorizeReview(run.id, { expectedVersion: run.version, reason: 'Record the approved adversarial review fixture.' }, owner, 'policy');
	ledger.markReviewRunning(review, owner);
	const approval = { verdict: 'approve' as const, summary: 'The exact patch is approved.', findings: [], testedClaims: [], residualRisks: [] };
	run = ledger.completeReview(review, 'approved', approval, undefined, { evidence: websiteEvidence }, [{
		kind: 'review_draft_patch', uri: 'workspace://stale-lineage/review.patch', digest: websiteEvidence.diffSha256, metadata: {},
	}], owner);
	const staleAuthority = {
		async withRequest<T>(repositoryId: string, capability: string, use: (authority: ScopedInstallationAuthority) => Promise<T>) {
			assert.equal(repositoryId, 'frostyard/frostyard-org'); assert.equal(capability, 'draft_pr_publish');
			return use({ repository: repositoryId, repositoryId: 1302160246, capability: capability as never, expiresAt: '2026-09-03T06:00:00Z', permissions: {}, request: async () => Response.json({ object: { sha: value.newBaseCommit } }) });
		},
	} as GitHubInstallationAuthority;
	const publications = new DraftPublicationService({ path: databasePath, ledger, authority: staleAuthority });
	const source = await publications.admit({ runId: run.id, expectedVersion: run.version, reason: 'Prepare the approved patch for draft publication.' }, owner, 'stale-publication');
	await assert.rejects(publications.execute(source.id, owner), PublicationPolicyBlockedError);
	assert.match(publications.get(source.id, owner).blockedReason ?? '', /moved beyond/);

	const commands: string[] = [];
	const rebases = new PublicationRebaseService({
		path: databasePath, ledger, workspaceRoot: join(value.root, 'rebase-workspaces'), repositorySourceRoot: value.sourceRoot,
		remoteBaseResolver: async () => value.newBaseCommit,
		runner: async (command) => { commands.push(command); return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }; },
	});
	try {
		const admitted = rebases.admit({ sourcePublicationId: source.id, reason: 'Recover the exact stale approved patch without implementation.' }, owner, 'durable-lineage-replay');
		const result = await rebases.execute(admitted.id, owner);
		assert.equal(result.status, 'validated');
		assert.deepEqual(commands, ['npm ci', 'npm run ci']);
		assert.equal(result.modelCalls, 0);
	} finally { rebases.close(); publications.close(); ledger.close(); }
});
