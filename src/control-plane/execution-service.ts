import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as v from 'valibot';
import {
	DraftPatchEvidenceSchema,
	GateResultSchema,
	PreparationResultSchema,
	type DraftPatchEvidence,
	type GateResult,
	type PreparationResult,
	type WorkerOutcome,
} from './execution-contracts.ts';
import {
	jobLedger,
	type AuthorizedExecution,
	type JobLedger,
	type Principal,
} from './ledger.ts';
import type { RunRecord } from './ledger-contracts.ts';
import {
	runImplementationWorker,
	type ImplementationWorkerRunner,
} from './implementation-worker-service.ts';

const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	truncated: boolean;
}

interface ExecutionPaths {
	attemptRoot: string;
	workspacePath: string;
	evidencePath: string;
	sandboxHomePath: string;
	toolDataPath: string;
}

export interface ExecutionServiceOptions {
	ledger?: JobLedger;
	worker?: ImplementationWorkerRunner;
	workspaceRoot?: string;
	repositorySources?: Readonly<Record<string, string>>;
	repositorySourceRoot?: string;
	executablePath?: string;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
	if (state.bytes >= MAX_COMMAND_OUTPUT_BYTES) {
		state.truncated = true;
		return;
	}
	const remaining = MAX_COMMAND_OUTPUT_BYTES - state.bytes;
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += Math.min(chunk.byteLength, remaining);
	if (chunk.byteLength > remaining) state.truncated = true;
}

async function command(
	file: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
	const started = Date.now();
	return await new Promise((resolveResult, reject) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const stdoutState = { bytes: 0, truncated: false };
		const stderrState = { bytes: 0, truncated: false };
		let timedOut = false;
		child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState));
		child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrState));
		child.once('error', reject);
		const terminate = (signal: NodeJS.Signals) => {
			try {
				if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
			}
		};
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			terminate('SIGTERM');
			killTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
		}, options.timeoutMs);
		child.once('close', (exitCode) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolveResult({
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				truncated: stdoutState.truncated || stderrState.truncated,
			});
		});
	});
}

function cleanEnvironment(home: string, toolDataPath = resolve(home, '.local/share/mise'), executablePath = process.env.PATH ?? ''): NodeJS.ProcessEnv {
	return {
		PATH: `${resolve(toolDataPath, 'shims')}:${executablePath}`,
		LANG: process.env.LANG ?? 'C.UTF-8',
		HOME: home,
		TMPDIR: resolve(home, 'tmp'),
		MISE_DATA_DIR: toolDataPath,
		MISE_CACHE_DIR: resolve(toolDataPath, 'cache'),
		CI: 'true',
		GIT_TERMINAL_PROMPT: '0',
	};
}

function matchesProtectedPath(path: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	return path === pattern;
}

function nulList(value: string): string[] {
	return value.split('\0').filter(Boolean);
}

export class ExecutionService {
	readonly #ledger: JobLedger;
	readonly #worker: ImplementationWorkerRunner;
	readonly #workspaceRoot: string;
	readonly #repositorySources: Readonly<Record<string, string>>;
	readonly #repositorySourceRoot: string;
	readonly #executablePath: string;

