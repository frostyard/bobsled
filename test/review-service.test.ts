import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ImplementationWorkerRunner } from '../src/control-plane/implementation-worker-service.ts';
import { ExecutionService } from '../src/control-plane/execution-service.ts';
import type { ReviewReport } from '../src/control-plane/execution-contracts.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { ReviewService } from '../src/control-plane/review-service.ts';
import type { RemediationWorkerRunner, ReviewWorkerRunner } from '../src/control-plane/review-worker-service.ts';
import { DraftPublicationService } from '../src/control-plane/publication-service.ts';

const principal = { id: 'operator:m4-test' };
const workItem = { source: 'manual' as const, key: 'manual:m4', title: 'Clarify the example', body: 'Add one concise clarification to README.md.', labels: [] };

function fixture(verifyCommand = '@true') {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-review-'));
	const source = join(root, 'source');
	const workspaces = join(root, 'workspaces');
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'mise'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const executablePath = `${bin}:${process.env.PATH ?? ''}`;
	execFileSync('git', ['init', '-b', 'main', source]);
	writeFileSync(join(source, 'README.md'), '# Fixture\n');
	writeFileSync(join(source, 'sentinel'), 'required\n');
	writeFileSync(join(source, 'Makefile'), `verify:\n\t${verifyCommand}\n`);
	mkdirSync(join(source, 'scripts'));
	writeFileSync(join(source, 'scripts', 'check-docs.mjs'), 'process.exit(0);\n');
	execFileSync('git', ['-C', source, 'add', '.']);
	execFileSync('git', ['-C', source, '-c', 'user.name=Bobsled Test', '-c', 'user.email=bobsled@example.invalid', 'commit', '-m', 'fixture']);
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-02T03:00:00.000Z'));
	const run = ledger.admit({ repositoryId: 'frostyard/clix', workItem }, principal, `run-${crypto.randomUUID()}`);
	return { root, source, workspaces, executablePath, ledger, run };
}

const implementationWorker: ImplementationWorkerRunner = async (input) => {
	writeFileSync(join(input.workspacePath, 'README.md'), '# Fixture\n\nDraft clarification.\n');
	return {
		conversationId: 'implementation-test', submissionId: 'implementation-submission',
		plan: { summary: 'Clarify docs.', tasks: [{ id: 'implementation', objective: 'Clarify README.', expectedPaths: ['README.md'], acceptanceCriteria: ['README is clearer.'] }], assumptions: [], risks: [] },
		result: { disposition: 'changed', summary: 'Clarified README.', changedPaths: ['README.md'], testsRun: [], notes: [] }, text: 'Done.',
	};
};

const approve: ReviewReport = { verdict: 'approve', summary: 'The bounded patch is sound.', findings: [], testedClaims: ['The change matches the task.'], residualRisks: [] };
const changesRequested: ReviewReport = {
	verdict: 'changes_requested', summary: 'One concrete clarification is required.',
	findings: [{ id: 'finding-1', severity: 'moderate', category: 'documentation', blocking: true, path: 'README.md', line: 3, summary: 'Wording is ambiguous.', evidence: 'The new sentence does not name the subject.', remediation: 'Name the subject explicitly.' }],
	testedClaims: ['The patch is within scope.'], residualRisks: [],
};

async function implemented(value: ReturnType<typeof fixture>) {
	const execution = new ExecutionService({ ledger: value.ledger, worker: implementationWorker, workspaceRoot: value.workspaces, repositorySources: { 'frostyard/clix': value.source }, executablePath: value.executablePath });
	return execution.execute(value.run.id, { expectedVersion: value.run.version, reason: 'Operator authorizes the disposable implementation needed for review.' }, principal);
}

