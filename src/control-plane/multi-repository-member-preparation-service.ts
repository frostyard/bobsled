import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { PreparationResultSchema } from './execution-contracts.ts';
import {
	IntegrationCommandContextSchema,
	runIntegrationCommand,
	type IntegrationCommandRunner,
} from './integration-command-service.ts';
import {
	MultiRepositoryMemberPreparationLeaseStore,
	MultiRepositoryMemberPreparationResultSchema,
	type MultiRepositoryMemberPreparationLease,
	type MultiRepositoryMemberPreparationResult,
} from './multi-repository-member-preparation-lease-store.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

export interface MultiRepositoryMemberPreparationServiceOptions {
	workspaceRoot?: string;
	repositorySourceRoot?: string;
	runner?: IntegrationCommandRunner;
	toolDataRoot?: string;
	executablePath?: string;
	now?: () => Date;
}

export class MultiRepositoryMemberPreparationServiceError extends Error {}

function nulList(value: string): string[] {
	return value.split('\0').filter(Boolean).map((entry) => entry.slice(3));
}

export class MultiRepositoryMemberPreparationService {
	readonly #workspaceRoot: string;
	readonly #repositorySourceRoot: string;
	readonly #runner: IntegrationCommandRunner;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;
	readonly #now: () => Date;