	constructor(options: ExecutionServiceOptions = {}) {
		this.#ledger = options.ledger ?? jobLedger;
		this.#worker = options.worker ?? runImplementationWorker;
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#repositorySources = options.repositorySources ?? (!options.repositorySourceRoot && process.env.BOBSLED_CLIX_SOURCE_PATH
			? { 'frostyard/clix': resolve(process.env.BOBSLED_CLIX_SOURCE_PATH) }
			: {});
		this.#repositorySourceRoot = resolve(
			options.repositorySourceRoot ?? process.env.BOBSLED_REPOSITORY_SOURCE_ROOT ?? resolve(this.#workspaceRoot, 'sources'),
		);
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
	}

	async execute(runId: string, input: unknown, principal: Principal): Promise<RunRecord> {
		const execution = this.#ledger.authorizeExecution(runId, input, principal);
		let paths: ExecutionPaths | undefined;
		try {
			paths = await this.#createWorkspace(execution);
			this.#ledger.markExecutionRunning(execution, principal);
			const baseCommit = await this.#git(paths.workspacePath, ['rev-parse', 'HEAD']);
			const preparation = await this.#prepareWorkspace(execution, paths);
			if (preparation.status !== 'passed') {
				return this.#ledger.completeExecution(execution, 'failed', { preparation }, [{
					kind: 'workspace_preparation',
					uri: this.#artifactUri(execution, 'evidence/workspace-preparation.json'),
					metadata: { status: preparation.status, command: preparation.command },
				}], principal);
			}
			const worker = await this.#worker({
				runId: execution.runId,
				jobId: execution.jobId,
				attemptId: execution.attemptId,
				workspacePath: paths.workspacePath,
				sandboxHomePath: paths.sandboxHomePath,
				toolDataPath: paths.toolDataPath,
				executablePath: this.#executablePath,
				baseCommit,
				repository: execution.repository,
				workItem: execution.workItem,
			}, execution.repository.executionPolicy.workerTimeoutMinutes * 60_000);
			await writeFile(resolve(paths.evidencePath, 'implementation-plan.json'), `${JSON.stringify(worker.plan, null, 2)}\n`, { mode: 0o600 });
			await writeFile(resolve(paths.evidencePath, 'worker-result.json'), `${JSON.stringify(worker, null, 2)}\n`, { mode: 0o600 });

			const gates = await this.#runGates(execution, paths);
			const evidence = await this.#collectEvidence(execution, paths, baseCommit, gates, worker.result.disposition);
			const status = evidence.policyViolations.length === 0 && gates.every(({ status }) => status === 'passed')
				? 'succeeded' as const
				: 'blocked' as const;
			return this.#ledger.completeExecution(execution, status, { preparation, worker, evidence }, this.#artifacts(execution, paths, evidence), principal);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Execution failed';
			const evidencePath = paths?.evidencePath ?? resolve(this.#workspaceRoot, 'runs', execution.jobId, `${execution.attemptNumber}-${execution.attemptId}`, 'evidence');
			await mkdir(evidencePath, { recursive: true, mode: 0o700 });
			const errorPath = resolve(evidencePath, 'execution-error.json');
			await writeFile(errorPath, `${JSON.stringify({ error: message }, null, 2)}\n`, { mode: 0o600 });
			return this.#ledger.completeExecution(execution, 'failed', { error: message }, [{
				kind: 'execution_error',
				uri: this.#artifactUri(execution, 'evidence/execution-error.json'),
				metadata: { message },
			}], principal);
		}
	}

	async #createWorkspace(execution: AuthorizedExecution): Promise<ExecutionPaths> {
		const explicitSource = this.#repositorySources[execution.repository.id];
		const configuredSource = explicitSource
			?? resolve(this.#repositorySourceRoot, ...execution.repository.id.split('/'));
		const source = await realpath(configuredSource).catch(() => undefined);
		if (!source) throw new Error(`Configured source checkout is unavailable for ${execution.repository.id}`);
		if (!explicitSource) {
			const sourceRoot = await realpath(this.#repositorySourceRoot).catch(() => undefined);
			if (!sourceRoot || !source.startsWith(`${sourceRoot}/`)) {
				throw new Error(`Configured source checkout escapes the repository source root for ${execution.repository.id}`);
			}
		}
		const topLevel = await this.#git(source, ['rev-parse', '--show-toplevel']);
		if (await realpath(topLevel) !== source) throw new Error('Configured repository source must be the Git worktree root');
		const baseCommit = await this.#git(source, ['rev-parse', '--verify', `${execution.repository.defaultBranch}^{commit}`]);
		const attemptRoot = resolve(this.#workspaceRoot, 'runs', execution.jobId, `${execution.attemptNumber}-${execution.attemptId}`);
		const workspacePath = resolve(attemptRoot, 'repo');
		const evidencePath = resolve(attemptRoot, 'evidence');
		const sandboxHomePath = resolve(attemptRoot, 'home');
		const toolDataPath = resolve(this.#workspaceRoot, 'tool-cache', execution.repository.id.replace('/', '__'), 'mise');
		await mkdir(evidencePath, { recursive: true, mode: 0o700 });
		await mkdir(resolve(sandboxHomePath, 'tmp'), { recursive: true, mode: 0o700 });
		await mkdir(resolve(toolDataPath, 'cache'), { recursive: true, mode: 0o700 });
		const added = await command('git', ['worktree', 'add', '--detach', workspacePath, baseCommit], {
			cwd: source,
			timeoutMs: 60_000,
			env: cleanEnvironment(sandboxHomePath, toolDataPath, this.#executablePath),
		});
		if (added.exitCode !== 0) throw new Error(`Unable to create isolated Git worktree: ${added.stderr.trim() || added.stdout.trim()}`);
		return { attemptRoot, workspacePath, evidencePath, sandboxHomePath, toolDataPath };
	}

	async #prepareWorkspace(execution: AuthorizedExecution, paths: ExecutionPaths): Promise<PreparationResult> {
		const preparation = execution.repository.workspacePreparation;
		const result = await command('/bin/sh', ['-c', preparation.command], {
			cwd: paths.workspacePath,
			timeoutMs: preparation.timeoutMinutes * 60_000,
			env: cleanEnvironment(paths.sandboxHomePath, paths.toolDataPath, this.#executablePath),
		});
		const recorded = v.parse(PreparationResultSchema, {
			name: preparation.name,
			command: preparation.command,
			networkAccess: preparation.networkAccess,
			status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed',
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			stdout: result.stdout,
			stderr: result.stderr,
			truncated: result.truncated,
		});
		await writeFile(resolve(paths.evidencePath, 'workspace-preparation.json'), `${JSON.stringify(recorded, null, 2)}\n`, { mode: 0o600 });
		return recorded;
	}

	async #runGates(execution: AuthorizedExecution, paths: ExecutionPaths): Promise<GateResult[]> {
		const gateById = new Map(execution.repository.qualityGates.map((gate) => [gate.id, gate]));
		const results: GateResult[] = [];
		for (const id of execution.repository.executionPolicy.requiredGateIds) {
			const gate = gateById.get(id);
			if (!gate) throw new Error(`Required gate is missing from the policy snapshot: ${id}`);
			const result = await command('/bin/sh', ['-c', gate.command], {
				cwd: paths.workspacePath,
				timeoutMs: execution.repository.executionPolicy.gateTimeoutMinutes * 60_000,
				env: cleanEnvironment(paths.sandboxHomePath, paths.toolDataPath, this.#executablePath),
			});
			results.push(v.parse(GateResultSchema, {
				id: gate.id,
				name: gate.name,
				command: gate.command,
				status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed',
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				stdout: result.stdout,
				stderr: result.stderr,
				truncated: result.truncated,
			}));
			if (result.timedOut || result.exitCode !== 0) break;
		}
		await writeFile(resolve(paths.evidencePath, 'gate-results.json'), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
		return results;
	}

	async #collectEvidence(
		execution: AuthorizedExecution,
		paths: ExecutionPaths,
		baseCommit: string,
		gates: GateResult[],
		disposition: 'changed' | 'no_change' | 'blocked',
	): Promise<DraftPatchEvidence> {
		const untracked = nulList(await this.#git(paths.workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']));
		if (untracked.length > 0) {
			const intent = await command('git', ['add', '-N', '--', ...untracked], {
				cwd: paths.workspacePath, timeoutMs: 60_000, env: cleanEnvironment(paths.sandboxHomePath, paths.toolDataPath, this.#executablePath),
			});
			if (intent.exitCode !== 0) throw new Error(`Unable to include new files in draft evidence: ${intent.stderr.trim()}`);
		}
		const headCommit = await this.#git(paths.workspacePath, ['rev-parse', 'HEAD']);
		const patch = await this.#git(paths.workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', baseCommit, '--'], false);
		const changedPaths = nulList(await this.#git(paths.workspacePath, ['diff', '--name-only', '-z', '--no-renames', baseCommit, '--']));
		const numstat = await this.#git(paths.workspacePath, ['diff', '--numstat', '--no-renames', baseCommit, '--']);
		let diffLines = 0;
		for (const line of numstat.split('\n').filter(Boolean)) {
			const [added, deleted] = line.split('\t', 3);
			if (added !== '-' && deleted !== '-') diffLines += Number(added) + Number(deleted);
		}
		const protectedPaths = changedPaths.filter((path) => execution.repository.protectedBoundaries.some((boundary) =>
			boundary.paths.some((pattern) => matchesProtectedPath(path, pattern)),
		));
		const policyViolations: string[] = [];
		if (disposition === 'blocked') policyViolations.push('Worker reported that the task could not be completed safely');
		if (disposition === 'changed' && changedPaths.length === 0) policyViolations.push('Worker reported changes but produced no draft patch');
		if (disposition === 'no_change' && changedPaths.length > 0) policyViolations.push('Worker reported no change but produced a draft patch');
		if (changedPaths.length > execution.repository.executionPolicy.maxFiles) policyViolations.push(`Draft changes ${changedPaths.length} files; policy allows ${execution.repository.executionPolicy.maxFiles}`);
		if (diffLines > execution.repository.executionPolicy.maxDiffLines) policyViolations.push(`Draft changes ${diffLines} lines; policy allows ${execution.repository.executionPolicy.maxDiffLines}`);
		if (headCommit !== baseCommit) policyViolations.push('Worker moved HEAD or created a commit; M3 permits only an uncommitted draft patch');
		if (protectedPaths.length > 0) policyViolations.push(`Draft touches protected paths: ${protectedPaths.join(', ')}`);
		if (gates.some(({ status }) => status !== 'passed')) policyViolations.push('One or more required repository gates did not pass');
		const patchDigest = createHash('sha256').update(patch).digest('hex');
		await writeFile(resolve(paths.evidencePath, 'draft.patch'), patch, { mode: 0o600 });
		const evidence = v.parse(DraftPatchEvidenceSchema, {
			baseCommit,
			headCommit,
			headMoved: headCommit !== baseCommit,
			changedPaths,
			filesChanged: changedPaths.length,
			diffLines,
			diffSha256: patchDigest,
			protectedPaths,
			policyViolations,
			gates,
			workspacePath: paths.workspacePath,
			evidencePath: paths.evidencePath,
		});
		await writeFile(resolve(paths.evidencePath, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		return evidence;
	}

	#artifacts(execution: AuthorizedExecution, paths: ExecutionPaths, evidence: DraftPatchEvidence) {
		return [
			{ kind: 'workspace_preparation', uri: this.#artifactUri(execution, 'evidence/workspace-preparation.json'), metadata: {} },
			{ kind: 'implementation_plan', uri: this.#artifactUri(execution, 'evidence/implementation-plan.json'), metadata: {} },
			{ kind: 'worker_result', uri: this.#artifactUri(execution, 'evidence/worker-result.json'), metadata: {} },
			{ kind: 'gate_results', uri: this.#artifactUri(execution, 'evidence/gate-results.json'), metadata: { passed: evidence.gates.every(({ status }) => status === 'passed') } },
			{ kind: 'draft_patch', uri: this.#artifactUri(execution, 'evidence/draft.patch'), digest: evidence.diffSha256, metadata: { filesChanged: evidence.filesChanged, diffLines: evidence.diffLines } },
			{ kind: 'execution_summary', uri: this.#artifactUri(execution, 'evidence/summary.json'), metadata: { policyViolations: evidence.policyViolations } },
		];
	}

	#artifactUri(execution: AuthorizedExecution, suffix: string): string {
		return `workspace://runs/${execution.jobId}/${execution.attemptNumber}-${execution.attemptId}/${suffix}`;
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await command('git', args, { cwd, timeoutMs: 60_000, env: cleanEnvironment(cwd) });
		if (result.timedOut || result.exitCode !== 0) throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
		return trim ? result.stdout.trim() : result.stdout;
	}
}

export const executionService = new ExecutionService();
