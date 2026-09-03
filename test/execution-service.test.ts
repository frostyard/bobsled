import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ImplementationWorkerRunner } from '../src/control-plane/implementation-worker-service.ts';
import { ExecutionService } from '../src/control-plane/execution-service.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';

const principal = { id: 'operator:m3-test' };
const workItem = {
	source: 'manual' as const,
	key: 'manual:m3',
	title: 'Clarify the example',
	body: 'Add one concise clarification to README.md.',
	labels: [],
};

function fixture(verifyCommand = '@true') {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-execution-'));
	const source = join(root, 'source');
	const workspaces = join(root, 'workspaces');
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'mise'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const executablePath = `${bin}:${process.env.PATH ?? ''}`;
	execFileSync('git', ['init', '-b', 'main', source]);
	writeFileSync(join(source, 'README.md'), '# Fixture\n');
	writeFileSync(join(source, 'Makefile'), `verify:\n\t${verifyCommand}\n`);
	mkdirSync(join(source, 'scripts'));
	writeFileSync(join(source, 'scripts', 'check-docs.mjs'), 'process.exit(0);\n');
	execFileSync('git', ['-C', source, 'add', '.']);
	execFileSync('git', ['-C', source, '-c', 'user.name=Bobsled Test', '-c', 'user.email=bobsled@example.invalid', 'commit', '-m', 'fixture']);
	const ledger = new JobLedger(':memory:', () => new Date('2026-09-02T02:00:00.000Z'));
	const run = ledger.admit({ repositoryId: 'frostyard/clix', workItem }, principal, `run-${crypto.randomUUID()}`);
	return { root, source, workspaces, executablePath, ledger, run };
}

function outcome(changedPaths: string[], disposition: 'changed' | 'no_change' | 'blocked' = changedPaths.length > 0 ? 'changed' : 'no_change') {
	return {
		conversationId: 'implementation-test',
		submissionId: 'submission-test',
		plan: {
			summary: 'Make one bounded documentation change.',
			tasks: [{ id: 'implementation' as const, objective: 'Clarify README.', expectedPaths: ['README.md'], acceptanceCriteria: ['README is clearer.'] }],
			assumptions: [],
			risks: [],
		},
		result: { disposition, summary: 'Clarified README.', changedPaths, testsRun: [], notes: [] },
		text: 'Done.',
	};
}

test('explicit Go fix authorization produces a gated uncommitted draft patch and durable evidence', async () => {
	const value = fixture();
	const worker: ImplementationWorkerRunner = async (input) => {
		writeFileSync(join(input.workspacePath, 'README.md'), '# Fixture\n\nClarified by the disposable worker.\n');
		return outcome(['README.md']);
	};
	try {
		const service = new ExecutionService({
			ledger: value.ledger, worker, workspaceRoot: value.workspaces,
			repositorySources: { 'frostyard/clix': value.source },
			executablePath: value.executablePath,
		});
		const completed = await service.execute(value.run.id, {
			expectedVersion: value.run.version,
			reason: 'Operator authorizes one local-only disposable implementation attempt.',
		}, principal);
		assert.equal(completed.status, 'succeeded');
		assert.equal(completed.jobs[0]?.attempts[0]?.status, 'succeeded');
		assert.equal(completed.approvals[0]?.kind, 'go_fix');
		assert.deepEqual(completed.jobs[0]?.artifacts.map(({ kind }) => kind).sort(), [
			'draft_patch', 'execution_summary', 'gate_results', 'implementation_plan', 'worker_result', 'workspace_preparation',
		]);
		const draft = completed.jobs[0]?.artifacts.find(({ kind }) => kind === 'draft_patch');
		assert.match(draft?.digest ?? '', /^[0-9a-f]{64}$/);
		const workspacePath = (completed.jobs[0]?.attempts[0]?.outcome as { evidence: { workspacePath: string } }).evidence.workspacePath;
		assert.match(readFileSync(join(workspacePath, 'README.md'), 'utf8'), /disposable worker/);
		assert.equal(execFileSync('git', ['-C', workspacePath, 'rev-list', '--count', 'HEAD']).toString().trim(), '1');
	} finally {
		value.ledger.close();
		rmSync(value.root, { recursive: true, force: true });
	}
});

test('verified no-change work succeeds without becoming reviewable', async () => {
	const value = fixture();
	const worker: ImplementationWorkerRunner = async () => outcome([], 'no_change');
	try {
		const service = new ExecutionService({
			ledger: value.ledger, worker, workspaceRoot: value.workspaces,
			repositorySources: { 'frostyard/clix': value.source }, executablePath: value.executablePath,
		});
		const completed = await service.execute(value.run.id, {
			expectedVersion: value.run.version,
			reason: 'Operator authorizes verification that the requested state already exists.',
		}, principal);
		assert.equal(completed.status, 'succeeded');
		const attempt = completed.jobs[0]?.attempts[0];
		assert.equal(attempt?.status, 'succeeded');
		const result = attempt?.outcome as { worker: { result: { disposition: string } }; evidence: { filesChanged: number; policyViolations: string[] } };
		assert.equal(result.worker.result.disposition, 'no_change');
		assert.equal(result.evidence.filesChanged, 0);
		assert.deepEqual(result.evidence.policyViolations, []);
		assert.throws(() => value.ledger.authorizeReview(completed.id, {
			expectedVersion: completed.version,
			reason: 'Operator attempts to review a verified no-change result.',
		}, principal), /no draft patch to review/);
	} finally {
		value.ledger.close();
		rmSync(value.root, { recursive: true, force: true });
	}
});

