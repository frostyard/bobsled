import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { DraftPatchEvidenceSchema, GateResultSchema } from './execution-contracts.ts';
import type { Principal } from './ledger.ts';
import {
	runIsolatedCompatibilityCommand,
	type MultiRepositoryCompatibilityCommandRunner,
} from './multi-repository-compatibility-command-service.ts';
import {
	MultiRepositoryCompatibilityExecutionStore,
	MultiRepositoryCompatibilityManifestSchema,
	type MultiRepositoryCompatibilityExecution,
	type MultiRepositoryCompatibilityManifest,
} from './multi-repository-compatibility-execution-store.ts';
import { MultiRepositoryVerificationPlanStore } from './multi-repository-verification-plan-store.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

interface PreparedCompatibilityContext {
	manifest: MultiRepositoryCompatibilityManifest;
	manifestPath: string;
	sandboxHomePath: string;
	toolDataPath: string;
	executablePath: string;
}

export interface MultiRepositoryCompatibilityExecutionServiceOptions {
	store?: MultiRepositoryCompatibilityExecutionStore;
	path?: string;
	workspaceRoot?: string;
	toolDataRoot?: string;
	executablePath?: string;
	runner?: MultiRepositoryCompatibilityCommandRunner;
}

export class MultiRepositoryCompatibilityExecutionService {
	readonly #store: MultiRepositoryCompatibilityExecutionStore;
	readonly #db: Database.Database;
	readonly #plans: MultiRepositoryVerificationPlanStore;
	readonly #workspaceRoot: string;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;
	readonly #runner: MultiRepositoryCompatibilityCommandRunner;

	constructor(options: MultiRepositoryCompatibilityExecutionServiceOptions = {}) {
		const path = options.path ?? dataPath('bobsled.db');
		this.#store = options.store ?? new MultiRepositoryCompatibilityExecutionStore(path);
		this.#db = new Database(path, { readonly: path !== ':memory:' });
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('busy_timeout = 5000');
		this.#plans = new MultiRepositoryVerificationPlanStore(path);
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#toolDataRoot = resolve(options.toolDataRoot ?? this.#workspaceRoot, 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#runner = options.runner ?? runIsolatedCompatibilityCommand;
	}

