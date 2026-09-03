import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function conflictNonTargetStateSha256(workspacePath: string, conflictPaths: readonly string[]): Promise<string> {
	const exclusions = conflictPaths.map((path) => `:(exclude,top,literal)${path}`);
	const env = { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' };
	const [diff, untracked] = await Promise.all([
		execFileAsync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', '.', ...exclusions], {
			cwd: workspacePath, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8', env,
		}),
		execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...exclusions], {
			cwd: workspacePath, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8', env,
		}),
	]);
	return createHash('sha256').update(diff.stdout).update('\0').update(untracked.stdout).digest('hex');
}

export async function conflictTargetStateSha256(workspacePath: string, conflictPaths: readonly string[]): Promise<string> {
	const env = { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' };
	const diff = await execFileAsync('git', [
		'diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--',
		...conflictPaths.map((path) => `:(top,literal)${path}`),
	], { cwd: workspacePath, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8', env });
	return createHash('sha256').update(diff.stdout).digest('hex');
}
