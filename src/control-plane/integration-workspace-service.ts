import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
	IntegrationAssemblyPlanSchema,
	type IntegrationAssemblyPlan,
} from './integration-assembly-contracts.ts';
import { WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_STACK_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const AssemblyIdSchema = v.pipe(v.string(), v.uuid());

export const IntegrationPatchPayloadSchema = v.object({
	taskId: WorkPlanTaskIdSchema,
	patchSha256: Sha256Schema,
	patch: v.pipe(v.string(), v.maxBytes(MAX_PATCH_BYTES)),
});

const IntegrationWorkspaceResultEntries = {
	assemblyId: AssemblyIdSchema,
	taskId: WorkPlanTaskIdSchema,
	baseCommit: v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	appliedTaskIds: v.pipe(v.array(WorkPlanTaskIdSchema), v.maxLength(31)),
	changedPaths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))), v.maxLength(100)),
	workerAuthorized: v.literal(false),
};

export const IntegrationWorkspaceResultSchema = v.variant('status', [
	v.object({
		...IntegrationWorkspaceResultEntries,
		status: v.literal('assembled'),
		patchSha256: Sha256Schema,
	}),
	v.object({
		...IntegrationWorkspaceResultEntries,
		status: v.literal('blocked'),
		reason: v.picklist(['patch_rejected', 'changed_path_mismatch', 'head_moved']),
		failedTaskId: v.optional(WorkPlanTaskIdSchema),
		detail: v.pipe(v.string(), v.maxLength(10_000)),
	}),
]);

export type IntegrationPatchPayload = v.InferOutput<typeof IntegrationPatchPayloadSchema>;
export type IntegrationWorkspaceResult = v.InferOutput<typeof IntegrationWorkspaceResultSchema>;

export class IntegrationWorkspaceError extends Error {}

export interface IntegrationWorkspaceServiceOptions {
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

function boundedDetail(value: string): string {
	return value.slice(0, 10_000);
}

export class IntegrationWorkspaceService {
	readonly #workspaceRoot: string;
	readonly #repositorySource: string;

	constructor(options: IntegrationWorkspaceServiceOptions) {
		this.#workspaceRoot = resolve(options.workspaceRoot);
		this.#repositorySource = resolve(options.repositorySource);
	}

