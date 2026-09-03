import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
	IntegrationConflictAgentInitialDataSchema,
	type IntegrationConflictAgentOutcome,
} from './integration-conflict-agent-contracts.ts';
import {
	runIntegrationConflictAgent,
	type IntegrationConflictAgentRunner,
} from './integration-conflict-agent-service.ts';
import {
	IntegrationConflictAgentInvocationStore,
	type IntegrationConflictAgentInvocation,
} from './integration-conflict-agent-invocation-store.ts';
import {
	IntegrationConflictResolutionResultSchema,
	type IntegrationConflictResolutionResult,
} from './integration-conflict-resolution-contracts.ts';
import { conflictNonTargetStateSha256, conflictTargetStateSha256 } from './integration-conflict-state.ts';
import { IntegrationConflictAgentPreflightService } from './integration-conflict-agent-preflight-service.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CONFLICT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;

export interface IntegrationConflictAgentOrchestrationOptions {
	worker?: IntegrationConflictAgentRunner;
	preflight?: IntegrationConflictAgentPreflightService;
	toolDataRoot?: string;
	executablePath?: string;
	now?: () => Date;
}

export class IntegrationConflictAgentOrchestrationService {
	readonly #worker: IntegrationConflictAgentRunner;
	readonly #preflight: IntegrationConflictAgentPreflightService;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;
	readonly #now: () => Date;

