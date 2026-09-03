import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import type { DraftPatchEvidence, ReviewOutcome } from '../src/control-plane/execution-contracts.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import {
	PublicationRebaseReviewConflictError,
	PublicationRebaseReviewService,
} from '../src/control-plane/publication-rebase-review-service.ts';
import { PublicationRebaseService, type PublicationRebaseSourceContext } from '../src/control-plane/publication-rebase-service.ts';
import { DraftPublicationService } from '../src/control-plane/publication-service.ts';
import { getRepository } from '../src/control-plane/repositories.ts';
import type { ReviewWorkerRunner } from '../src/control-plane/review-worker-service.ts';

const principal = { id: 'operator:rebase-review' };
const plan = { summary: 'Update one bounded file.', tasks: [{ id: 'implementation' as const, objective: 'Update app.txt.', expectedPaths: ['app.txt'], acceptanceCriteria: ['The requested line is present.'] }], assumptions: [], risks: [] };
const implementationResult = { disposition: 'changed' as const, summary: 'Updated app.txt.', changedPaths: ['app.txt'], testsRun: ['verify'], notes: [] };

function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function repository(): RepositoryContract {
	const value = getRepository('frostyard/frostyard-org'); if (!value) throw new Error('Website fixture is not enrolled');
	return {
		...value,
		qualityGates: [{ id: 'verify', name: 'Verify replay', command: 'verify', kind: 'ci', mutatesWorkspace: false }],
		executionPolicy: { ...value.executionPolicy, requiredGateIds: ['verify'] },
		workspacePreparation: { name: 'Prepare replay', command: 'prepare', timeoutMinutes: 1, networkAccess: false },
	};
}

function approvingOutcome(reviewId: string): ReviewOutcome {
	return { conversationId: `conversation-${reviewId}`, submissionId: `submission-${reviewId}`, text: 'Approved.', report: { verdict: 'approve', summary: 'The replayed patch is correct.', findings: [], testedClaims: ['Trusted gates passed.'], residualRisks: [] } };
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-rebase-review-'));
	const sourceRoot = join(root, 'sources'); const source = join(sourceRoot, 'frostyard', 'frostyard-org');
	const approvedWorkspace = join(root, 'approved'); mkdirSync(source, { recursive: true });
	git(source, ['init', '--quiet', '--initial-branch=main']); git(source, ['config', 'user.name', 'Bobsled Test']); git(source, ['config', 'user.email', 'bobsled@example.invalid']);
	writeFileSync(join(source, 'app.txt'), 'one\ntwo\nthree\n'); writeFileSync(join(source, 'other.txt'), 'base\n');
	git(source, ['add', '.']); git(source, ['commit', '--quiet', '-m', 'base']); const oldBaseCommit = git(source, ['rev-parse', 'HEAD']);
	git(source, ['worktree', 'add', '--quiet', '--detach', approvedWorkspace, oldBaseCommit]); writeFileSync(join(approvedWorkspace, 'app.txt'), 'one\napproved\nthree\n');
	const patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', oldBaseCommit, '--'], { cwd: approvedWorkspace, encoding: 'utf8' });
	const patchSha256 = createHash('sha256').update(patch).digest('hex');
	writeFileSync(join(source, 'other.txt'), 'base\nupstream\n'); git(source, ['add', '.']); git(source, ['commit', '--quiet', '-m', 'advance']);
	const newBaseCommit = git(source, ['rev-parse', 'HEAD']);
	const sourcePublicationId = randomUUID(); const dbPath = join(root, 'bobsled.db'); const repo = repository();
	const evidence: DraftPatchEvidence = {
		baseCommit: oldBaseCommit, headCommit: oldBaseCommit, headMoved: false, changedPaths: ['app.txt'], filesChanged: 1, diffLines: 2,
		diffSha256: patchSha256, protectedPaths: [], policyViolations: [], gates: [{ id: 'verify', name: 'Verify replay', command: 'verify', status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }],
		workspacePath: approvedWorkspace, evidencePath: join(root, 'approved-evidence'),
	};
	const context: PublicationRebaseSourceContext = { sourcePublicationId, repository: repo, evidence, oldBaseCommit, approvedPatchSha256: patchSha256 };
	const rebases = new PublicationRebaseService({
		path: dbPath, workspaceRoot: join(root, 'workspaces'), repositorySourceRoot: sourceRoot,
		sourceResolver: () => context, remoteBaseResolver: async () => newBaseCommit,
		runner: async () => ({ status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false }),
	});
	const admitted = rebases.admit({ sourcePublicationId, reason: 'Replay the exact approved patch on the fresh base.' }, principal, 'rebase');
	const rebase = await rebases.execute(admitted.id, principal); rebases.close(); assert.equal(rebase.status, 'validated');
	return { root, dbPath, sourceRoot, source, approvedWorkspace, oldBaseCommit, newBaseCommit, patchSha256, repo, evidence, context, rebase };
}

