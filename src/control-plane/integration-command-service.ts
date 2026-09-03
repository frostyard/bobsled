import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { RepositoryContractSchema } from './contracts.ts';
import type { GateResult } from './execution-contracts.ts';

const MAX_OUTPUT_BYTES = 512 * 1024;

export const IntegrationCommandContextSchema = v.object({
	integrationAttemptId: v.pipe(v.string(), v.uuid()),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	sandboxHomePath: v.pipe(v.string(), v.minLength(1)),
	toolDataPath: v.pipe(v.string(), v.minLength(1)),
	executablePath: v.pipe(v.string(), v.minLength(1)),
	repository: RepositoryContractSchema,
});

export type IntegrationCommandContext = v.InferOutput<typeof IntegrationCommandContextSchema>;
export type IntegrationCommandRunner = (
	command: string,
	context: IntegrationCommandContext,
	timeoutMs: number,
) => Promise<Omit<GateResult, 'id' | 'name' | 'command'>>;

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
	if (state.bytes >= MAX_OUTPUT_BYTES) { state.truncated = true; return; }
	const remaining = MAX_OUTPUT_BYTES - state.bytes;
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += Math.min(chunk.byteLength, remaining);
	if (chunk.byteLength > remaining) state.truncated = true;
}

export const runIntegrationCommand: IntegrationCommandRunner = async (command, context, timeoutMs) => {
	await mkdir(resolve(context.sandboxHomePath, 'tmp'), { recursive: true, mode: 0o700 });
	const started = Date.now();
	return await new Promise((resolveResult, reject) => {
		const child = spawn('/bin/sh', ['-c', command], {
			cwd: context.workspacePath,
			env: {
				PATH: `${resolve(context.toolDataPath, 'shims')}:${context.executablePath}`,
				LANG: process.env.LANG ?? 'C.UTF-8', HOME: context.sandboxHomePath,
				TMPDIR: resolve(context.sandboxHomePath, 'tmp'), MISE_DATA_DIR: context.toolDataPath,
				MISE_CACHE_DIR: resolve(context.toolDataPath, 'cache'), CI: 'true', GIT_TERMINAL_PROMPT: '0',
			},
			stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
		});
		const stdout: Buffer[] = []; const stderr: Buffer[] = [];
		const stdoutState = { bytes: 0, truncated: false }; const stderrState = { bytes: 0, truncated: false };
		let timedOut = false;
		child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState));
		child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrState));
		child.once('error', reject);
		const terminate = (signal: NodeJS.Signals) => {
			try {
				if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal);
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
			}
		};
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			terminate('SIGTERM');
			killTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
		}, timeoutMs);
		child.once('close', (exitCode) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			resolveResult({
				status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed', exitCode,
				durationMs: Date.now() - started, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
				truncated: stdoutState.truncated || stderrState.truncated,
			});
		});
	});
};
