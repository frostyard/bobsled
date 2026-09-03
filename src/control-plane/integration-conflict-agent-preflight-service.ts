import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { PreparationResultSchema } from './execution-contracts.ts';
import {
	IntegrationConflictAgentPreflightResultSchema,
	type IntegrationConflictAgentPreflightResult,
	type IntegrationConflictAgentPreflightViolation,
} from './integration-conflict-agent-preflight-contracts.ts';
import {
	IntegrationConflictAgentInvocationStore,
	type IntegrationConflictAgentContext,
	type IntegrationConflictAgentInvocation,
} from './integration-conflict-agent-invocation-store.ts';
import {
	integrationConflictReplayManifestDigest,
	type IntegrationConflictReplayManifest,
} from './integration-conflict-resolution-contracts.ts';
import {
	IntegrationCommandContextSchema,
	runIntegrationCommand,
	type IntegrationCommandRunner,
} from './integration-command-service.ts';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_STACK_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

export interface IntegrationConflictAgentPreflightOptions {
	workspaceRoot?: string;
	runner?: IntegrationCommandRunner;
	toolDataRoot?: string;
	executablePath?: string;
}

export class IntegrationConflictAgentPreflightError extends Error {}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function nulList(value: string): string[] {
	return value.split('\0').filter(Boolean);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

export class IntegrationConflictAgentPreflightService {
	readonly #workspaceRoot: string;
	readonly #runner: IntegrationCommandRunner;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;

	constructor(private readonly store: IntegrationConflictAgentInvocationStore, options: IntegrationConflictAgentPreflightOptions = {}) {
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#runner = options.runner ?? runIntegrationCommand;
		this.#toolDataRoot = resolve(options.toolDataRoot ?? this.#workspaceRoot, 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
	}

	async run(agentAttemptId: string, ownerId: string): Promise<IntegrationConflictAgentInvocation> {
		const context = this.store.getContext(agentAttemptId, ownerId);
		const claim = this.store.claimPreflight(agentAttemptId, ownerId);
		if (!claim.newlyClaimed) return claim.lease;
		try {
			return await this.#runClaimed(agentAttemptId, ownerId, context);
		} catch (error) {
			const latest = this.store.get(agentAttemptId, ownerId);
			if (latest.status !== 'preparing' || latest.preflight?.result) return latest;
			return this.#block(agentAttemptId, ownerId, {
				workspacePath: resolve(this.#workspaceRoot, 'integration-agent-resolutions', agentAttemptId, 'repo'),
				baseCommit: context.baseCommit, appliedTaskIds: [], changedPaths: [], conflictPaths: [],
			}, ['replay_failed'], error instanceof Error ? error.message : 'Conflict replay preflight failed');
		}
	}

