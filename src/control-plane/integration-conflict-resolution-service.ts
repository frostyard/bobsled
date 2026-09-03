import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { IntegrationAssemblyPlanSchema, type IntegrationAssemblyPlan } from './integration-assembly-contracts.ts';
import {
	IntegrationPatchPayloadSchema,
	IntegrationWorkspaceResultSchema,
	type IntegrationPatchPayload,
	type IntegrationWorkspaceResult,
} from './integration-workspace-service.ts';
import {
	IntegrationConflictResolutionResultSchema,
	integrationConflictReplayManifestDigest,
	type IntegrationConflictResolutionResult,
} from './integration-conflict-resolution-contracts.ts';

const execFileAsync = promisify(execFile);
const MAX_STACK_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
export class IntegrationConflictResolutionError extends Error {}

export interface IntegrationConflictResolutionServiceOptions {
	workspaceRoot: string;
	repositorySource: string;
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function nulList(value: string): string[] {
	return value.split('\0').filter(Boolean);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

export class IntegrationConflictResolutionService {
	readonly #workspaceRoot: string;
	readonly #repositorySource: string;

	constructor(options: IntegrationConflictResolutionServiceOptions) {
		this.#workspaceRoot = resolve(options.workspaceRoot);
		this.#repositorySource = resolve(options.repositorySource);
	}

	async resolve(
		inputResolutionId: string,
		inputSourceAssembly: IntegrationWorkspaceResult,
		inputPlan: IntegrationAssemblyPlan,
		inputPayloads: readonly IntegrationPatchPayload[],
	): Promise<IntegrationConflictResolutionResult> {
		const resolutionId = v.parse(v.pipe(v.string(), v.uuid()), inputResolutionId);
		const sourceAssembly = v.parse(IntegrationWorkspaceResultSchema, inputSourceAssembly);
		const plan = v.parse(IntegrationAssemblyPlanSchema, inputPlan);
		if (sourceAssembly.status !== 'blocked' || sourceAssembly.reason !== 'patch_rejected' || !sourceAssembly.failedTaskId) {
			throw new IntegrationConflictResolutionError('Only a patch-rejected assembly can enter conflict resolution');
		}
		if (!plan.ready || plan.taskId !== sourceAssembly.taskId || plan.baseCommit !== sourceAssembly.baseCommit) {
			throw new IntegrationConflictResolutionError('Conflict resolution plan does not match its rejected assembly');
		}
		const failedIndex = plan.orderedPatches.findIndex(({ taskId }) => taskId === sourceAssembly.failedTaskId);
		if (failedIndex < 0) {
			throw new IntegrationConflictResolutionError('Rejected task is absent from the trusted patch stack');
		}
		const expectedAppliedTaskIds = plan.orderedPatches.slice(0, failedIndex).map(({ taskId }) => taskId);
		if (sourceAssembly.appliedTaskIds.join('\0') !== expectedAppliedTaskIds.join('\0')) {
			throw new IntegrationConflictResolutionError('Rejected assembly does not preserve the expected applied patch prefix');
		}
		if (inputPayloads.length !== plan.orderedPatches.length) {
			throw new IntegrationConflictResolutionError('Patch payload count does not match the trusted resolution plan');
		}
		const payloads = inputPayloads.map((payload) => v.parse(IntegrationPatchPayloadSchema, payload));
		let stackBytes = 0;
		for (const [index, payload] of payloads.entries()) {
			const expected = plan.orderedPatches[index];
			if (!expected || payload.taskId !== expected.taskId || payload.patchSha256 !== expected.patchSha256) {
				throw new IntegrationConflictResolutionError(`Patch payload does not match resolution order at index ${index}`);
			}
			stackBytes += Buffer.byteLength(payload.patch);
			if (digest(payload.patch) !== payload.patchSha256) {
				throw new IntegrationConflictResolutionError(`Patch payload digest does not match trusted evidence: ${payload.taskId}`);
			}
		}
		if (stackBytes > MAX_STACK_BYTES) throw new IntegrationConflictResolutionError('Patch stack exceeds the 2 MiB resolution limit');
		const orderedPatches = plan.orderedPatches.map((patch) => ({ ...patch }));
		const replayManifest = { orderedPatches, stackSha256: integrationConflictReplayManifestDigest(orderedPatches) };

		const source = await realpath(this.#repositorySource).catch(() => undefined);
		if (!source) throw new IntegrationConflictResolutionError('Configured integration source is unavailable');
		const topLevel = await this.#git(source, ['rev-parse', '--show-toplevel']);
		if (await realpath(topLevel) !== source) throw new IntegrationConflictResolutionError('Integration source must be the Git worktree root');
		const verifiedBase = await this.#git(source, ['rev-parse', '--verify', `${plan.baseCommit}^{commit}`]);
		if (verifiedBase !== plan.baseCommit) throw new IntegrationConflictResolutionError('Resolution base commit is not canonical for this repository');

		await mkdir(this.#workspaceRoot, { recursive: true, mode: 0o700 });
		const root = await realpath(this.#workspaceRoot);
		const resolutionRoot = resolve(root, 'integration-resolutions', resolutionId);
		const workspacePath = resolve(resolutionRoot, 'repo');
		const evidencePath = resolve(resolutionRoot, 'evidence');
		if (await lstat(resolutionRoot).then(() => true, () => false)) {
			throw new IntegrationConflictResolutionError('Integration resolution workspace already exists');
		}
		await mkdir(evidencePath, { recursive: true, mode: 0o700 });
		await this.#git(source, ['worktree', 'add', '--detach', workspacePath, plan.baseCommit]);

		const appliedTaskIds: string[] = [];
		for (const [index, payload] of payloads.entries()) {
			const patchPath = resolve(evidencePath, `${String(index + 1).padStart(2, '0')}-${payload.taskId}.patch`);
			await writeFile(patchPath, payload.patch, { mode: 0o600 });
			if (payload.patch.length === 0) {
				if ((plan.orderedPatches[index]?.changedPaths.length ?? 0) !== 0) {
					throw new IntegrationConflictResolutionError(`Empty patch payload claims changed paths: ${payload.taskId}`);
				}
				appliedTaskIds.push(payload.taskId);
				continue;
			}
			const applied = await this.#gitResult(workspacePath, ['apply', '--3way', '--index', '--', patchPath]);
			if (applied.exitCode !== 0) {
				const conflictPaths = nulList(await this.#git(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--'], false));
				return this.#record(evidencePath, {
					resolutionId, sourceAssemblyId: sourceAssembly.assemblyId, taskId: plan.taskId,
					baseCommit: plan.baseCommit, workspacePath, strategy: 'git_three_way', appliedTaskIds,
					changedPaths: await this.#changedPaths(workspacePath), conflictPaths, replayManifest, modelCalls: 0,
					workerAuthorized: false, status: 'blocked',
					reason: conflictPaths.length > 0 ? 'unresolved_conflict' : 'patch_rejected',
					failedTaskId: payload.taskId,
					detail: (applied.stderr || applied.stdout || 'Git could not resolve the prerequisite patch').slice(0, 10_000),
				});
			}
			appliedTaskIds.push(payload.taskId);
		}

		const changedPaths = await this.#changedPaths(workspacePath);
		const expectedPaths = plan.orderedPatches.flatMap(({ changedPaths }) => changedPaths);
		if (!samePaths(changedPaths, expectedPaths)) return this.#record(evidencePath, {
			resolutionId, sourceAssemblyId: sourceAssembly.assemblyId, taskId: plan.taskId,
			baseCommit: plan.baseCommit, workspacePath, strategy: 'git_three_way', appliedTaskIds,
			changedPaths, conflictPaths: [], replayManifest, modelCalls: 0, workerAuthorized: false, status: 'blocked',
			reason: 'changed_path_mismatch', detail: 'Resolved patch paths do not match the trusted assembly plan',
		});
		const head = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
		if (head !== plan.baseCommit) return this.#record(evidencePath, {
			resolutionId, sourceAssemblyId: sourceAssembly.assemblyId, taskId: plan.taskId,
			baseCommit: plan.baseCommit, workspacePath, strategy: 'git_three_way', appliedTaskIds,
			changedPaths, conflictPaths: [], replayManifest, modelCalls: 0, workerAuthorized: false, status: 'blocked',
			reason: 'head_moved', detail: 'Three-way resolution moved the workspace HEAD',
		});
		const combinedPatch = await this.#git(workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--'], false);
		return this.#record(evidencePath, {
			resolutionId, sourceAssemblyId: sourceAssembly.assemblyId, taskId: plan.taskId,
			baseCommit: plan.baseCommit, workspacePath, strategy: 'git_three_way', appliedTaskIds,
			changedPaths, conflictPaths: [], replayManifest, modelCalls: 0, workerAuthorized: false,
			status: 'resolved', patchSha256: digest(combinedPatch),
		});
	}

	async #changedPaths(workspacePath: string): Promise<string[]> {
		return nulList(await this.#git(workspacePath, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'], false));
	}

	async #record(evidencePath: string, input: unknown): Promise<IntegrationConflictResolutionResult> {
		const result = v.parse(IntegrationConflictResolutionResultSchema, input);
		await writeFile(resolve(evidencePath, 'resolution-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		return result;
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await this.#gitResult(cwd, args);
		if (result.exitCode !== 0) throw new IntegrationConflictResolutionError(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
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
			if (typeof failure.code !== 'number') throw new IntegrationConflictResolutionError(`Unable to run Git: ${failure.message}`);
			return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
		}
	}
}