test('runs one fresh read-only review and retains approval without publication authority', async () => {
	const value = await fixture(); let calls = 0;
	const reviews = new PublicationRebaseReviewService({
		path: value.dbPath, workspaceRoot: join(value.root, 'workspaces'),
		repository: () => value.repo,
		sourceResolver: () => ({ repository: value.repo, workItem: { source: 'manual', key: 'review', title: 'Update app', body: 'Update app safely.', labels: [] }, implementationPlan: plan, implementationResult }),
		reviewer: async (input) => { calls += 1; assert.equal(input.evidence.baseCommit, value.newBaseCommit); assert.equal(input.repositoryContextPath.includes('publication-rebase-reviews'), true); return approvingOutcome(input.reviewId); },
	});
	try {
		const admitted = reviews.admit({ rebaseId: value.rebase.id, reason: 'Require one fresh adversarial review on the new base.' }, principal, 'fresh-review');
		const result = await reviews.execute(admitted.id, principal);
		assert.equal(result.status, 'approved'); assert.equal(result.modelCalls, 1); assert.equal(calls, 1);
		assert.equal(result.report?.verdict, 'approve'); assert.equal(result.promotionAuthorized, false); assert.equal(result.publicationAuthorized, false);
		await assert.rejects(() => reviews.execute(result.id, { id: 'another' }), /belongs to another principal/);
		assert.throws(() => reviews.admit({ rebaseId: value.rebase.id, reason: 'Do not review the same replay twice.' }, principal, 'second-review'), PublicationRebaseReviewConflictError);
	} finally { reviews.close(); }
});

test('blocks preflight tampering without spend but never retries a model-bearing review', async () => {
	const tampered = await fixture(); let calls = 0;
	const sourceResolver = () => ({ repository: tampered.repo, workItem: { source: 'manual' as const, key: 'tamper', title: 'Update app', body: '', labels: [] }, implementationPlan: plan, implementationResult });
	const first = new PublicationRebaseReviewService({ path: tampered.dbPath, workspaceRoot: join(tampered.root, 'workspaces'), repository: () => tampered.repo, sourceResolver, reviewer: async (input) => { calls += 1; return approvingOutcome(input.reviewId); } });
	try {
		const admitted = first.admit({ rebaseId: tampered.rebase.id, reason: 'Detect workspace drift before spending review capacity.' }, principal, 'tampered-review');
		writeFileSync(join(tampered.rebase.workspacePath!, 'app.txt'), 'tampered\n');
		const blocked = await first.execute(admitted.id, principal); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.modelCalls, 0); assert.equal(calls, 0);
		assert.equal(first.admit({ rebaseId: tampered.rebase.id, reason: 'A zero-call blocked review may be superseded.' }, principal, 'superseding-review').status, 'pending');
	} finally { first.close(); }

	const rejected = await fixture();
	const second = new PublicationRebaseReviewService({
		path: rejected.dbPath, workspaceRoot: join(rejected.root, 'workspaces'), repository: () => rejected.repo, sourceResolver: () => ({ repository: rejected.repo, workItem: { source: 'manual', key: 'reject', title: 'Update app', body: '', labels: [] }, implementationPlan: plan, implementationResult }),
		reviewer: async (input) => ({ ...approvingOutcome(input.reviewId), report: { verdict: 'changes_requested', summary: 'A correction is required.', findings: [{ id: 'finding-1', severity: 'high', category: 'correctness', blocking: true, path: 'app.txt', summary: 'Incorrect behavior.', evidence: 'The changed line is wrong.', remediation: 'Correct the changed line.' }], testedClaims: [], residualRisks: [] } }),
	});
	try {
		const admitted = second.admit({ rebaseId: rejected.rebase.id, reason: 'Record a blocking fresh review without remediation.' }, principal, 'rejected-review');
		const blocked = await second.execute(admitted.id, principal); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.modelCalls, 1); assert.equal(blocked.blockReason, 'reviewer_changes_requested');
		assert.throws(() => second.admit({ rebaseId: rejected.rebase.id, reason: 'A model-bearing review cannot be repeated.' }, principal, 'retry-review'), PublicationRebaseReviewConflictError);
	} finally { second.close(); }
});