	async #runClaimed(
		agentAttemptId: string,
		ownerId: string,
		context: IntegrationConflictAgentContext,
	): Promise<IntegrationConflictAgentInvocation> {
		const workspacePath = resolve(this.#workspaceRoot, 'integration-agent-resolutions', agentAttemptId, 'repo');
		const evidencePath = resolve(this.#workspaceRoot, 'integration-agent-resolutions', agentAttemptId, 'evidence');
		const source = context.sourceResolution;
		if (!context.repository.capabilities.writeCode || !context.repository.executionPolicy.enabled) {
			return this.#block(agentAttemptId, ownerId, {
				workspacePath, baseCommit: context.baseCommit, appliedTaskIds: [], changedPaths: [], conflictPaths: [],
			}, ['policy_denied'], 'Repository snapshot does not authorize code execution');
		}
		const manifest = source.replayManifest;
		if (!manifest) return this.#block(agentAttemptId, ownerId, {
			workspacePath, baseCommit: context.baseCommit, appliedTaskIds: [], changedPaths: [], conflictPaths: [],
		}, ['missing_replay_manifest'], 'Historical conflict evidence has no authenticated replay manifest');
		if (manifest.stackSha256 !== integrationConflictReplayManifestDigest(manifest.orderedPatches)) {
			return this.#block(agentAttemptId, ownerId, {
				workspacePath, baseCommit: context.baseCommit, appliedTaskIds: [], changedPaths: [], conflictPaths: [],
			}, ['patch_evidence_tampered'], 'Conflict replay manifest digest is invalid');
		}

		let patches: string[];
		try {
			patches = await this.#loadPatches(context.sourceWorkspacePath, manifest);
		} catch (error) {
			return this.#block(agentAttemptId, ownerId, {
				workspacePath, baseCommit: context.baseCommit, appliedTaskIds: [], changedPaths: [], conflictPaths: [],
			}, ['patch_evidence_tampered'], error instanceof Error ? error.message : 'Patch evidence could not be authenticated');
		}

		await mkdir(evidencePath, { recursive: true, mode: 0o700 });
		try {
			const sourceRoot = await this.#git(context.sourceWorkspacePath, ['rev-parse', '--show-toplevel']);
			if (await realpath(sourceRoot) !== await realpath(context.sourceWorkspacePath)) {
				throw new IntegrationConflictAgentPreflightError('Conflict source workspace is not its Git worktree root');
			}
			if (await lstat(workspacePath).then(() => true, () => false)) {
				throw new IntegrationConflictAgentPreflightError('Conflict-agent replay workspace already exists');
			}
			await this.#git(context.sourceWorkspacePath, ['worktree', 'add', '--detach', workspacePath, context.baseCommit]);
		} catch (error) {
			return this.#block(agentAttemptId, ownerId, {
				workspacePath, baseCommit: context.baseCommit, appliedTaskIds: [], changedPaths: [], conflictPaths: [],
			}, ['replay_failed'], error instanceof Error ? error.message : 'Fresh conflict replay workspace could not be created');
		}
		const preparationPolicy = context.repository.workspacePreparation;
		const commandContext = v.parse(IntegrationCommandContextSchema, {
			integrationAttemptId: agentAttemptId, workspacePath,
			sandboxHomePath: resolve(workspacePath, '..', 'preparation-home'),
			toolDataPath: resolve(this.#toolDataRoot, context.repository.id.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath, repository: context.repository,
		});
		const commandResult = await this.#runner(
			preparationPolicy.command, commandContext, preparationPolicy.timeoutMinutes * 60_000,
		).catch((error) => ({
			status: 'failed' as const, exitCode: null, durationMs: 0, stdout: '',
			stderr: error instanceof Error ? error.message : 'Preparation runner failed', truncated: false,
		}));
		const preparation = v.parse(PreparationResultSchema, {
			...commandResult, name: preparationPolicy.name, command: preparationPolicy.command,
			networkAccess: preparationPolicy.networkAccess,
		});
		let preparedHead: string;
		let preparedPaths: string[];
		try {
			preparedHead = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
			preparedPaths = await this.#statusPaths(workspacePath);
		} catch (error) {
			return this.#block(agentAttemptId, ownerId, {
				workspacePath, baseCommit: context.baseCommit, preparation,
				appliedTaskIds: [], changedPaths: [], conflictPaths: [],
			}, ['replay_failed'], error instanceof Error ? error.message : 'Prepared workspace could not be inspected');
		}
		if (preparation.status !== 'passed') return this.#block(agentAttemptId, ownerId, {
			workspacePath, baseCommit: context.baseCommit, preparation,
			headCommit: preparedHead || undefined, appliedTaskIds: [], changedPaths: preparedPaths, conflictPaths: [],
		}, ['preparation_failed'], 'Repository preparation did not pass');
		if (preparedHead !== context.baseCommit) return this.#block(agentAttemptId, ownerId, {
			workspacePath, baseCommit: context.baseCommit, preparation,
			headCommit: preparedHead || undefined, appliedTaskIds: [], changedPaths: preparedPaths, conflictPaths: [],
		}, ['head_moved'], 'Repository preparation moved the replay workspace HEAD');
		if (preparedPaths.length > 0) return this.#block(agentAttemptId, ownerId, {
			workspacePath, baseCommit: context.baseCommit, preparation,
			headCommit: preparedHead, appliedTaskIds: [], changedPaths: preparedPaths, conflictPaths: [],
		}, ['preparation_changed_workspace'], 'Repository preparation changed the clean replay workspace');

		const appliedTaskIds: string[] = [];
		for (const [index, entry] of manifest.orderedPatches.entries()) {
			const patch = patches[index] ?? '';
			if (patch.length === 0) {
				if (entry.changedPaths.length > 0) return this.#block(agentAttemptId, ownerId, {
					workspacePath, baseCommit: context.baseCommit, preparation, headCommit: preparedHead,
					appliedTaskIds, failedTaskId: entry.taskId, changedPaths: await this.#changedPaths(workspacePath), conflictPaths: [],
				}, ['patch_evidence_tampered'], `Empty replay patch claims changed paths: ${entry.taskId}`);
				appliedTaskIds.push(entry.taskId);
				continue;
			}
			const patchPath = resolve(evidencePath, `${String(index + 1).padStart(2, '0')}-${entry.taskId}.patch`);
			await writeFile(patchPath, patch, { mode: 0o600 });
			const applied = await this.#gitResult(workspacePath, ['apply', '--3way', '--index', '--', patchPath]);
			if (applied.exitCode === 0) {
				appliedTaskIds.push(entry.taskId);
				continue;
			}
			const conflictPaths = nulList(await this.#git(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--'], false));
			const changedPaths = await this.#changedPaths(workspacePath);
			const violations: IntegrationConflictAgentPreflightViolation[] = [];
			if (entry.taskId !== source.failedTaskId) violations.push('failed_task_mismatch');
			if (appliedTaskIds.join('\0') !== source.appliedTaskIds.join('\0')) violations.push('applied_prefix_mismatch');
			if (!samePaths(conflictPaths, source.conflictPaths)) violations.push('conflict_paths_mismatch');
			if (conflictPaths.length === 0) violations.push('replay_failed');
			const headCommit = await this.#git(workspacePath, ['rev-parse', 'HEAD']).catch(() => '');
			if (headCommit !== context.baseCommit) violations.push('head_moved');
			if (violations.length > 0) return this.#block(agentAttemptId, ownerId, {
				workspacePath, baseCommit: context.baseCommit, preparation, headCommit: headCommit || undefined,
				appliedTaskIds, failedTaskId: entry.taskId, changedPaths, conflictPaths,
			}, violations, 'Fresh replay did not exactly reproduce trusted conflict evidence');
			return this.#complete(agentAttemptId, ownerId, {
				agentAttemptId, sourceResolutionId: source.resolutionId, baseCommit: context.baseCommit,
				workspacePath, preparation, headCommit, appliedTaskIds, failedTaskId: entry.taskId,
				changedPaths, conflictPaths, modelCalls: 0, workerAuthorized: false,
				status: 'passed', violations: [],
			});
		}
		return this.#block(agentAttemptId, ownerId, {
			workspacePath, baseCommit: context.baseCommit, preparation, headCommit: preparedHead,
			appliedTaskIds, changedPaths: await this.#changedPaths(workspacePath), conflictPaths: [],
		}, ['conflict_not_reproduced'], 'Authenticated patch stack no longer produces the recorded conflict');
	}

	async #loadPatches(sourceWorkspacePath: string, manifest: IntegrationConflictReplayManifest): Promise<string[]> {
		const evidenceRoot = await realpath(resolve(sourceWorkspacePath, '..', 'evidence'));
		let stackBytes = 0;
		const patches: string[] = [];
		for (const [index, entry] of manifest.orderedPatches.entries()) {
			const patchPath = resolve(evidenceRoot, `${String(index + 1).padStart(2, '0')}-${entry.taskId}.patch`);
			const candidateStat = await lstat(patchPath);
			if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.size > MAX_PATCH_BYTES) {
				throw new IntegrationConflictAgentPreflightError(`Patch evidence is not a bounded regular file: ${entry.taskId}`);
			}
			const canonicalPath = await realpath(patchPath);
			if (!canonicalPath.startsWith(`${evidenceRoot}/`)) throw new IntegrationConflictAgentPreflightError('Patch evidence escapes its resolution directory');
			const patch = await readFile(canonicalPath, 'utf8');
			stackBytes += Buffer.byteLength(patch);
			if (stackBytes > MAX_STACK_BYTES || digest(patch) !== entry.patchSha256) {
				throw new IntegrationConflictAgentPreflightError(`Patch evidence digest or stack bound failed: ${entry.taskId}`);
			}
			patches.push(patch);
		}
		return patches;
	}

	async #complete(agentAttemptId: string, ownerId: string, input: unknown): Promise<IntegrationConflictAgentInvocation> {
		const result = v.parse(IntegrationConflictAgentPreflightResultSchema, input);
		await mkdir(resolve(result.workspacePath, '..', 'evidence'), { recursive: true, mode: 0o700 });
		await writeFile(resolve(result.workspacePath, '..', 'evidence', 'preflight-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		return this.store.completePreflight(agentAttemptId, ownerId, result);
	}

	async #block(
		agentAttemptId: string,
		ownerId: string,
		partial: Partial<IntegrationConflictAgentPreflightResult> | undefined,
		violations: IntegrationConflictAgentPreflightViolation[],
		detail: string,
	): Promise<IntegrationConflictAgentInvocation> {
		const lease = this.store.get(agentAttemptId, ownerId);
		return this.#complete(agentAttemptId, ownerId, {
			agentAttemptId, sourceResolutionId: lease.sourceResolutionId,
			baseCommit: partial?.baseCommit ?? '0'.repeat(40),
			workspacePath: partial?.workspacePath ?? resolve(this.#workspaceRoot, 'integration-agent-resolutions', agentAttemptId, 'repo'),
			preparation: partial?.preparation,
			headCommit: partial?.headCommit,
			appliedTaskIds: partial?.appliedTaskIds ?? [], failedTaskId: partial?.failedTaskId,
			changedPaths: partial?.changedPaths ?? [], conflictPaths: partial?.conflictPaths ?? [],
			modelCalls: 0, workerAuthorized: false, status: 'blocked', violations,
			detail: detail.slice(0, 10_000),
		});
	}

	async #changedPaths(workspacePath: string): Promise<string[]> {
		return nulList(await this.#git(workspacePath, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'], false));
	}

	async #statusPaths(workspacePath: string): Promise<string[]> {
		return nulList(await this.#git(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'], false))
			.map((entry) => entry.slice(3));
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await this.#gitResult(cwd, args);
		if (result.exitCode !== 0) throw new IntegrationConflictAgentPreflightError(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
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
			if (typeof failure.code !== 'number') throw new IntegrationConflictAgentPreflightError(`Unable to run Git: ${failure.message}`);
			return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
		}
	}
}