	close(): void { this.#plans.close(); this.#db.close(); this.#store.close(); }

	async run(id: string, ownerId: string): Promise<MultiRepositoryCompatibilityExecution> {
		const principal: Principal = { id: ownerId };
		let execution = this.#store.get(id, principal);
		if (['succeeded', 'blocked', 'failed', 'running'].includes(execution.status)) return execution;
		let context: PreparedCompatibilityContext;
		try {
			context = await this.#prepare(execution, principal);
			execution = this.#store.recordPreflight(id, context.manifest, principal);
		} catch (error) {
			execution = this.#store.get(id, principal);
			if (execution.status === 'prepared' && execution.manifest) context = await this.#context(execution);
			else throw error;
		}
		const claim = this.#store.claim(id, principal);
		if (!claim.newlyClaimed) return claim.execution;
		execution = claim.execution;
		const authorization = this.#store.authorization(id, principal);
		const gates = [];
		for (const [index, authorized] of authorization.gates.entries()) {
			this.#store.recordCommandStart(id, principal, index);
			let result: v.InferOutput<typeof GateResultSchema>;
			try {
				const value = await this.#runner(authorized.gate.command, {
					manifestPath: context.manifestPath, manifest: context.manifest,
					targetWorkspacePath: this.#member(context.manifest, authorized.repositoryId).workspacePath,
					sandboxHomePath: context.sandboxHomePath,
					toolDataPath: resolve(this.#toolDataRoot, authorized.repositoryId.replace('/', '__'), 'mise'),
					executablePath: context.executablePath,
				}, authorized.gate.timeoutMinutes * 60_000);
				result = v.parse(GateResultSchema, { id: authorized.gate.id, name: authorized.gate.name, command: authorized.gate.command, ...value });
			} catch (error) {
				result = v.parse(GateResultSchema, {
					id: authorized.gate.id, name: authorized.gate.name, command: authorized.gate.command,
					status: 'failed', exitCode: null, durationMs: 0, stdout: '',
					stderr: error instanceof Error ? error.message.slice(0, 4_000) : 'Compatibility gate runner failed', truncated: false,
				});
			}
			gates.push({ repositoryId: authorized.repositoryId, dependencyRepositoryId: authorized.dependencyRepositoryId, gateId: authorized.gate.id, result });
			const preserved = await this.#manifestStillAuthentic(context.manifest);
			if (!preserved || result.status !== 'passed') break;
		}
		const preserved = await this.#manifestStillAuthentic(context.manifest);
		const allPassed = preserved && gates.length === authorization.gates.length && gates.every(({ result }) => result.status === 'passed');
		const runnerFailed = gates.some(({ result }) => result.exitCode === null && result.status === 'failed');
		return this.#store.settle(id, {
			manifestSha256: execution.manifestSha256,
			gates,
			status: allPassed ? 'succeeded' : runnerFailed ? 'failed' : 'blocked',
			violations: preserved ? [] : ['member_workspace_changed'],
			reason: allPassed ? 'Every authorized cross-repository compatibility gate passed in the isolated peer workspace set.'
				: preserved ? 'Compatibility execution stopped at the first non-passing gate.' : 'A member workspace changed during compatibility execution.',
			workspaceMutationAuthorized: false, modelDispatchAuthorized: false, publicationAuthorized: false,
			rolloutAuthorized: false, mergeAuthorized: false,
		}, principal);
	}

	async #prepare(execution: MultiRepositoryCompatibilityExecution, principal: Principal): Promise<PreparedCompatibilityContext> {
		const authorization = this.#store.authorization(execution.id, principal);
		const plan = this.#plans.get(execution.verificationPlanId, principal);
		const expected = new Map(plan.result.members.map((member) => [member.repositoryId, member]));
		const repositoryIds = [...new Set(authorization.gates.flatMap((gate) => [gate.repositoryId, gate.dependencyRepositoryId]))].sort();
		const members = [];
		for (const repositoryId of repositoryIds) {
			const member = expected.get(repositoryId);
			if (!member) throw new Error(`Compatibility member is absent from the verified plan: ${repositoryId}`);
			const row = this.#db.prepare(`SELECT a.outcome_json, ar.uri, ar.digest
				FROM attempts a JOIN artifacts ar ON ar.attempt_id=a.id AND ar.job_id=a.job_id
				WHERE a.id=? AND a.job_id=? AND ar.kind=? ORDER BY ar.created_at DESC LIMIT 1`).get(
				member.attemptId, member.jobId, member.reviewStatus === 'approved' ? 'review_draft_patch' : 'draft_patch',
			) as { outcome_json: string | null; uri: string; digest: string | null } | undefined;
			if (!row?.outcome_json || row.digest !== member.patchSha256) throw new Error(`Compatibility member lacks its exact trusted patch artifact: ${repositoryId}`);
			const evidence = v.parse(DraftPatchEvidenceSchema, (JSON.parse(row.outcome_json) as { evidence?: unknown }).evidence);
			const workspacePath = await this.#trustedDirectory(evidence.workspacePath);
			const patchPath = await this.#artifactPath(row.uri);
			const patch = await readFile(patchPath);
			if (createHash('sha256').update(patch).digest('hex') !== member.patchSha256) throw new Error(`Compatibility patch bytes changed after verification: ${repositoryId}`);
			const head = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
			const livePatch = await this.#git(workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', evidence.baseCommit, '--'], false);
			const unmerged = await this.#git(workspacePath, ['diff', '--name-only', '--diff-filter=U', '--']);
			const untracked = await this.#git(workspacePath, ['ls-files', '--others', '--exclude-standard', '--']);
			if (head !== evidence.baseCommit || unmerged || untracked || createHash('sha256').update(livePatch).digest('hex') !== member.patchSha256) {
				throw new Error(`Compatibility member workspace no longer matches its verified patch: ${repositoryId}`);
			}
			members.push({ repositoryId, baseCommit: evidence.baseCommit, patchSha256: member.patchSha256, workspacePath });
		}
		const manifest = v.parse(MultiRepositoryCompatibilityManifestSchema, {
			version: 1, executionId: execution.id, members, workspaceMutationAuthorized: false, networkAccessAuthorized: false,
		});
		const root = resolve(this.#workspaceRoot, 'multi-repository-change-sets', execution.changeSetId, 'compatibility', execution.id);
		await mkdir(resolve(root, 'evidence'), { recursive: true, mode: 0o700 });
		await mkdir(resolve(root, 'home', 'tmp'), { recursive: true, mode: 0o700 });
		const manifestPath = resolve(root, 'evidence', 'manifest.json');
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
			if (error.code !== 'EEXIST' || await readFile(manifestPath, 'utf8') !== `${JSON.stringify(manifest, null, 2)}\n`) throw error;
		});
		return { manifest, manifestPath, sandboxHomePath: resolve(root, 'home'), toolDataPath: this.#toolDataRoot, executablePath: this.#executablePath };
	}

	async #context(execution: MultiRepositoryCompatibilityExecution): Promise<PreparedCompatibilityContext> {
		if (!execution.manifest) throw new Error('Prepared compatibility execution lacks its manifest');
		const root = resolve(this.#workspaceRoot, 'multi-repository-change-sets', execution.changeSetId, 'compatibility', execution.id);
		const manifestPath = resolve(root, 'evidence', 'manifest.json');
		const stored = v.parse(MultiRepositoryCompatibilityManifestSchema, JSON.parse(await readFile(await this.#trustedFile(manifestPath), 'utf8')));
		if (JSON.stringify(stored) !== JSON.stringify(execution.manifest)) throw new Error('Compatibility manifest file disagrees with durable evidence');
		return { manifest: stored, manifestPath, sandboxHomePath: resolve(root, 'home'), toolDataPath: this.#toolDataRoot, executablePath: this.#executablePath };
	}

	async #manifestStillAuthentic(manifest: MultiRepositoryCompatibilityManifest): Promise<boolean> {
		for (const member of manifest.members) {
			try {
				const head = await this.#git(member.workspacePath, ['rev-parse', 'HEAD']);
				const patch = await this.#git(member.workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', member.baseCommit, '--'], false);
				const unmerged = await this.#git(member.workspacePath, ['diff', '--name-only', '--diff-filter=U', '--']);
				const untracked = await this.#git(member.workspacePath, ['ls-files', '--others', '--exclude-standard', '--']);
				if (head !== member.baseCommit || unmerged || untracked || createHash('sha256').update(patch).digest('hex') !== member.patchSha256) return false;
			} catch { return false; }
		}
		return true;
	}

	#member(manifest: MultiRepositoryCompatibilityManifest, repositoryId: string) {
		const member = manifest.members.find((value) => value.repositoryId === repositoryId);
		if (!member) throw new Error(`Compatibility target is absent from the authenticated manifest: ${repositoryId}`);
		return member;
	}

	async #artifactPath(uri: string): Promise<string> {
		if (!uri.startsWith('workspace://')) throw new Error('Compatibility artifact URI is outside the workspace scheme');
		return this.#trustedFile(resolve(this.#workspaceRoot, uri.slice('workspace://'.length)));
	}
	async #trustedDirectory(path: string): Promise<string> {
		const root = await realpath(this.#workspaceRoot); const value = await realpath(resolve(path));
		if (!value.startsWith(`${root}/`)) throw new Error('Compatibility workspace escapes the trusted workspace root');
		const stat = await lstat(value); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Compatibility workspace is not a trusted directory');
		return value;
	}
	async #trustedFile(path: string): Promise<string> {
		const root = await realpath(this.#workspaceRoot); const value = await realpath(resolve(path));
		if (!value.startsWith(`${root}/`)) throw new Error('Compatibility evidence escapes the trusted workspace root');
		const stat = await lstat(value); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Compatibility evidence is not a trusted regular file');
		return value;
	}
	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, timeout: 60_000, env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: cwd, GIT_TERMINAL_PROMPT: '0' } });
		return trim ? stdout.trim() : stdout;
	}
}
