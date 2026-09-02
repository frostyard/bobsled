import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { RepositoryContractSchema } from './contracts.ts';
import { GateResultSchema, type GateResult } from './execution-contracts.ts';
import { IntegrationInvocationStore, type IntegrationInvocationLease } from './integration-invocation-store.ts';

const MAX_OUTPUT_BYTES = 512 * 1024;

function failedEvidence(id: string, name: string, command: string, message: string): GateResult {
	return v.parse(GateResultSchema, {
		id, name, command, status: 'failed', exitCode: null, durationMs: 0,
		stdout: '', stderr: message.slice(0, MAX_OUTPUT_BYTES), truncated: message.length > MAX_OUTPUT_BYTES,
	});
}

const IntegrationGateContextSchema = v.object({
	integrationAttemptId: v.pipe(v.string(), v.uuid()),
	workspacePath: v.pipe(v.string(), v.minLength(1)),
	sandboxHomePath: v.pipe(v.string(), v.minLength(1)),
	toolDataPath: v.pipe(v.string(), v.minLength(1)),
	executablePath: v.pipe(v.string(), v.minLength(1)),
	repository: RepositoryContractSchema,
});

export type IntegrationGateContext = v.InferOutput<typeof IntegrationGateContextSchema>;
export type IntegrationGateCommandRunner = (command: string, context: IntegrationGateContext, timeoutMs: number) => Promise<Omit<GateResult, 'id' | 'name' | 'command'>>;

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
	if (state.bytes >= MAX_OUTPUT_BYTES) { state.truncated = true; return; }
	const remaining = MAX_OUTPUT_BYTES - state.bytes;
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += Math.min(chunk.byteLength, remaining);
	if (chunk.byteLength > remaining) state.truncated = true;
}

const runCommand: IntegrationGateCommandRunner = async (command, context, timeoutMs) => {
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

export class IntegrationGateService {
	readonly #store: IntegrationInvocationStore;
	readonly #runner: IntegrationGateCommandRunner;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;

	constructor(store: IntegrationInvocationStore, runner: IntegrationGateCommandRunner = runCommand, options: { toolDataRoot?: string; executablePath?: string } = {}) {
		this.#store = store;
		this.#runner = runner;
		this.#toolDataRoot = resolve(options.toolDataRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces', 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
	}

	async run(integrationAttemptId: string, ownerId: string): Promise<IntegrationInvocationLease> {
		const lease = this.#store.get(integrationAttemptId, ownerId);
		if (lease.status !== 'awaiting_gates') throw new Error('Integration invocation is not awaiting trusted gates');
		let parent;
		try {
			parent = this.#store.getParentContext(integrationAttemptId, ownerId);
		} catch (error) {
			return this.#store.settleGates(integrationAttemptId, ownerId, [failedEvidence(
				'policy', 'Integration gate parent', '[unavailable]',
				error instanceof Error ? error.message : 'Integration gate parent could not be loaded',
			)]);
		}
		const context = v.parse(IntegrationGateContextSchema, {
			integrationAttemptId, workspacePath: parent.workspacePath,
			sandboxHomePath: resolve(parent.workspacePath, '..', 'gate-home'),
			toolDataPath: resolve(this.#toolDataRoot, parent.repository.id.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath, repository: parent.repository,
		});
		const gateById = new Map(context.repository.qualityGates.map((gate) => [gate.id, gate]));
		const results: GateResult[] = [];
		for (const id of context.repository.executionPolicy.requiredGateIds) {
			const gate = gateById.get(id);
			if (!gate) {
				results.push(failedEvidence(id, 'Missing required gate', '[missing]', `Required integration gate is missing from the policy snapshot: ${id}`));
				break;
			}
			if (gate.mutatesWorkspace) {
				results.push(failedEvidence(gate.id, gate.name, gate.command,
					'Workspace-mutating integration gates are unsupported until trusted patch evidence is recomputed after gate execution'));
				break;
			}
			const result = await this.#runner(gate.command, context, context.repository.executionPolicy.gateTimeoutMinutes * 60_000).catch((error) => ({
				status: 'failed' as const, exitCode: null, durationMs: 0, stdout: '',
				stderr: (error instanceof Error ? error.message : 'Gate runner failed').slice(0, MAX_OUTPUT_BYTES), truncated: false,
			}));
			results.push(v.parse(GateResultSchema, { ...result, id: gate.id, name: gate.name, command: gate.command }));
			if (result.status !== 'passed') break;
		}
		if (results.length === 0) results.push(failedEvidence(
			'policy', 'Required gate policy', '[missing]', 'Integration policy must require at least one trusted gate',
		));
		return this.#store.settleGates(context.integrationAttemptId, ownerId, results);
	}
}