test('serializes concurrent review execution before the sole model call', async () => {
	const value = await fixture();
	let release!: () => void; let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
	const releasePromise = new Promise<void>((resolve) => { release = resolve; });
	const sourceResolver = () => ({ repository: value.repo, workItem: { source: 'manual' as const, key: 'race', title: 'Update app', body: '', labels: [] }, implementationPlan: plan, implementationResult });
	const reviewer: ReviewWorkerRunner = async (input) => { entered(); await releasePromise; return approvingOutcome(input.reviewId); };
	const first = new PublicationRebaseReviewService({ path: value.dbPath, workspaceRoot: join(value.root, 'workspaces'), repository: () => value.repo, sourceResolver, reviewer });
	const second = new PublicationRebaseReviewService({ path: value.dbPath, workspaceRoot: join(value.root, 'workspaces'), repository: () => value.repo, sourceResolver, reviewer });
	try {
		const admitted = first.admit({ rebaseId: value.rebase.id, reason: 'Serialize concurrent attempts before review dispatch.' }, principal, 'concurrent-review');
		const running = first.execute(admitted.id, principal); await enteredPromise;
		await assert.rejects(second.execute(admitted.id, principal), /already running/);
		release(); const approved = await running; assert.equal(approved.status, 'approved'); assert.equal(approved.modelCalls, 1);
	} finally { first.close(); second.close(); }
});

test('promotes an approved replay review into a new immutable publication attempt', async () => {
	const value = await fixture(); const ledger = new JobLedger(value.dbPath);
	const workItem = { source: 'manual' as const, key: 'promotion', title: 'Promote replayed patch', body: 'Publish only after fresh review.', labels: [] };
	let run = ledger.admit({ repositoryId: value.repo.id, workItem }, principal, 'promotion-run');
	const execution = ledger.authorizeExecution(run.id, { expectedVersion: run.version, reason: 'Create durable source implementation lineage.' }, principal);
	ledger.markExecutionRunning(execution, principal);
	run = ledger.completeExecution(execution, 'succeeded', { worker: { conversationId: 'worker-conversation', submissionId: 'worker-submission', plan, result: implementationResult, text: 'done' } }, [], principal);

	const sources = new DraftPublicationService({
		path: value.dbPath, ledger,
		candidateResolver: () => ({ runId: run.id, runVersion: run.version, jobId: execution.jobId, attemptId: execution.attemptId, reviewId: randomUUID(), repository: value.repo, workItem, workspacePath: value.approvedWorkspace, baseCommit: value.oldBaseCommit, approvedPatchSha256: value.patchSha256 }),
	});
	const source = await sources.admit({ runId: run.id, expectedVersion: run.version, reason: 'Create the immutable stale source publication.' }, principal, 'source-publication'); sources.close();
	const database = new Database(value.dbPath); database.prepare("UPDATE draft_publications SET status = 'blocked', blocked_reason = ? WHERE id = ?").run(`Remote ${value.repo.defaultBranch} moved beyond the approved base commit`, source.id);
	database.prepare('UPDATE publication_rebases SET source_publication_id = ? WHERE id = ?').run(source.id, value.rebase.id); database.close();

	const reviews = new PublicationRebaseReviewService({
		path: value.dbPath, ledger, workspaceRoot: join(value.root, 'workspaces'),
		repository: () => value.repo,
		sourceResolver: () => ({ repository: value.repo, workItem, implementationPlan: plan, implementationResult }),
		reviewer: async (input) => approvingOutcome(input.reviewId),
	});
	const review = reviews.admit({ rebaseId: value.rebase.id, reason: 'Approve the replay against its current repository snapshot.' }, principal, 'promotion-review');
	const approved = await reviews.execute(review.id, principal); reviews.close(); assert.equal(approved.status, 'approved');

	const publications = new DraftPublicationService({ path: value.dbPath, ledger });
	try {
		const promoted = await publications.admitRecovered({ rebaseReviewId: approved.id, reason: 'Create a new immutable publication attempt from the approved replay.' }, principal, 'promoted-publication');
		assert.equal(promoted.status, 'pending'); assert.equal(promoted.sourceRebaseReviewId, approved.id); assert.equal(promoted.supersedesPublicationId, source.id);
		assert.equal(promoted.baseCommit, value.newBaseCommit); assert.equal(promoted.approvedPatchSha256, value.rebase.replayedPatchSha256);
		assert.match(promoted.branchName, /-rebase-/); assert.match(promoted.body, /Supersedes blocked publication/);
		const duplicate = await publications.admitRecovered({ rebaseReviewId: approved.id, reason: 'Create a new immutable publication attempt from the approved replay.' }, principal, 'promoted-publication');
		assert.equal(duplicate.id, promoted.id);
		await assert.rejects(publications.admitRecovered({ rebaseReviewId: approved.id, reason: 'Do not promote the same replay review twice.' }, principal, 'duplicate-promotion'), /already has a publication record/);
	} finally { publications.close(); ledger.close(); }
});