test('trusted postconditions block an oversized worker patch while preserving evidence', async () => {
	const value = fixture();
	const worker: ImplementationWorkerRunner = async (input) => {
		for (let index = 0; index < 9; index += 1) writeFileSync(join(input.workspacePath, `extra-${index}.txt`), `${index}\n`);
		return outcome(Array.from({ length: 9 }, (_, index) => `extra-${index}.txt`));
	};
	try {
		const service = new ExecutionService({ ledger: value.ledger, worker, workspaceRoot: value.workspaces, repositorySources: { 'frostyard/clix': value.source }, executablePath: value.executablePath });
		const completed = await service.execute(value.run.id, {
			expectedVersion: value.run.version,
			reason: 'Operator authorizes a bounded attempt for policy-limit testing.',
		}, principal);
		assert.equal(completed.status, 'blocked');
		const outcomeValue = completed.jobs[0]?.attempts[0]?.outcome as { evidence: { policyViolations: string[] } };
		assert.match(outcomeValue.evidence.policyViolations.join('\n'), /9 files/);
		assert.equal(completed.jobs[0]?.artifacts.some(({ kind }) => kind === 'draft_patch'), true);
	} finally {
		value.ledger.close();
		rmSync(value.root, { recursive: true, force: true });
	}
});

test('missing source capability fails before spending a worker call', async () => {
	const value = fixture();
	let workerCalled = false;
	const worker: ImplementationWorkerRunner = async () => {
		workerCalled = true;
		return outcome([]);
	};
	try {
		const service = new ExecutionService({ ledger: value.ledger, worker, workspaceRoot: value.workspaces, repositorySources: { 'frostyard/clix': join(value.root, 'missing') }, executablePath: value.executablePath });
		const completed = await service.execute(value.run.id, {
			expectedVersion: value.run.version,
			reason: 'Operator authorizes a bounded attempt with explicit failure evidence.',
		}, principal);
		assert.equal(workerCalled, false);
		assert.equal(completed.status, 'failed');
		assert.equal(completed.jobs[0]?.artifacts[0]?.kind, 'execution_error');
	} finally {
		value.ledger.close();
		rmSync(value.root, { recursive: true, force: true });
	}
});

test('resolves enrolled repository checkouts beneath the shared source root', async () => {
	const value = fixture();
	const sourceRoot = join(value.root, 'sources');
	const nestedSource = join(sourceRoot, 'frostyard', 'clix');
	mkdirSync(join(sourceRoot, 'frostyard'), { recursive: true });
	renameSync(value.source, nestedSource);
	try {
		const service = new ExecutionService({
			ledger: value.ledger,
			worker: async () => outcome([], 'no_change'),
			workspaceRoot: value.workspaces,
			repositorySourceRoot: sourceRoot,
			executablePath: value.executablePath,
		});
		const completed = await service.execute(value.run.id, {
			expectedVersion: value.run.version,
			reason: 'Operator authorizes a source-root resolution proof.',
		}, principal);
		assert.equal(completed.status, 'succeeded');
	} finally {
		value.ledger.close();
		rmSync(value.root, { recursive: true, force: true });
	}
});

test('repository-declared workspace preparation runs before and can prevent worker token spend', async () => {
	const value = fixture();
	writeFileSync(join(value.root, 'bin', 'mise'), '#!/bin/sh\necho setup failed >&2\nexit 17\n', { mode: 0o755 });
	let workerCalled = false;
	const worker: ImplementationWorkerRunner = async () => {
		workerCalled = true;
		return outcome([]);
	};
	try {
		const service = new ExecutionService({ ledger: value.ledger, worker, workspaceRoot: value.workspaces, repositorySources: { 'frostyard/clix': value.source }, executablePath: value.executablePath });
		const completed = await service.execute(value.run.id, {
			expectedVersion: value.run.version,
			reason: 'Operator authorizes preparation before any bounded worker attempt.',
		}, principal);
		assert.equal(workerCalled, false);
		assert.equal(completed.status, 'failed');
		assert.equal(completed.jobs[0]?.artifacts[0]?.kind, 'workspace_preparation');
		const preparation = completed.jobs[0]?.attempts[0]?.outcome as { preparation: { exitCode: number; stderr: string } };
		assert.equal(preparation.preparation.exitCode, 17);
		assert.match(preparation.preparation.stderr, /setup failed/);
	} finally {
		value.ledger.close();
		rmSync(value.root, { recursive: true, force: true });
	}
});