test('fresh-context approval reruns trusted gates and records an approved review', async () => {
	const value = fixture();
	let remediationCalled = false;
	const reviewer: ReviewWorkerRunner = async (input) => {
		assert.match(readFileSync(join(input.repositoryContextPath, 'README.md'), 'utf8'), /Draft clarification/);
		assert.equal(existsSync(join(input.repositoryContextPath, '.git')), false);
		return { conversationId: `review-${input.round}`, submissionId: 'review-submission', report: approve, text: 'Approved.' };
	};
	const remediator: RemediationWorkerRunner = async () => { remediationCalled = true; throw new Error('not expected'); };
	try {
		const run = await implemented(value);
		const service = new ReviewService({ ledger: value.ledger, reviewer, remediator, workspaceRoot: value.workspaces, executablePath: value.executablePath });
		const completed = await service.review(run.id, { expectedVersion: run.version, reason: 'Operator authorizes one independent adversarial review.' }, principal);
		assert.equal(remediationCalled, false);
		assert.equal(completed.jobs[0]?.reviews[0]?.status, 'approved');
		assert.equal(completed.jobs[0]?.reviews[0]?.initialVerdict && (completed.jobs[0]?.reviews[0]?.initialVerdict as ReviewReport).verdict, 'approve');
		assert.deepEqual(completed.jobs[0]?.artifacts.filter(({ kind }) => kind.startsWith('review_')).map(({ kind }) => kind).sort(), ['review_draft_patch', 'review_gate_results', 'review_initial', 'review_repository_context']);
		const publications = new DraftPublicationService({ path: ':memory:', ledger: value.ledger });
		try {
			const publication = await publications.admit({ runId: completed.id, expectedVersion: completed.version, reason: 'Operator records publication intent while clix remains read-only.' }, principal, 'review-publication');
			assert.equal(publication.status, 'blocked');
			assert.match(publication.blockedReason ?? '', /does not permit draft publication/);
			assert.equal(publication.approvedPatchSha256, completed.jobs[0]?.artifacts.find(({ kind }) => kind === 'review_draft_patch')?.digest);
		} finally { publications.close(); }
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('automatic review is policy-authored without a second operator approval', async () => {
	const value = fixture();
	const reviewer: ReviewWorkerRunner = async () => ({ conversationId: 'automatic-review', submissionId: 'automatic-review', report: approve, text: 'Approved.' });
	try {
		const run = await implemented(value);
		const service = new ReviewService({ ledger: value.ledger, reviewer, workspaceRoot: value.workspaces, executablePath: value.executablePath });
		const completed = await service.reviewAutomatically(run.id, run.version, principal);
		assert.equal(completed.jobs[0]?.reviews[0]?.status, 'approved');
		const policyApproval = completed.approvals.find(({ kind }) => kind === 'policy_review');
		assert.equal(policyApproval?.actorId, 'system:repository-review-policy');
		assert.equal(completed.audit.some(({ type, actorId }) => type === 'review.auto_authorized' && actorId === 'system:repository-review-policy'), true);
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('automatic review follows trusted attempt evidence outside the legacy run directory', async () => {
	const value = fixture();
	const execution = value.ledger.authorizeExecution(value.run.id, {
		expectedVersion: value.run.version,
		reason: 'A coordinated member supplies its already prepared trusted workspace.',
	}, principal);
	const attemptRoot = join(value.workspaces, 'multi-repository-change-sets', crypto.randomUUID(), 'members', crypto.randomUUID());
	const workspacePath = join(attemptRoot, 'repo');
	const evidencePath = join(attemptRoot, 'evidence');
	mkdirSync(evidencePath, { recursive: true });
	execFileSync('git', ['-C', value.source, 'worktree', 'add', '--detach', workspacePath, 'HEAD']);
	value.ledger.markExecutionRunning(execution, principal);
	const baseCommit = execFileSync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const service = new ExecutionService({ ledger: value.ledger, worker: implementationWorker, workspaceRoot: value.workspaces, executablePath: value.executablePath });
	const run = await service.executeClaimed(execution, {
		attemptRoot, workspacePath, evidencePath,
		sandboxHomePath: join(attemptRoot, 'execution-home'), toolDataPath: join(value.workspaces, 'tool-cache', 'frostyard__clix', 'mise'),
		artifactRootUri: `workspace://multi-repository-change-sets/test/members/${execution.attemptId}`,
	}, baseCommit, {
		name: 'Prepared already', command: 'mise install', networkAccess: true, status: 'passed', exitCode: 0,
		durationMs: 1, stdout: '', stderr: '', truncated: false,
	}, principal);
	let reviewerCalls = 0;
	const reviewer: ReviewWorkerRunner = async (input) => {
		reviewerCalls += 1;
		assert.equal(input.evidence.workspacePath, workspacePath);
		return { conversationId: 'external-review', submissionId: 'external-review', report: approve, text: 'Approved.' };
	};
	try {
		const reviewed = await new ReviewService({ ledger: value.ledger, reviewer, workspaceRoot: value.workspaces, executablePath: value.executablePath })
			.reviewAutomatically(run.id, run.version, principal);
		assert.equal(reviewerCalls, 1);
		assert.equal(reviewed.jobs[0]?.reviews[0]?.status, 'approved');
		assert.equal(reviewed.jobs[0]?.artifacts.some(({ kind, uri }) => kind === 'review_draft_patch' && uri.includes('/multi-repository-change-sets/')), true);
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('one bounded Codex remediation round is followed by gates and a fresh final Copilot review', async () => {
	const value = fixture();
	let reviewCalls = 0;
	const reviewer: ReviewWorkerRunner = async (input) => {
		reviewCalls += 1;
		const context = readFileSync(join(input.repositoryContextPath, 'README.md'), 'utf8');
		if (input.round === 'initial') assert.match(context, /Draft clarification/);
		else assert.match(context, /explicitly clarified/);
		return { conversationId: `review-${input.round}-${reviewCalls}`, submissionId: `review-${reviewCalls}`, report: input.round === 'initial' ? changesRequested : approve, text: input.round };
	};
	const remediator: RemediationWorkerRunner = async (input) => {
		writeFileSync(join(input.workspacePath, 'README.md'), '# Fixture\n\nThe fixture documentation is explicitly clarified.\n');
		return { conversationId: 'remediation', submissionId: 'remediation-submission', result: { summary: 'Resolved wording.', addressedFindingIds: ['finding-1'], unresolvedFindingIds: [], changedPaths: ['README.md'], testsRun: [], notes: [] }, text: 'Resolved.' };
	};
	try {
		const run = await implemented(value);
		const service = new ReviewService({ ledger: value.ledger, reviewer, remediator, workspaceRoot: value.workspaces, executablePath: value.executablePath });
		const completed = await service.review(run.id, { expectedVersion: run.version, reason: 'Operator authorizes bounded review and remediation.' }, principal);
		assert.equal(reviewCalls, 2);
		assert.equal(completed.jobs[0]?.reviews[0]?.status, 'approved');
		assert.equal((completed.jobs[0]?.reviews[0]?.finalVerdict as ReviewReport).verdict, 'approve');
		const workspacePath = (completed.jobs[0]?.attempts[0]?.outcome as { evidence: { workspacePath: string } }).evidence.workspacePath;
		assert.match(readFileSync(join(workspacePath, 'README.md'), 'utf8'), /explicitly clarified/);
		assert.equal(execFileSync('git', ['-C', workspacePath, 'rev-list', '--count', 'HEAD']).toString().trim(), '1');
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('failed post-remediation gate blocks before spending a final reviewer call', async () => {
	const value = fixture('@test -f sentinel');
	let reviewCalls = 0;
	const reviewer: ReviewWorkerRunner = async (input) => { reviewCalls += 1; return { conversationId: `review-${reviewCalls}`, submissionId: `review-${reviewCalls}`, report: changesRequested, text: input.round }; };
	const remediator: RemediationWorkerRunner = async (input) => {
		unlinkSync(join(input.workspacePath, 'sentinel'));
		return { conversationId: 'remediation', submissionId: 'remediation', result: { summary: 'Changed files.', addressedFindingIds: ['finding-1'], unresolvedFindingIds: [], changedPaths: ['sentinel'], testsRun: [], notes: [] }, text: 'Done.' };
	};
	try {
		const run = await implemented(value);
		const service = new ReviewService({ ledger: value.ledger, reviewer, remediator, workspaceRoot: value.workspaces, executablePath: value.executablePath });
		const completed = await service.review(run.id, { expectedVersion: run.version, reason: 'Operator authorizes a gate-failure review scenario.' }, principal);
		assert.equal(reviewCalls, 1);
		assert.equal(completed.jobs[0]?.reviews[0]?.status, 'blocked');
		assert.match(JSON.stringify(completed.jobs[0]?.reviews[0]?.outcome), /verification failed/);
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('an approved attempt cannot be reviewed twice', async () => {
	const value = fixture();
	const reviewer: ReviewWorkerRunner = async () => ({ conversationId: 'review', submissionId: 'review', report: approve, text: 'Approved.' });
	try {
		const run = await implemented(value);
		const service = new ReviewService({ ledger: value.ledger, reviewer, workspaceRoot: value.workspaces, executablePath: value.executablePath });
		const completed = await service.review(run.id, { expectedVersion: run.version, reason: 'Operator authorizes one independent adversarial review.' }, principal);
		await assert.rejects(service.review(run.id, { expectedVersion: completed.version, reason: 'Operator attempts an unnecessary duplicate review.' }, principal), /already has an approved/);
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});

test('a blocked attempt cannot spend another review cycle against unchanged evidence', async () => {
	const value = fixture();
	const rejected: ReviewReport = {
		verdict: 'reject', summary: 'The bounded patch is not safe to continue.', testedClaims: [], residualRisks: [],
		findings: [{ id: 'finding-1', severity: 'critical', category: 'security', blocking: true, summary: 'Unsafe change.', evidence: 'The patch crosses a security invariant.', remediation: 'Start a revised task with explicit authority.' }],
	};
	let reviewCalls = 0;
	const reviewer: ReviewWorkerRunner = async () => { reviewCalls += 1; return { conversationId: 'review', submissionId: 'review', report: rejected, text: 'Rejected.' }; };
	try {
		const run = await implemented(value);
		const service = new ReviewService({ ledger: value.ledger, reviewer, workspaceRoot: value.workspaces, executablePath: value.executablePath });
		const completed = await service.review(run.id, { expectedVersion: run.version, reason: 'Operator authorizes one independent adversarial review.' }, principal);
		assert.equal(completed.jobs[0]?.reviews[0]?.status, 'blocked');
		await assert.rejects(service.review(run.id, { expectedVersion: completed.version, reason: 'Operator attempts to repeat the settled review.' }, principal), /start a revised run/);
		assert.equal(reviewCalls, 1);
	} finally { value.ledger.close(); rmSync(value.root, { recursive: true, force: true }); }
});
