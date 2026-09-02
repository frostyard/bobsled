import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
	evaluateIntegrationPreflight,
	IntegrationPreflightResultSchema,
	type IntegrationPreflightResult,
	type IntegrationWorkspaceInspection,
} from './integration-preflight-contracts.ts';
import { IntegrationInvocationStore, type IntegrationInvocationLease } from './integration-invocation-store.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export type IntegrationWorkspaceInspector = (workspacePath: string) => Promise<IntegrationWorkspaceInspection>;

function nulList(value: string): string[] {
	return value.split('\0').filter(Boolean);
}

async function git(workspacePath: string, args: string[], trim = true): Promise<string> {
	const result = await execFileAsync('git', args, {
		cwd: workspacePath,
		timeout: 60_000,
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
		encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' },
	});
	return trim ? result.stdout.trim() : result.stdout;
}

export const inspectIntegrationWorkspace: IntegrationWorkspaceInspector = async (workspacePath) => {
	const root = await realpath(workspacePath);
	const topLevel = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
	if (topLevel !== root) throw new Error('Integration workspace must be the Git worktree root');
	const [headCommit, stagedPatch, trackedDirty, untracked] = await Promise.all([
		git(root, ['rev-parse', 'HEAD']),
		git(root, ['diff', '--binary', '--no-ext-diff', '--no-renames', '--cached', 'HEAD', '--'], false),
		git(root, ['diff', '--name-only', '-z', '--no-renames', '--'], false),
		git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], false),
	]);
	return {
		headCommit,
		stagedPatchSha256: createHash('sha256').update(stagedPatch).digest('hex'),
		dirtyPaths: [...new Set([...nulList(trackedDirty), ...nulList(untracked)])].sort(),
	};
};

export class IntegrationPreflightService {
	constructor(
		private readonly store: IntegrationInvocationStore,
		private readonly inspector: IntegrationWorkspaceInspector = inspectIntegrationWorkspace,
	) {}

	async run(integrationAttemptId: string, ownerId: string): Promise<IntegrationInvocationLease> {
		const lease = this.store.get(integrationAttemptId, ownerId);
		if (lease.preflight) return lease;
		if (lease.status !== 'reserved' || lease.workerCalls !== 0) throw new Error('Integration invocation is not awaiting clean-stack preflight');
		let parent;
		try {
			parent = this.store.getParentContext(integrationAttemptId, ownerId);
		} catch (error) {
			return this.store.recordPreflightAndClaim(integrationAttemptId, ownerId, v.parse(IntegrationPreflightResultSchema, {
				integrationAttemptId, status: 'blocked', violations: ['parent_unavailable'], workerAuthorized: false,
				detail: (error instanceof Error ? error.message : 'Integration parent could not be loaded').slice(0, 10_000),
			}));
		}
		let result: IntegrationPreflightResult;
		try {
			result = evaluateIntegrationPreflight(
				integrationAttemptId, parent.baseCommit, parent.assemblyPatchSha256,
				await this.inspector(parent.workspacePath),
			);
		} catch (error) {
			result = v.parse(IntegrationPreflightResultSchema, {
				integrationAttemptId, status: 'blocked', violations: ['inspection_failed'], workerAuthorized: false,
				detail: (error instanceof Error ? error.message : 'Integration workspace inspection failed').slice(0, 10_000),
			});
		}
		return this.store.recordPreflightAndClaim(integrationAttemptId, ownerId, result);
	}
}
