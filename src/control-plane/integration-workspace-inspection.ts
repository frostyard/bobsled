import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
	IntegrationWorkerInspectionSchema,
	type IntegrationWorkerInspection,
} from './integration-worker-contracts.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export type IntegrationWorkerInspector = (workspacePath: string) => Promise<IntegrationWorkerInspection>;

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

function countDiffLines(numstat: string): number {
	let total = 0;
	for (const line of numstat.split('\n').filter(Boolean)) {
		const [added, deleted] = line.split('\t', 3);
		if (added !== '-' && deleted !== '-') total += Number(added) + Number(deleted);
	}
	return total;
}

export const inspectIntegrationWorkerWorkspace: IntegrationWorkerInspector = async (workspacePath) => {
	const root = await realpath(workspacePath);
	const topLevel = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
	if (topLevel !== root) throw new Error('Integration workspace must be the Git worktree root');
	const [headCommit, stagedPatch, untracked] = await Promise.all([
		git(root, ['rev-parse', 'HEAD']),
		git(root, ['diff', '--binary', '--no-ext-diff', '--no-renames', '--cached', 'HEAD', '--'], false),
		git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], false).then(nulList),
	]);
	if (untracked.length > 100) throw new Error('Integration worker produced more than 100 untracked paths');
	if (untracked.length > 0) await git(root, ['add', '-N', '--', ...untracked]);
	let finalPatch: string;
	let workerChangedPaths: string[];
	let finalChangedPaths: string[];
	let diffLines: number;
	try {
		[finalPatch, workerChangedPaths, finalChangedPaths, diffLines] = await Promise.all([
			git(root, ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--'], false),
			git(root, ['diff', '--name-only', '-z', '--no-renames', '--'], false).then(nulList),
			git(root, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'], false).then(nulList),
			git(root, ['diff', '--numstat', '--no-renames', 'HEAD', '--'], false).then(countDiffLines),
		]);
	} finally {
		if (untracked.length > 0) await git(root, ['reset', '--quiet', '--', ...untracked]);
	}
	const restoredStagedPatch = await git(root, ['diff', '--binary', '--no-ext-diff', '--no-renames', '--cached', 'HEAD', '--'], false);
	if (restoredStagedPatch !== stagedPatch) throw new Error('Trusted inspection failed to restore the staged prerequisite stack');
	return v.parse(IntegrationWorkerInspectionSchema, {
		headCommit,
		stagedPatchSha256: createHash('sha256').update(stagedPatch).digest('hex'),
		workerChangedPaths,
		finalChangedPaths,
		diffLines,
		finalPatchSha256: createHash('sha256').update(finalPatch).digest('hex'),
	});
};