	async assemble(
		inputAssemblyId: string,
		inputPlan: IntegrationAssemblyPlan,
		inputPayloads: readonly IntegrationPatchPayload[],
	): Promise<IntegrationWorkspaceResult> {
		const assemblyId = v.parse(AssemblyIdSchema, inputAssemblyId);
		const plan = v.parse(IntegrationAssemblyPlanSchema, inputPlan);
		if (!plan.ready) throw new IntegrationWorkspaceError('Blocked integration evidence cannot create a workspace');
		if (inputPayloads.length !== plan.orderedPatches.length) {
			throw new IntegrationWorkspaceError('Patch payload count does not match the ready assembly plan');
		}
		const payloads = inputPayloads.map((payload) => v.parse(IntegrationPatchPayloadSchema, payload));
		let stackBytes = 0;
		for (const [index, payload] of payloads.entries()) {
			const expected = plan.orderedPatches[index];
			if (!expected || payload.taskId !== expected.taskId || payload.patchSha256 !== expected.patchSha256) {
				throw new IntegrationWorkspaceError(`Patch payload does not match assembly order at index ${index}`);
			}
			stackBytes += Buffer.byteLength(payload.patch);
			if (digest(payload.patch) !== payload.patchSha256) {
				throw new IntegrationWorkspaceError(`Patch payload digest does not match trusted evidence: ${payload.taskId}`);
			}
		}
		if (stackBytes > MAX_STACK_BYTES) throw new IntegrationWorkspaceError('Patch stack exceeds the 2 MiB assembly limit');

		const source = await realpath(this.#repositorySource).catch(() => undefined);
		if (!source) throw new IntegrationWorkspaceError('Configured integration source is unavailable');
		const topLevel = await this.#git(source, ['rev-parse', '--show-toplevel']);
		if (await realpath(topLevel) !== source) throw new IntegrationWorkspaceError('Integration source must be the Git worktree root');
		const verifiedBase = await this.#git(source, ['rev-parse', '--verify', `${plan.baseCommit}^{commit}`]);
		if (verifiedBase !== plan.baseCommit) throw new IntegrationWorkspaceError('Integration base commit is not canonical for this repository');

		await mkdir(this.#workspaceRoot, { recursive: true, mode: 0o700 });
		const root = await realpath(this.#workspaceRoot);
		const assemblyRoot = resolve(root, 'integration-assemblies', assemblyId);
		const workspacePath = resolve(assemblyRoot, 'repo');
		const evidencePath = resolve(assemblyRoot, 'evidence');
		if (await lstat(assemblyRoot).then(() => true, () => false)) throw new IntegrationWorkspaceError('Integration assembly workspace already exists');
		await mkdir(evidencePath, { recursive: true, mode: 0o700 });
		await this.#git(source, ['worktree', 'add', '--detach', workspacePath, plan.baseCommit]);

		const appliedTaskIds: string[] = [];
		for (const [index, payload] of payloads.entries()) {
			const patchPath = resolve(evidencePath, `${String(index + 1).padStart(2, '0')}-${payload.taskId}.patch`);
			await writeFile(patchPath, payload.patch, { mode: 0o600 });
			if (payload.patch.length === 0) {
				if ((plan.orderedPatches[index]?.changedPaths.length ?? 0) !== 0) {
					throw new IntegrationWorkspaceError(`Empty patch payload claims changed paths: ${payload.taskId}`);
				}
				appliedTaskIds.push(payload.taskId);
				continue;
			}
			const checked = await this.#gitResult(workspacePath, ['apply', '--check', '--index', '--', patchPath]);
			if (checked.exitCode !== 0) {
				return await this.#record(evidencePath, {
					assemblyId, taskId: plan.taskId, baseCommit: plan.baseCommit, workspacePath,
					appliedTaskIds, changedPaths: await this.#changedPaths(workspacePath), workerAuthorized: false,
					status: 'blocked', reason: 'patch_rejected', failedTaskId: payload.taskId,
					detail: boundedDetail(checked.stderr || checked.stdout || 'Git rejected the prerequisite patch'),
				});
			}
			await this.#git(workspacePath, ['apply', '--index', '--', patchPath]);
			appliedTaskIds.push(payload.taskId);
		}

		const changedPaths = await this.#changedPaths(workspacePath);
		const expectedPaths = plan.orderedPatches.flatMap(({ changedPaths: paths }) => paths);
		if (!samePaths(changedPaths, expectedPaths)) {
			return await this.#record(evidencePath, {
				assemblyId, taskId: plan.taskId, baseCommit: plan.baseCommit, workspacePath,
				appliedTaskIds, changedPaths, workerAuthorized: false,
				status: 'blocked', reason: 'changed_path_mismatch',
				detail: 'Applied patch paths do not match the trusted assembly plan',
			});
		}
		const head = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
		if (head !== plan.baseCommit) {
			return await this.#record(evidencePath, {
				assemblyId, taskId: plan.taskId, baseCommit: plan.baseCommit, workspacePath,
				appliedTaskIds, changedPaths, workerAuthorized: false,
				status: 'blocked', reason: 'head_moved', detail: 'Patch assembly moved the workspace HEAD',
			});
		}
		const combinedPatch = await this.#git(workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--'], false);
		return await this.#record(evidencePath, {
			assemblyId, taskId: plan.taskId, baseCommit: plan.baseCommit, workspacePath,
			appliedTaskIds, changedPaths, workerAuthorized: false,
			status: 'assembled', patchSha256: digest(combinedPatch),
		});
	}

	async #changedPaths(workspacePath: string): Promise<string[]> {
		return nulList(await this.#git(workspacePath, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'], false));
	}

	async #record(evidencePath: string, input: unknown): Promise<IntegrationWorkspaceResult> {
		const result = v.parse(IntegrationWorkspaceResultSchema, input);
		await writeFile(resolve(evidencePath, 'assembly-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		return result;
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await this.#gitResult(cwd, args);
		if (result.exitCode !== 0) throw new IntegrationWorkspaceError(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
		return trim ? result.stdout.trim() : result.stdout;
	}

	async #gitResult(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const result = await execFileAsync('git', args, {
				cwd,
				timeout: 60_000,
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				encoding: 'utf8',
				env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' },
			});
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
		} catch (error) {
			const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
			if (typeof failure.code !== 'number') throw new IntegrationWorkspaceError(`Unable to run Git: ${failure.message}`);
			return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
		}
	}
}
