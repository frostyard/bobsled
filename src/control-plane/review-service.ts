import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import * as v from 'valibot';
import {
	DraftPatchEvidenceSchema,
	GateResultSchema,
	ImplementationPlanSchema,
	ImplementationResultSchema,
	parseStoredWorkerOutcome,
	type DraftPatchEvidence,
	type GateResult,
	type ReviewOutcome,
	type RemediationOutcome,
} from './execution-contracts.ts';
import {
	jobLedger,
	type AuthorizedReview,
	type ExecutionArtifactInput,
	type JobLedger,
	type Principal,
} from './ledger.ts';
import type { RunRecord } from './ledger-contracts.ts';
import {
	runRemediationWorker,
	runReviewWorker,
	type RemediationWorkerRunner,
	type ReviewWorkerRunner,
} from './review-worker-service.ts';

const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	truncated: boolean;
}

interface ReviewPaths {
	attemptRoot: string;
	workspacePath: string;
	implementationEvidencePath: string;
	reviewEvidencePath: string;
	sandboxHomePath: string;
	toolDataPath: string;
}

export interface ReviewServiceOptions {
	ledger?: JobLedger;
	reviewer?: ReviewWorkerRunner;
	remediator?: RemediationWorkerRunner;
	workspaceRoot?: string;
	executablePath?: string;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
	if (state.bytes >= MAX_COMMAND_OUTPUT_BYTES) { state.truncated = true; return; }
	const remaining = MAX_COMMAND_OUTPUT_BYTES - state.bytes;
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += Math.min(chunk.byteLength, remaining);
	if (chunk.byteLength > remaining) state.truncated = true;
}

async function command(file: string, args: string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<CommandResult> {
	const started = Date.now();
	return await new Promise((resolveResult, reject) => {
		const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const stdoutState = { bytes: 0, truncated: false };
		const stderrState = { bytes: 0, truncated: false };
		let timedOut = false;
		child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState));
		child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrState));
		child.once('error', reject);
		const terminate = (signal: NodeJS.Signals) => {
			try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
			catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
		};
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); killTimer = setTimeout(() => terminate('SIGKILL'), 5_000); }, options.timeoutMs);
		child.once('close', (exitCode) => {
			clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
			resolveResult({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, timedOut, durationMs: Date.now() - started, truncated: stdoutState.truncated || stderrState.truncated });
		});
	});
}

function cleanEnvironment(home: string, toolDataPath: string, executablePath: string): NodeJS.ProcessEnv {
	return {
		PATH: `${resolve(toolDataPath, 'shims')}:${executablePath}`,
		LANG: process.env.LANG ?? 'C.UTF-8', HOME: home, TMPDIR: resolve(home, 'tmp'),
		MISE_DATA_DIR: toolDataPath, MISE_CACHE_DIR: resolve(toolDataPath, 'cache'),
		CI: 'true', GIT_TERMINAL_PROMPT: '0',
	};
}

function matchesProtectedPath(path: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) { const prefix = pattern.slice(0, -3); return path === prefix || path.startsWith(`${prefix}/`); }
	return path === pattern;
}

function nulList(value: string): string[] { return value.split('\0').filter(Boolean); }

export class ReviewService {
	readonly #ledger: JobLedger;
	readonly #reviewer: ReviewWorkerRunner;
	readonly #remediator: RemediationWorkerRunner;
	readonly #workspaceRoot: string;
	readonly #executablePath: string;

	constructor(options: ReviewServiceOptions = {}) {
		this.#ledger = options.ledger ?? jobLedger;
		this.#reviewer = options.reviewer ?? runReviewWorker;
		this.#remediator = options.remediator ?? runRemediationWorker;
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
	}

	async review(runId: string, input: unknown, principal: Principal): Promise<RunRecord> {
		return this.#review(runId, input, principal, 'operator');
	}