	constructor(
		private readonly store: IntegrationConflictAgentInvocationStore,
		options: IntegrationConflictAgentOrchestrationOptions = {},
	) {
		this.#worker = options.worker ?? runIntegrationConflictAgent;
		this.#preflight = options.preflight ?? new IntegrationConflictAgentPreflightService(store, {
			toolDataRoot: options.toolDataRoot,
			executablePath: options.executablePath,
		});
		this.#toolDataRoot = resolve(options.toolDataRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces', 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#now = options.now ?? (() => new Date());
	}

	async execute(agentAttemptId: string, ownerId: string): Promise<IntegrationConflictAgentInvocation> {
		let lease = this.store.get(agentAttemptId, ownerId);
		if (['resolved', 'blocked', 'failed'].includes(lease.status)) return lease;
		if (!lease.preflight && lease.status === 'reserved') {
			lease = await this.#preflight.run(agentAttemptId, ownerId);
			if (lease.status !== 'reserved') return lease;
		}
		if (lease.status === 'preparing') return lease;
		const context = this.store.getContext(agentAttemptId, ownerId);
		const preflight = lease.preflight?.result;
		if (lease.status === 'reserved' && preflight?.status === 'passed') {
			try {
				const head = await this.#git(preflight.workspacePath, ['rev-parse', 'HEAD']);
				const unmerged = await this.#paths(preflight.workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--']);
				const nonConflict = await conflictNonTargetStateSha256(preflight.workspacePath, preflight.conflictPaths);
				const conflictState = await conflictTargetStateSha256(preflight.workspacePath, preflight.conflictPaths);
				if (head !== context.baseCommit || !samePaths(unmerged, preflight.conflictPaths)
					|| nonConflict !== preflight.nonConflictStateSha256 || conflictState !== preflight.conflictStateSha256) {
					return this.store.blockBeforeDispatch(agentAttemptId, ownerId,
						'Conflict replay workspace changed after trusted preflight; model call denied');
				}
			} catch (error) {
				return this.store.blockBeforeDispatch(agentAttemptId, ownerId,
					(error instanceof Error ? error.message : 'Conflict replay workspace could not be revalidated').slice(0, 10_000));
			}
		}
		const claim = this.store.claim(agentAttemptId, ownerId);
		lease = claim.lease;
		if (!claim.newlyClaimed) {
			if (lease.status !== 'running' || lease.workerRun) return lease;
			const startedAt = lease.startedAt ? Date.parse(lease.startedAt) : Number.NaN;
			const staleAfterMs = (context.repository.executionPolicy.workerTimeoutMinutes + 1) * 60_000;
			if (Number.isFinite(startedAt) && this.#now().getTime() - startedAt <= staleAfterMs) return lease;
			return this.store.failClaimed(agentAttemptId, ownerId,
				'Conflict-agent recovery found an expired ambiguous model call; retry is forbidden');
		}
		if (preflight?.status !== 'passed') {
			return this.store.failClaimed(agentAttemptId, ownerId, 'Claimed conflict-agent invocation lost its passing preflight evidence');
		}

		const sandboxHomePath = resolve(preflight.workspacePath, '..', 'worker-home');
		await mkdir(resolve(sandboxHomePath, 'tmp'), { recursive: true, mode: 0o700 });
		const initialData = v.parse(IntegrationConflictAgentInitialDataSchema, {
			agentAttemptId, sourceResolutionId: lease.sourceResolutionId,
			workspacePath: preflight.workspacePath, sandboxHomePath,
			toolDataPath: resolve(this.#toolDataRoot, context.repository.id.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath, baseCommit: context.baseCommit,
			conflictPaths: preflight.conflictPaths, nonConflictStateSha256: preflight.nonConflictStateSha256,
			plan: context.plan, taskId: lease.taskId, repository: context.repository,
			workItem: context.workItem, maxModelCalls: 1,
		});
		let workerOutcome: IntegrationConflictAgentOutcome;
		try {
			workerOutcome = await this.#worker(initialData, context.repository.executionPolicy.workerTimeoutMinutes * 60_000);
		} catch (error) {
			return this.store.failClaimed(agentAttemptId, ownerId,
				(error instanceof Error ? error.message : 'Conflict resolver failed').slice(0, 10_000));
		}

		let result: IntegrationConflictResolutionResult;
		try {
			result = await this.#evaluate(initialData, workerOutcome, context.sourceResolution);
			await writeFile(resolve(preflight.workspacePath, '..', 'evidence', 'agent-resolution-result.json'),
				`${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		} catch (error) {
			return this.store.failClaimed(agentAttemptId, ownerId,
				(error instanceof Error ? error.message : 'Conflict resolver postcondition inspection failed').slice(0, 10_000));
		}
		return this.store.complete(agentAttemptId, ownerId, workerOutcome, result);
	}

	async #evaluate(
		initialData: v.InferOutput<typeof IntegrationConflictAgentInitialDataSchema>,
		workerOutcome: IntegrationConflictAgentOutcome,
		source: ReturnType<IntegrationConflictAgentInvocationStore['getContext']>['sourceResolution'],
	): Promise<IntegrationConflictResolutionResult> {
		const manifest = source.replayManifest;
		if (!manifest) throw new Error('Passing conflict replay lost its authenticated manifest');
		const workspacePath = initialData.workspacePath;
		const headCommit = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
		const unmergedPaths = await this.#paths(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--']);
		const unstagedPaths = await this.#paths(workspacePath, ['diff', '--name-only', '-z', '--no-renames', '--']);
		const untrackedPaths = await this.#paths(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
		const changedPaths = await this.#paths(workspacePath, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']);
		const nonConflictState = await conflictNonTargetStateSha256(workspacePath, initialData.conflictPaths);
		const markerPaths = await this.#conflictMarkerPaths(workspacePath, initialData.conflictPaths);
		let reason: Extract<IntegrationConflictResolutionResult, { status: 'blocked' }>['reason'] | undefined;
		if (workerOutcome.result.disposition === 'blocked') reason = 'worker_blocked';
		else if (headCommit !== initialData.baseCommit) reason = 'head_moved';
		else if (unmergedPaths.length > 0) reason = 'unmerged_paths';
		else if (nonConflictState !== initialData.nonConflictStateSha256) reason = 'non_conflict_changed';
		else if (!sameUniquePaths(workerOutcome.result.resolvedPaths, initialData.conflictPaths)) reason = 'reported_paths_mismatch';
		else if (unstagedPaths.length > 0 || untrackedPaths.length > 0) reason = 'unstaged_changes';
		else if (markerPaths.length > 0) reason = 'conflict_markers';
		if (reason) return this.#blocked(initialData, source, manifest, changedPaths, unmergedPaths, reason,
			`Trusted conflict-agent inspection blocked: ${reason}`);

		const failedIndex = manifest.orderedPatches.findIndex(({ taskId }) => taskId === source.failedTaskId);
		if (failedIndex < 0 || !source.failedTaskId) {
			throw new Error('Authenticated replay manifest no longer contains the failed task');
		}
		const appliedTaskIds = [...source.appliedTaskIds, source.failedTaskId];
		for (const [index, entry] of manifest.orderedPatches.entries()) {
			if (index <= failedIndex) continue;
			const evidenceRoot = await realpath(resolve(workspacePath, '..', 'evidence'));
			const patchPath = resolve(evidenceRoot, `${String(index + 1).padStart(2, '0')}-${entry.taskId}.patch`);
			const stat = await lstat(patchPath);
			const canonicalPath = await realpath(patchPath);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PATCH_BYTES
				|| !canonicalPath.startsWith(`${evidenceRoot}/`)) {
				return this.#blocked(initialData, source, manifest, await this.#changedPaths(workspacePath), [],
					'remaining_patch_rejected', `Remaining patch evidence is not a bounded regular file: ${entry.taskId}`, appliedTaskIds);
			}
			const patch = await readFile(canonicalPath, 'utf8');
			if (createHash('sha256').update(patch).digest('hex') !== entry.patchSha256) {
				return this.#blocked(initialData, source, manifest, await this.#changedPaths(workspacePath), [],
					'remaining_patch_rejected', `Remaining patch evidence changed after preflight: ${entry.taskId}`, appliedTaskIds);
			}
			const applied = await this.#gitResult(workspacePath, ['apply', '--3way', '--index', '--', canonicalPath]);
			if (applied.exitCode !== 0) {
				const conflicts = await this.#paths(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--']);
				return this.#blocked(initialData, source, manifest, await this.#changedPaths(workspacePath), conflicts,
					'remaining_patch_rejected', `Remaining patch did not apply after the sole model call: ${entry.taskId}`, appliedTaskIds);
			}
			appliedTaskIds.push(entry.taskId);
		}

		const finalHead = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
		const finalUnmerged = await this.#paths(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--']);
		const finalChangedPaths = await this.#changedPaths(workspacePath);
		const expectedPaths = manifest.orderedPatches.flatMap(({ changedPaths: paths }) => paths);
		let finalReason: Extract<IntegrationConflictResolutionResult, { status: 'blocked' }>['reason'] | undefined;
		if (finalHead !== initialData.baseCommit) finalReason = 'head_moved';
		else if (finalUnmerged.length > 0) finalReason = 'unmerged_paths';
		else if (!samePaths(finalChangedPaths, expectedPaths)) finalReason = 'changed_path_mismatch';
		else if (finalChangedPaths.length > initialData.repository.executionPolicy.maxFiles) finalReason = 'file_limit';
		const patch = await this.#git(workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--'], false);
		const numstat = await this.#git(workspacePath, ['diff', '--numstat', '--no-renames', 'HEAD', '--'], false);
		const diffLines = countDiffLines(numstat);
		if (!finalReason && diffLines > initialData.repository.executionPolicy.maxDiffLines) finalReason = 'diff_limit';
		if (!finalReason && finalChangedPaths.some((path) => initialData.repository.protectedBoundaries.some((boundary) =>
			boundary.paths.some((pattern) => matchesProtectedPath(path, pattern)),
		))) finalReason = 'protected_path';
		if (finalReason) return this.#blocked(initialData, source, manifest, finalChangedPaths, finalUnmerged, finalReason,
			`Final conflict stack failed trusted policy: ${finalReason}`, appliedTaskIds);
		return v.parse(IntegrationConflictResolutionResultSchema, {
			resolutionId: initialData.agentAttemptId, sourceResolutionId: initialData.sourceResolutionId,
			sourceAssemblyId: source.sourceAssemblyId, taskId: initialData.taskId, baseCommit: initialData.baseCommit,
			workspacePath, strategy: 'codex_one_call', appliedTaskIds, changedPaths: finalChangedPaths,
			conflictPaths: [], replayManifest: manifest, modelCalls: 1, workerAuthorized: false,
			status: 'resolved', patchSha256: createHash('sha256').update(patch).digest('hex'),
		});
	}

	#blocked(
		initialData: v.InferOutput<typeof IntegrationConflictAgentInitialDataSchema>,
		source: ReturnType<IntegrationConflictAgentInvocationStore['getContext']>['sourceResolution'],
		manifest: NonNullable<ReturnType<IntegrationConflictAgentInvocationStore['getContext']>['sourceResolution']['replayManifest']>,
		changedPaths: string[],
		conflictPaths: string[],
		reason: Extract<IntegrationConflictResolutionResult, { status: 'blocked' }>['reason'],
		detail: string,
		appliedTaskIds = source.appliedTaskIds,
	): IntegrationConflictResolutionResult {
		return v.parse(IntegrationConflictResolutionResultSchema, {
			resolutionId: initialData.agentAttemptId, sourceResolutionId: initialData.sourceResolutionId,
			sourceAssemblyId: source.sourceAssemblyId, taskId: initialData.taskId, baseCommit: initialData.baseCommit,
			workspacePath: initialData.workspacePath, strategy: 'codex_one_call',
			appliedTaskIds, changedPaths, conflictPaths, replayManifest: manifest,
			modelCalls: 1, workerAuthorized: false, status: 'blocked', reason, detail,
		});
	}

	async #conflictMarkerPaths(workspacePath: string, paths: readonly string[]): Promise<string[]> {
		const matches: string[] = [];
		const workspaceRoot = await realpath(workspacePath);
		for (const path of paths) {
			const absolute = resolve(workspaceRoot, path);
			const stat = await lstat(absolute);
			const canonicalPath = await realpath(absolute);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFLICT_FILE_BYTES
				|| !canonicalPath.startsWith(`${workspaceRoot}/`)) { matches.push(path); continue; }
			const content = await readFile(canonicalPath, 'utf8');
			if (/^(?:<{7}|={7}|>{7})(?: |$)/m.test(content)) matches.push(path);
		}
		return matches;
	}

	async #changedPaths(workspacePath: string): Promise<string[]> {
		return this.#paths(workspacePath, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']);
	}

	async #paths(cwd: string, args: string[]): Promise<string[]> {
		return (await this.#git(cwd, args, false)).split('\0').filter(Boolean);
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await this.#gitResult(cwd, args);
		if (result.exitCode !== 0) throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
		return trim ? result.stdout.trim() : result.stdout;
	}

	async #gitResult(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const result = await execFileAsync('git', args, {
				cwd, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8',
				env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' },
			});
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
		} catch (error) {
			const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
			if (typeof failure.code !== 'number') throw error;
			return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
		}
	}
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

function sameUniquePaths(left: readonly string[], right: readonly string[]): boolean {
	return left.length === new Set(left).size && right.length === new Set(right).size
		&& [...left].sort().join('\0') === [...right].sort().join('\0');
}

function matchesProtectedPath(path: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	return path === pattern;
}

function countDiffLines(numstat: string): number {
	let total = 0;
	for (const line of numstat.split('\n').filter(Boolean)) {
		const [added, deleted] = line.split('\t', 3);
		if (added !== '-' && deleted !== '-') total += Number(added) + Number(deleted);
	}
	return total;
}