	constructor(
		private readonly store: MultiRepositoryMemberPreparationLeaseStore,
		options: MultiRepositoryMemberPreparationServiceOptions = {},
	) {
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#repositorySourceRoot = resolve(options.repositorySourceRoot
			?? process.env.BOBSLED_REPOSITORY_SOURCE_ROOT ?? resolve(this.#workspaceRoot, 'sources'));
		this.#runner = options.runner ?? runIntegrationCommand;
		this.#toolDataRoot = resolve(options.toolDataRoot ?? this.#workspaceRoot, 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#now = options.now ?? (() => new Date());
	}

	async run(leaseId: string, ownerId: string): Promise<MultiRepositoryMemberPreparationLease> {
		const claim = this.store.claimPreparation(leaseId, { id: ownerId });
		if (!claim.newlyClaimed) {
			if (claim.lease.status !== 'preparing' || this.#now().getTime() <= Date.parse(claim.lease.expiresAt)) return claim.lease;
			const root = resolve(this.#workspaceRoot, 'multi-repository-change-sets', claim.lease.changeSetId, 'members', claim.lease.id);
			return await this.#complete(claim.lease, this.#blocked(
				claim.lease, resolve(root, 'repo'), resolve(root, 'evidence'), ['preparation_ambiguous'],
				'Preparation recovery found an expired ambiguous command; retry is forbidden',
			));
		}
		const lease = claim.lease;
		const root = resolve(this.#workspaceRoot, 'multi-repository-change-sets', lease.changeSetId, 'members', lease.id);
		const workspacePath = resolve(root, 'repo');
		const evidencePath = resolve(root, 'evidence');
		try {
			return await this.#runClaimed(lease, workspacePath, evidencePath);
		} catch (error) {
			return this.store.completePreparation(lease.id, { id: ownerId }, this.#blocked(
				lease, workspacePath, evidencePath, ['inspection_failed'],
				error instanceof Error ? error.message : 'Member workspace preparation failed',
			));
		}
	}

	async #runClaimed(
		lease: MultiRepositoryMemberPreparationLease,
		workspacePath: string,
		evidencePath: string,
	): Promise<MultiRepositoryMemberPreparationLease> {
		if (await lstat(resolve(workspacePath, '..')).then(() => true, () => false)) {
			return this.#complete(lease, this.#blocked(lease, workspacePath, evidencePath, ['workspace_exists'], 'Member preparation workspace already exists'));
		}
		await mkdir(this.#workspaceRoot, { recursive: true, mode: 0o700 });
		const workspaceRoot = await realpath(this.#workspaceRoot);
		if (!workspacePath.startsWith(`${workspaceRoot}/`)) throw new MultiRepositoryMemberPreparationServiceError('Member workspace escapes the trusted workspace root');

		const sourceRoot = await realpath(this.#repositorySourceRoot).catch(() => undefined);
		const source = sourceRoot
			? await realpath(resolve(sourceRoot, ...lease.repositoryId.split('/'))).catch(() => undefined)
			: undefined;
		if (!sourceRoot || !source || !source.startsWith(`${sourceRoot}/`)) {
			return this.#complete(lease, this.#blocked(lease, workspacePath, evidencePath, ['source_unavailable'], 'Configured repository source is unavailable beneath the trusted source root'));
		}
		const topLevel = await this.#git(source, ['rev-parse', '--show-toplevel']).catch(() => '');
		if (!topLevel || await realpath(topLevel).catch(() => undefined) !== source) {
			return this.#complete(lease, this.#blocked(lease, workspacePath, evidencePath, ['source_not_root'], 'Configured repository source is not its Git worktree root'));
		}
		const baseCommit = await this.#git(source, ['rev-parse', '--verify', `${lease.policySnapshot.defaultBranch}^{commit}`]).catch(() => '');
		if (!/^[a-f0-9]{40}$/.test(baseCommit)) {
			return this.#complete(lease, this.#blocked(lease, workspacePath, evidencePath, ['workspace_creation_failed'], 'Default branch did not resolve to a canonical commit'));
		}

		await mkdir(evidencePath, { recursive: true, mode: 0o700 });
		const added = await this.#gitResult(source, ['worktree', 'add', '--detach', workspacePath, baseCommit]);
		if (added.exitCode !== 0) {
			return this.#complete(lease, this.#blocked(lease, workspacePath, evidencePath, ['workspace_creation_failed'], added.stderr || added.stdout || 'Git could not create the member worktree', { baseCommit }));
		}
		const policy = lease.policySnapshot.workspacePreparation;
		const remainingLeaseMs = Date.parse(lease.expiresAt) - this.#now().getTime();
		if (remainingLeaseMs <= 0) {
			return this.#complete(lease, this.#blocked(
				lease, workspacePath, evidencePath, ['preparation_failed'],
				'Preparation lease expired after workspace creation but before command execution', { baseCommit },
			));
		}
		const context = v.parse(IntegrationCommandContextSchema, {
			integrationAttemptId: lease.id, workspacePath,
			sandboxHomePath: resolve(workspacePath, '..', 'preparation-home'),
			toolDataPath: resolve(this.#toolDataRoot, lease.repositoryId.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath, repository: lease.policySnapshot,
		});
		const raw = await this.#runner(policy.command, context, Math.min(policy.timeoutMinutes * 60_000, remainingLeaseMs)).catch((error) => ({
			status: 'failed' as const, exitCode: null, durationMs: 0, stdout: '',
			stderr: error instanceof Error ? error.message : 'Preparation runner failed', truncated: false,
		}));
		const preparation = v.parse(PreparationResultSchema, {
			...raw, name: policy.name, command: policy.command, networkAccess: policy.networkAccess,
		});
		let headCommit: string | undefined;
		let changedPaths: string[] = [];
		try {
			headCommit = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
			changedPaths = nulList(await this.#git(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'], false));
		} catch (error) {
			return this.#complete(lease, this.#blocked(lease, workspacePath, evidencePath, ['inspection_failed'], error instanceof Error ? error.message : 'Prepared workspace could not be inspected', { baseCommit, preparation }));
		}
		const violations: MultiRepositoryMemberPreparationResult['violations'] = [];
		if (preparation.status !== 'passed') violations.push('preparation_failed');
		if (headCommit !== baseCommit) violations.push('head_moved');
		if (changedPaths.length > 0) violations.push('preparation_changed_workspace');
		const result = violations.length === 0
			? v.parse(MultiRepositoryMemberPreparationResultSchema, {
				leaseId: lease.id, repositoryId: lease.repositoryId, workspacePath, evidencePath,
				baseCommit, headCommit, preparation, changedPaths, status: 'passed', violations: [], detail: '',
				workspaceReady: true, modelDispatchAuthorized: false, executionAuthorized: false, publicationAuthorized: false,
			})
			: this.#blocked(lease, workspacePath, evidencePath, violations, 'Repository preparation did not preserve a clean workspace at its immutable base', {
				baseCommit, headCommit, preparation, changedPaths,
			});
		return this.#complete(lease, result);
	}

	async #complete(lease: MultiRepositoryMemberPreparationLease, result: MultiRepositoryMemberPreparationResult): Promise<MultiRepositoryMemberPreparationLease> {
		await mkdir(result.evidencePath, { recursive: true, mode: 0o700 });
		await writeFile(resolve(result.evidencePath, 'workspace-preparation.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		return this.store.completePreparation(lease.id, { id: lease.ownerId }, result);
	}

	#blocked(
		lease: MultiRepositoryMemberPreparationLease,
		workspacePath: string,
		evidencePath: string,
		violations: MultiRepositoryMemberPreparationResult['violations'],
		detail: string,
		partial: Partial<Pick<MultiRepositoryMemberPreparationResult, 'baseCommit' | 'headCommit' | 'preparation' | 'changedPaths'>> = {},
	): MultiRepositoryMemberPreparationResult {
		return v.parse(MultiRepositoryMemberPreparationResultSchema, {
			leaseId: lease.id, repositoryId: lease.repositoryId, workspacePath, evidencePath,
			baseCommit: partial.baseCommit, headCommit: partial.headCommit, preparation: partial.preparation,
			changedPaths: partial.changedPaths ?? [], status: 'blocked', violations, detail: detail.slice(0, 10_000),
			workspaceReady: false, modelDispatchAuthorized: false, executionAuthorized: false, publicationAuthorized: false,
		});
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await this.#gitResult(cwd, args);
		if (result.exitCode !== 0) throw new MultiRepositoryMemberPreparationServiceError(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
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
			if (typeof failure.code !== 'number') throw new MultiRepositoryMemberPreparationServiceError(`Unable to run Git: ${failure.message}`);
			return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
		}
	}
}