	async reviewAutomatically(runId: string, expectedVersion: number, principal: Principal): Promise<RunRecord> {
		return this.#review(runId, {
			expectedVersion,
			reason: 'Repository policy automatically requires independent adversarial review after a successful changed implementation.',
		}, principal, 'policy');
	}

	async #review(runId: string, input: unknown, principal: Principal, trigger: 'operator' | 'policy'): Promise<RunRecord> {
		const review = this.#ledger.authorizeReview(runId, input, principal, trigger);
		let paths: ReviewPaths | undefined;
		let initial: ReviewOutcome | undefined;
		let final: ReviewOutcome | undefined;
		let remediation: RemediationOutcome | undefined;
		try {
			paths = await this.#paths(review);
			this.#ledger.markReviewRunning(review, principal);
			const implementationPlan = v.parse(ImplementationPlanSchema, JSON.parse(await readFile(resolve(paths.implementationEvidencePath, 'implementation-plan.json'), 'utf8')));
			const worker = parseStoredWorkerOutcome(JSON.parse(await readFile(resolve(paths.implementationEvidencePath, 'worker-result.json'), 'utf8')));
			const originalEvidence = v.parse(DraftPatchEvidenceSchema, JSON.parse(await readFile(resolve(paths.implementationEvidencePath, 'summary.json'), 'utf8')));
			const originalPatch = await readFile(resolve(paths.implementationEvidencePath, 'draft.patch'), 'utf8');
			if (createHash('sha256').update(originalPatch).digest('hex') !== originalEvidence.diffSha256) throw new Error('Implementation patch digest no longer matches its evidence');
			const initialContextPath = await this.#snapshot(paths, 'initial');

			initial = await this.#reviewer({
				reviewId: review.reviewId, round: 'initial', repositoryContextPath: initialContextPath, repository: review.repository, workItem: review.workItem,
				implementationPlan, implementationResult: v.parse(ImplementationResultSchema, worker.result), evidence: originalEvidence, patch: originalPatch,
			}, review.repository.reviewPolicy.reviewerTimeoutMinutes * 60_000);
			await writeFile(resolve(paths.reviewEvidencePath, 'initial-review.json'), `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });

			if (initial.report.verdict === 'reject') {
				return this.#complete(review, 'blocked', paths, initial, undefined, undefined, { reason: 'Independent reviewer rejected the draft' }, principal);
			}

			if (initial.report.verdict === 'changes_requested') {
				if (review.repository.reviewPolicy.maxRemediationRounds < 1) {
					return this.#complete(review, 'blocked', paths, initial, undefined, undefined, { reason: 'Repository policy does not permit automated remediation' }, principal);
				}
				remediation = await this.#remediator({
					reviewId: review.reviewId, runId: review.runId, jobId: review.jobId, attemptId: review.attemptId,
					workspacePath: paths.workspacePath, sandboxHomePath: paths.sandboxHomePath, toolDataPath: paths.toolDataPath,
					executablePath: this.#executablePath, baseCommit: originalEvidence.baseCommit,
					repository: review.repository, workItem: review.workItem, review: initial.report,
				}, review.repository.reviewPolicy.remediationTimeoutMinutes * 60_000);
				await writeFile(resolve(paths.reviewEvidencePath, 'remediation-result.json'), `${JSON.stringify(remediation, null, 2)}\n`, { mode: 0o600 });
			}

			const gates = await this.#runGates(review, paths);
			const evidence = await this.#collectEvidence(review, paths, originalEvidence.baseCommit, gates);
			if (evidence.policyViolations.length > 0 || gates.some(({ status }) => status !== 'passed')) {
				return this.#complete(review, 'blocked', paths, initial, undefined, remediation, { evidence, reason: 'Trusted post-review verification failed' }, principal, evidence);
			}

			if (remediation) {
				const patch = await readFile(resolve(paths.reviewEvidencePath, 'draft.patch'), 'utf8');
				const finalContextPath = await this.#snapshot(paths, 'final');
				final = await this.#reviewer({
					reviewId: review.reviewId, round: 'final', repositoryContextPath: finalContextPath, repository: review.repository, workItem: review.workItem,
					implementationPlan, implementationResult: v.parse(ImplementationResultSchema, worker.result), evidence, patch,
				}, review.repository.reviewPolicy.reviewerTimeoutMinutes * 60_000);
				await writeFile(resolve(paths.reviewEvidencePath, 'final-review.json'), `${JSON.stringify(final, null, 2)}\n`, { mode: 0o600 });
			}
			const approved = (final?.report ?? initial.report).verdict === 'approve';
			return this.#complete(review, approved ? 'approved' : 'blocked', paths, initial, final, remediation, { evidence, remediation, finalReview: final }, principal, evidence);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Adversarial review failed';
			const evidencePath = paths?.reviewEvidencePath ?? resolve(this.#workspaceRoot, 'runs', review.jobId, `${review.attemptNumber}-${review.attemptId}`, 'evidence', 'reviews', `${review.reviewNumber}-${review.reviewId}`);
			await mkdir(evidencePath, { recursive: true, mode: 0o700 });
			await writeFile(resolve(evidencePath, 'review-error.json'), `${JSON.stringify({ error: message }, null, 2)}\n`, { mode: 0o600 });
			return this.#ledger.completeReview(review, 'failed', initial?.report, final?.report, { error: message }, [{ kind: 'review_error', uri: this.#artifactUri(review, 'review-error.json'), metadata: { message } }], principal);
		}
	}

	async #snapshot(paths: ReviewPaths, round: 'initial' | 'final'): Promise<string> {
		const destination = resolve(paths.reviewEvidencePath, `repository-context-${round}`);
		await rm(destination, { recursive: true, force: true });
		await cp(paths.workspacePath, destination, {
			recursive: true,
			preserveTimestamps: true,
			filter: (source) => source === paths.workspacePath || basename(source) !== '.git',
		});
		return await realpath(destination);
	}

	async #paths(review: AuthorizedReview): Promise<ReviewPaths> {
		const attemptRoot = resolve(this.#workspaceRoot, 'runs', review.jobId, `${review.attemptNumber}-${review.attemptId}`);
		const workspacePath = resolve(attemptRoot, 'repo');
		if (await realpath(workspacePath).catch(() => undefined) !== workspacePath) throw new Error('Preserved implementation worktree is unavailable');
		const implementationEvidencePath = resolve(attemptRoot, 'evidence');
		const reviewEvidencePath = resolve(implementationEvidencePath, 'reviews', `${review.reviewNumber}-${review.reviewId}`);
		const sandboxHomePath = resolve(attemptRoot, 'home');
		const toolDataPath = resolve(this.#workspaceRoot, 'tool-cache', review.repository.id.replace('/', '__'), 'mise');
		await mkdir(reviewEvidencePath, { recursive: true, mode: 0o700 });
		return { attemptRoot, workspacePath, implementationEvidencePath, reviewEvidencePath, sandboxHomePath, toolDataPath };
	}

	async #runGates(review: AuthorizedReview, paths: ReviewPaths): Promise<GateResult[]> {
		const gateById = new Map(review.repository.qualityGates.map((gate) => [gate.id, gate]));
		const results: GateResult[] = [];
		for (const id of review.repository.executionPolicy.requiredGateIds) {
			const gate = gateById.get(id); if (!gate) throw new Error(`Required gate is missing from the policy snapshot: ${id}`);
			const result = await command('/bin/sh', ['-c', gate.command], { cwd: paths.workspacePath, timeoutMs: review.repository.executionPolicy.gateTimeoutMinutes * 60_000, env: cleanEnvironment(paths.sandboxHomePath, paths.toolDataPath, this.#executablePath) });
			results.push(v.parse(GateResultSchema, { id: gate.id, name: gate.name, command: gate.command, status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated }));
			if (result.timedOut || result.exitCode !== 0) break;
		}
		await writeFile(resolve(paths.reviewEvidencePath, 'gate-results.json'), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
		return results;
	}

	async #collectEvidence(review: AuthorizedReview, paths: ReviewPaths, baseCommit: string, gates: GateResult[]): Promise<DraftPatchEvidence> {
		const untracked = nulList(await this.#git(paths.workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']));
		if (untracked.length > 0) {
			const intent = await command('git', ['add', '-N', '--', ...untracked], { cwd: paths.workspacePath, timeoutMs: 60_000, env: cleanEnvironment(paths.sandboxHomePath, paths.toolDataPath, this.#executablePath) });
			if (intent.exitCode !== 0) throw new Error(`Unable to include new files in review evidence: ${intent.stderr.trim()}`);
		}
		const headCommit = await this.#git(paths.workspacePath, ['rev-parse', 'HEAD']);
		const patch = await this.#git(paths.workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', baseCommit, '--'], false);
		const changedPaths = nulList(await this.#git(paths.workspacePath, ['diff', '--name-only', '-z', '--no-renames', baseCommit, '--']));
		const numstat = await this.#git(paths.workspacePath, ['diff', '--numstat', '--no-renames', baseCommit, '--']);
		let diffLines = 0;
		for (const line of numstat.split('\n').filter(Boolean)) { const [added, deleted] = line.split('\t', 3); if (added !== '-' && deleted !== '-') diffLines += Number(added) + Number(deleted); }
		const protectedPaths = changedPaths.filter((path) => review.repository.protectedBoundaries.some((boundary) => boundary.paths.some((pattern) => matchesProtectedPath(path, pattern))));
		const policyViolations: string[] = [];
		if (changedPaths.length === 0) policyViolations.push('Post-review draft contains no patch');
		if (changedPaths.length > review.repository.executionPolicy.maxFiles) policyViolations.push(`Draft changes ${changedPaths.length} files; policy allows ${review.repository.executionPolicy.maxFiles}`);
		if (diffLines > review.repository.executionPolicy.maxDiffLines) policyViolations.push(`Draft changes ${diffLines} lines; policy allows ${review.repository.executionPolicy.maxDiffLines}`);
		if (headCommit !== baseCommit) policyViolations.push('Review or remediation moved HEAD or created a commit');
		if (protectedPaths.length > 0) policyViolations.push(`Draft touches protected paths: ${protectedPaths.join(', ')}`);
		if (gates.some(({ status }) => status !== 'passed')) policyViolations.push('One or more required repository gates did not pass after review');
		const diffSha256 = createHash('sha256').update(patch).digest('hex');
		await writeFile(resolve(paths.reviewEvidencePath, 'draft.patch'), patch, { mode: 0o600 });
		const evidence = v.parse(DraftPatchEvidenceSchema, { baseCommit, headCommit, headMoved: headCommit !== baseCommit, changedPaths, filesChanged: changedPaths.length, diffLines, diffSha256, protectedPaths, policyViolations, gates, workspacePath: paths.workspacePath, evidencePath: paths.reviewEvidencePath });
		await writeFile(resolve(paths.reviewEvidencePath, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		return evidence;
	}

	#complete(review: AuthorizedReview, status: 'approved' | 'blocked', paths: ReviewPaths, initial: ReviewOutcome, final: ReviewOutcome | undefined, remediation: RemediationOutcome | undefined, outcome: unknown, principal: Principal, evidence?: DraftPatchEvidence): RunRecord {
		const artifacts: ExecutionArtifactInput[] = [
			{ kind: 'review_initial', uri: this.#artifactUri(review, 'initial-review.json'), metadata: { verdict: initial.report.verdict, findings: initial.report.findings.length } },
			{ kind: 'review_repository_context', uri: this.#artifactUri(review, 'repository-context-initial'), metadata: { round: 'initial', mode: 'read_only_repository', shell: false, network: false, mutation: false } },
		];
		if (remediation) artifacts.push({ kind: 'review_remediation', uri: this.#artifactUri(review, 'remediation-result.json'), metadata: { unresolved: remediation.result.unresolvedFindingIds.length } });
		if (evidence) artifacts.push(
			{ kind: 'review_gate_results', uri: this.#artifactUri(review, 'gate-results.json'), metadata: { passed: evidence.gates.every(({ status: gateStatus }) => gateStatus === 'passed') } },
			{ kind: 'review_draft_patch', uri: this.#artifactUri(review, 'draft.patch'), digest: evidence.diffSha256, metadata: { filesChanged: evidence.filesChanged, diffLines: evidence.diffLines } },
		);
		if (final) artifacts.push(
			{ kind: 'review_repository_context', uri: this.#artifactUri(review, 'repository-context-final'), metadata: { round: 'final', mode: 'read_only_repository', shell: false, network: false, mutation: false } },
			{ kind: 'review_final', uri: this.#artifactUri(review, 'final-review.json'), metadata: { verdict: final.report.verdict, findings: final.report.findings.length } },
		);
		return this.#ledger.completeReview(review, status, initial.report, final?.report, outcome, artifacts, principal);
	}

	#artifactUri(review: AuthorizedReview, suffix: string): string {
		return `workspace://runs/${review.jobId}/${review.attemptNumber}-${review.attemptId}/evidence/reviews/${review.reviewNumber}-${review.reviewId}/${suffix}`;
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await command('git', args, { cwd, timeoutMs: 60_000, env: cleanEnvironment(cwd, resolve(cwd, '.mise'), this.#executablePath) });
		if (result.timedOut || result.exitCode !== 0) throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
		return trim ? result.stdout.trim() : result.stdout;
	}
}

export const reviewService = new ReviewService();
