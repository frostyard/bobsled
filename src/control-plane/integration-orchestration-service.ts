import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
	evaluateIntegrationWorker,
	IntegrationWorkerInitialDataSchema,
	IntegrationWorkerInspectionSchema,
	type IntegrationWorkerInspection,
} from './integration-worker-contracts.ts';
import {
	runIntegrationWorker,
	type IntegrationWorkerRunner,
} from './integration-worker-service.ts';
import { IntegrationGateService } from './integration-gate-service.ts';
import {
	IntegrationInvocationStore,
	type IntegrationInvocationLease,
} from './integration-invocation-store.ts';
import { IntegrationPreflightService } from './integration-preflight-service.ts';
import { IntegrationPreflightResultSchema } from './integration-preflight-contracts.ts';

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

export interface IntegrationOrchestrationOptions {
	preflight?: IntegrationPreflightService;
	gates?: IntegrationGateService;
	worker?: IntegrationWorkerRunner;
	inspector?: IntegrationWorkerInspector;
	toolDataRoot?: string;
	executablePath?: string;
	now?: () => Date;
}

export class IntegrationOrchestrationService {
	readonly #preflight: IntegrationPreflightService;
	readonly #gates: IntegrationGateService;
	readonly #worker: IntegrationWorkerRunner;
	readonly #inspector: IntegrationWorkerInspector;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;
	readonly #now: () => Date;

	constructor(private readonly store: IntegrationInvocationStore, options: IntegrationOrchestrationOptions = {}) {
		this.#preflight = options.preflight ?? new IntegrationPreflightService(store);
		this.#gates = options.gates ?? new IntegrationGateService(store);
		this.#worker = options.worker ?? runIntegrationWorker;
		this.#inspector = options.inspector ?? inspectIntegrationWorkerWorkspace;
		this.#toolDataRoot = resolve(options.toolDataRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces', 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#now = options.now ?? (() => new Date());
	}

	async execute(integrationAttemptId: string, ownerId: string): Promise<IntegrationInvocationLease> {
		const before = this.store.get(integrationAttemptId, ownerId);
		if (!before.preflight) {
			const parent = (() => {
				try { return this.store.getParentContext(integrationAttemptId, ownerId); } catch { return undefined; }
			})();
			if (parent) {
				const gateIds = new Set(parent.repository.qualityGates.map(({ id }) => id));
				const policyDenied = !parent.repository.capabilities.writeCode
					|| !parent.repository.executionPolicy.enabled
					|| parent.repository.executionPolicy.requiredGateIds.some((id) => !gateIds.has(id));
				if (policyDenied) {
					return this.store.recordPreflightAndClaim(integrationAttemptId, ownerId, v.parse(IntegrationPreflightResultSchema, {
						integrationAttemptId, status: 'blocked', violations: ['policy_denied'], workerAuthorized: false,
						detail: 'Repository policy does not permit a fully gated integration worker invocation',
					})).lease;
				}
			}
		}
		const claim = await this.#preflight.run(integrationAttemptId, ownerId);
		let lease = claim.lease;
		if (!claim.newlyClaimed) {
			if (lease.status === 'awaiting_gates' && lease.workerRun?.evidence.status === 'completed') {
				return this.#gates.run(integrationAttemptId, ownerId);
			}
			if (lease.status !== 'running') return lease;
			if (!lease.workerRun) {
				const parent = this.store.getParentContext(integrationAttemptId, ownerId);
				const startedAt = lease.startedAt ? Date.parse(lease.startedAt) : Number.NaN;
				const staleAfterMs = (parent.repository.executionPolicy.workerTimeoutMinutes + 1) * 60_000;
				if (!Number.isFinite(startedAt) || this.#now().getTime() - startedAt <= staleAfterMs) return lease;
				return this.store.fail(integrationAttemptId, ownerId,
					'Invocation recovery found an expired claimed worker call; retry is forbidden');
			}
			return lease;
		}
		if (lease.status !== 'running' || lease.workerCalls !== 1) return lease;

		let parent;
		try {
			parent = this.store.getParentContext(integrationAttemptId, ownerId);
		} catch (error) {
			return this.store.fail(integrationAttemptId, ownerId,
				(error instanceof Error ? error.message : 'Integration parent became unavailable').slice(0, 10_000));
		}
		const sandboxHomePath = resolve(parent.workspacePath, '..', 'worker-home');
		await mkdir(resolve(sandboxHomePath, 'tmp'), { recursive: true, mode: 0o700 });
		const initialData = v.parse(IntegrationWorkerInitialDataSchema, {
			integrationAttemptId,
			assemblyId: lease.assemblyId,
			workspacePath: parent.workspacePath,
			sandboxHomePath,
			toolDataPath: resolve(this.#toolDataRoot, parent.repository.id.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath,
			baseCommit: parent.baseCommit,
			assemblyPatchSha256: parent.assemblyPatchSha256,
			assemblyChangedPaths: parent.assemblyChangedPaths,
			plan: parent.plan,
			taskId: lease.taskId,
			repository: parent.repository,
			workItem: parent.workItem,
			maxWorkerCalls: 1,
		});
		let workerOutcome;
		try {
			workerOutcome = await this.#worker(initialData, parent.repository.executionPolicy.workerTimeoutMinutes * 60_000);
		} catch (error) {
			return this.store.fail(integrationAttemptId, ownerId,
				(error instanceof Error ? error.message : 'Integration worker failed').slice(0, 10_000));
		}
		let inspection;
		try {
			inspection = await this.#inspector(parent.workspacePath);
		} catch (error) {
			return this.store.fail(integrationAttemptId, ownerId,
				(error instanceof Error ? error.message : 'Integration postcondition inspection failed').slice(0, 10_000));
		}
		const disposition = evaluateIntegrationWorker(initialData, workerOutcome.result, inspection);
		lease = this.store.complete(integrationAttemptId, ownerId, workerOutcome, disposition);
		return lease.status === 'awaiting_gates' ? this.#gates.run(integrationAttemptId, ownerId) : lease;
	}
}
