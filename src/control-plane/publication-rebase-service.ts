import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, type RepositoryContract } from './contracts.ts';
import { DraftPatchEvidenceSchema, GateResultSchema, PreparationResultSchema, type DraftPatchEvidence, type GateResult } from './execution-contracts.ts';
import { githubInstallationAuthority, type GitHubInstallationAuthority } from './github-installation.ts';
import { runIntegrationCommand, type IntegrationCommandRunner } from './integration-command-service.ts';
import { jobLedger, type JobLedger, type Principal } from './ledger.ts';
import {
	PublicationRebaseRecordSchema,
	PublicationRebaseRequestSchema,
	type PublicationRebaseBlockReason,
	type PublicationRebaseRecord,
} from './publication-rebase-contracts.ts';
import { ensurePublicationRebaseSchema } from './publication-rebase-schema.ts';
import { getRepository } from './repositories.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

export class PublicationRebaseConflictError extends Error {}
export class PublicationRebaseForbiddenError extends Error {}
export class PublicationRebaseNotFoundError extends Error {}

interface RebaseRow {
	id: string; owner_id: string; idempotency_key: string; request_sha256: string; source_publication_id: string;
	repository_id: string; status: PublicationRebaseRecord['status']; old_base_commit: string; new_base_commit: string | null;
	approved_patch_sha256: string; replayed_patch_sha256: string | null; source_changed_paths_json: string;
	replayed_changed_paths_json: string; conflict_paths_json: string; workspace_path: string | null; preparation_json: string | null; gates_json: string;
	block_reason: PublicationRebaseBlockReason | null; detail: string | null; reason: string; lease_expires_at: string | null;
	created_at: string; updated_at: string;
}

interface SourcePublicationRow {
	id: string; owner_id: string; run_id: string; run_version: number; job_id: string; attempt_id: string; review_id: string;
	repository_id: string; status: string; base_commit: string; approved_patch_sha256: string; blocked_reason: string | null;
	commit_sha: string | null; pull_number: number | null;
}

export interface PublicationRebaseSourceContext {
	sourcePublicationId: string;
	repository: RepositoryContract;
	evidence: DraftPatchEvidence;
	oldBaseCommit: string;
	approvedPatchSha256: string;
}

interface SourceSnapshot {
	patch: string;
	patchSha256: string;
	changedPaths: string[];
}

export interface PublicationRebaseServiceOptions {
	path?: string;
	ledger?: JobLedger;
	authority?: GitHubInstallationAuthority;
	repository?: (id: string) => RepositoryContract | undefined;
	workspaceRoot?: string;
	repositorySourceRoot?: string;
	executablePath?: string;
	runner?: IntegrationCommandRunner;
	sourceResolver?: (sourcePublicationId: string, principal: Principal) => PublicationRebaseSourceContext;
	remoteBaseResolver?: (repository: RepositoryContract) => Promise<string>;
	now?: () => Date;
}

const GitRefSchema = v.object({ object: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) }) });

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function json(value: unknown): string { return JSON.stringify(canonical(value)); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function paths(value: string): string[] { return value.split('\0').filter(Boolean); }
function samePaths(left: readonly string[], right: readonly string[]): boolean { return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0'); }

function matchesProtectedPath(path: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) { const prefix = pattern.slice(0, -3); return path === prefix || path.startsWith(`${prefix}/`); }
	return path === pattern;
}

function rowToRecord(row: RebaseRow): PublicationRebaseRecord {
	return v.parse(PublicationRebaseRecordSchema, {
		id: row.id, ownerId: row.owner_id, sourcePublicationId: row.source_publication_id,
		repositoryId: row.repository_id, status: row.status, oldBaseCommit: row.old_base_commit,
		newBaseCommit: row.new_base_commit ?? undefined, approvedPatchSha256: row.approved_patch_sha256,
		replayedPatchSha256: row.replayed_patch_sha256 ?? undefined,
		sourceChangedPaths: JSON.parse(row.source_changed_paths_json), replayedChangedPaths: JSON.parse(row.replayed_changed_paths_json),
		conflictPaths: JSON.parse(row.conflict_paths_json),
		workspacePath: row.workspace_path ?? undefined, preparation: row.preparation_json ? JSON.parse(row.preparation_json) : undefined,
		gates: JSON.parse(row.gates_json), blockReason: row.block_reason ?? undefined, detail: row.detail ?? undefined,
		modelCalls: 0, reviewRequired: true, reviewAuthorized: false, publicationAuthorized: false,
		reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
	});
}

export class PublicationRebaseService {
	readonly #db: Database.Database;
	readonly #ledger: JobLedger;
	readonly #authority: GitHubInstallationAuthority;
	readonly #repository: (id: string) => RepositoryContract | undefined;
	readonly #workspaceRoot: string;
	readonly #repositorySourceRoot: string;
	readonly #executablePath: string;
	readonly #runner: IntegrationCommandRunner;
	readonly #resolveSource: (sourcePublicationId: string, principal: Principal) => PublicationRebaseSourceContext;
	readonly #resolveRemoteBase: (repository: RepositoryContract) => Promise<string>;
	readonly #now: () => Date;

	constructor(options: PublicationRebaseServiceOptions = {}) {
		const databasePath = options.path ?? dataPath('bobsled.db');
		if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
		this.#db = new Database(databasePath); if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#ledger = options.ledger ?? jobLedger;
		this.#authority = options.authority ?? githubInstallationAuthority;
		this.#repository = options.repository ?? getRepository;
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#repositorySourceRoot = resolve(options.repositorySourceRoot ?? process.env.BOBSLED_REPOSITORY_SOURCE_ROOT ?? resolve(this.#workspaceRoot, 'sources'));
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#runner = options.runner ?? runIntegrationCommand;
		this.#resolveSource = options.sourceResolver ?? ((sourcePublicationId, principal) => this.#sourceContext(sourcePublicationId, principal));
		this.#resolveRemoteBase = options.remoteBaseResolver ?? ((repository) => this.#authority.withRequest(repository.id, 'repository_contents_read', async (authority) => {
			const response = await authority.request(`/repos/${repository.id}/git/ref/heads/${encodeURIComponent(repository.defaultBranch)}`, { method: 'GET' });
			if (!response.ok) throw new Error(`GitHub default-branch lookup failed with HTTP ${response.status}`);
			return v.parse(GitRefSchema, await response.json()).object.sha;
		}));
		this.#now = options.now ?? (() => new Date());
		this.#migrate();
	}

	close(): void { this.#db.close(); }

	admit(input: unknown, principal: Principal, idempotencyKey: string): PublicationRebaseRecord {
		const request = v.parse(PublicationRebaseRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new PublicationRebaseConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(json(request));
		const existing = this.#db.prepare('SELECT * FROM publication_rebases WHERE owner_id = ? AND idempotency_key = ?').get(principal.id, idempotencyKey) as RebaseRow | undefined;
		if (existing) {
			if (existing.request_sha256 !== requestSha256) throw new PublicationRebaseConflictError('Idempotency key was already used for different input');
			return rowToRecord(existing);
		}
		const context = this.#resolveSource(request.sourcePublicationId, principal);
		if (context.sourcePublicationId !== request.sourcePublicationId) throw new PublicationRebaseConflictError('Resolved source publication identity does not match the request');
		this.#validateSourceContext(context);
		const current = this.#repository(context.repository.id);
		if (!current?.executionPolicy.enabled || !current.reviewPolicy.enabled || !current.publicationPolicy.enabled
			|| !current.capabilities.writeCode || !current.capabilities.writeGitHub || current.readOnly) {
			throw new PublicationRebaseConflictError('Current repository policy does not permit stale-base replay, fresh review, and eventual draft publication');
		}
		const occupied = this.#db.prepare("SELECT status FROM publication_rebases WHERE source_publication_id = ? AND status IN ('pending','running','validated') LIMIT 1").get(request.sourcePublicationId) as { status: string } | undefined;
		if (occupied) throw new PublicationRebaseConflictError('This source publication already has an active or validated replay');
		const id = randomUUID(); const now = this.#now().toISOString();
		try { this.#db.prepare(`INSERT INTO publication_rebases
			(id, owner_id, idempotency_key, request_sha256, source_publication_id, repository_id, status,
			 old_base_commit, approved_patch_sha256, source_changed_paths_json, replayed_changed_paths_json, conflict_paths_json,
			 gates_json, reason, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, '[]', '[]', '[]', ?, ?, ?)`).run(
			id, principal.id, idempotencyKey, requestSha256, request.sourcePublicationId, context.repository.id,
			context.oldBaseCommit, context.approvedPatchSha256, json(context.evidence.changedPaths), request.reason, now, now,
		); } catch (error) {
			if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new PublicationRebaseConflictError('This source publication already has an active or validated replay');
			throw error;
		}
		return this.get(id, principal);
	}

	list(principal: Principal): PublicationRebaseRecord[] {
		return (this.#db.prepare('SELECT * FROM publication_rebases WHERE owner_id = ? ORDER BY created_at DESC').all(principal.id) as RebaseRow[]).map(rowToRecord);
	}

	get(id: string, principal: Principal): PublicationRebaseRecord {
		const row = this.#db.prepare('SELECT * FROM publication_rebases WHERE id = ?').get(id) as RebaseRow | undefined;
		if (!row) throw new PublicationRebaseNotFoundError('Publication rebase not found');
		if (row.owner_id !== principal.id) throw new PublicationRebaseForbiddenError('Publication rebase belongs to another principal');
		return rowToRecord(row);
	}

	async execute(id: string, principal: Principal): Promise<PublicationRebaseRecord> {
		const record = this.get(id, principal);
		if (record.status === 'validated' || record.status === 'blocked') return record;
		const now = this.#now();
		if (record.status === 'running') {
			const row = this.#db.prepare('SELECT lease_expires_at FROM publication_rebases WHERE id = ?').get(id) as { lease_expires_at: string | null };
			if (!row.lease_expires_at || row.lease_expires_at > now.toISOString()) throw new PublicationRebaseConflictError('Publication rebase is already running');
			return this.#block(id, principal, 'unexpected_failure', 'The prior zero-model replay attempt expired; create a superseding attempt.');
		}
		const claimed = this.#db.prepare(`UPDATE publication_rebases SET status = 'running', lease_expires_at = ?, updated_at = ?
			WHERE id = ? AND owner_id = ? AND status = 'pending'`).run(new Date(now.getTime() + this.#leaseMs(record.repositoryId)).toISOString(), now.toISOString(), id, principal.id);
		if (claimed.changes !== 1) throw new PublicationRebaseConflictError('Publication rebase could not be claimed');
		try { return await this.#executeClaimed(id, principal); }
		catch (error) { return this.#block(id, principal, 'unexpected_failure', error instanceof Error ? error.message : 'Publication rebase failed'); }
	}

	async #executeClaimed(id: string, principal: Principal): Promise<PublicationRebaseRecord> {
		const record = this.get(id, principal);
		let context: PublicationRebaseSourceContext;
		try { context = this.#resolveSource(record.sourcePublicationId, principal); }
		catch (error) { return this.#block(id, principal, 'source_evidence_changed', error instanceof Error ? error.message : 'Source publication evidence changed'); }
		try { this.#validateSourceContext(context); }
		catch (error) { return this.#block(id, principal, 'source_evidence_changed', error instanceof Error ? error.message : 'Source publication evidence changed'); }
		if (context.sourcePublicationId !== record.sourcePublicationId || context.repository.id !== record.repositoryId || context.oldBaseCommit !== record.oldBaseCommit || context.approvedPatchSha256 !== record.approvedPatchSha256 || !samePaths(context.evidence.changedPaths, record.sourceChangedPaths)) {
			return this.#block(id, principal, 'source_evidence_changed', 'Source publication evidence no longer matches the admitted replay');
		}
		const snapshot = await this.#sourceSnapshot(context);
		if (snapshot.patchSha256 !== record.approvedPatchSha256 || !samePaths(snapshot.changedPaths, record.sourceChangedPaths)) {
			return this.#block(id, principal, 'source_evidence_changed', 'Approved patch bytes or paths no longer match their durable digest');
		}
		const remoteBase = v.parse(GitRefSchema.entries.object.entries.sha, await this.#resolveRemoteBase(context.repository));
		if (remoteBase === record.oldBaseCommit) return this.#block(id, principal, 'remote_base_unchanged', 'Remote default branch has not advanced beyond the approved base');

		const source = await this.#sourceCheckout(record.repositoryId);
		const localBase = await this.#git(source, ['rev-parse', '--verify', `${context.repository.defaultBranch}^{commit}`]);
		if (localBase !== remoteBase) return this.#block(id, principal, 'local_source_stale', 'Trusted source checkout does not contain the current remote default-branch commit');
		const descendant = await this.#gitResult(source, ['merge-base', '--is-ancestor', record.oldBaseCommit, remoteBase]);
		if (descendant.exitCode !== 0) return this.#block(id, principal, 'base_not_descendant', 'Current default branch is not a descendant of the approved base');

		const rebaseRoot = resolve(this.#workspaceRoot, 'publication-rebases', id);
		const workspacePath = resolve(rebaseRoot, 'repo');
		const evidencePath = resolve(rebaseRoot, 'evidence');
		const sandboxHomePath = resolve(rebaseRoot, 'home');
		const toolDataPath = resolve(this.#workspaceRoot, 'tool-cache', record.repositoryId.replace('/', '__'), 'mise');
		if (await lstat(rebaseRoot).then(() => true, () => false)) return this.#block(id, principal, 'source_evidence_changed', 'Publication rebase workspace already exists');
		await mkdir(evidencePath, { recursive: true, mode: 0o700 });
		await this.#git(source, ['worktree', 'add', '--detach', workspacePath, remoteBase]);
		const runnerContext = { integrationAttemptId: id, workspacePath, sandboxHomePath, toolDataPath, executablePath: this.#executablePath, repository: context.repository };
		let preparationRaw;
		try { preparationRaw = await this.#runner(context.repository.workspacePreparation.command, runnerContext, context.repository.workspacePreparation.timeoutMinutes * 60_000); }
		catch (error) { return this.#block(id, principal, 'preparation_failed', error instanceof Error ? error.message : 'Repository preparation runner failed', { newBaseCommit: remoteBase, workspacePath }); }
		const preparation = v.parse(PreparationResultSchema, { ...preparationRaw, name: context.repository.workspacePreparation.name, command: context.repository.workspacePreparation.command, networkAccess: context.repository.workspacePreparation.networkAccess });
		if (preparation.status !== 'passed') return this.#block(id, principal, 'preparation_failed', 'Repository preparation did not pass', { newBaseCommit: remoteBase, workspacePath, preparation });
		const preparedHead = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
		const preparedStatus = await this.#git(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false);
		if (preparedHead !== remoteBase || preparedStatus.length > 0) return this.#block(id, principal, 'preparation_changed_workspace', 'Repository preparation changed the tracked or untracked workspace', { newBaseCommit: remoteBase, workspacePath, preparation });

		const patchPath = resolve(evidencePath, 'approved.patch');
		await writeFile(patchPath, snapshot.patch, { mode: 0o600 });
		const applied = await this.#gitResult(workspacePath, ['apply', '--3way', '--index', '--', patchPath]);
		const unmerged = paths(await this.#git(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z', '--'], false));
		if (applied.exitCode !== 0) return this.#block(id, principal, 'patch_conflict', 'Exact approved patch did not apply cleanly to the current base', { newBaseCommit: remoteBase, workspacePath, preparation, conflictPaths: unmerged });
		if (unmerged.length > 0) return this.#block(id, principal, 'patch_conflict', `Exact approved patch left conflicts: ${unmerged.join(', ')}`, { newBaseCommit: remoteBase, workspacePath, preparation, conflictPaths: unmerged });
		const replayedPaths = paths(await this.#git(workspacePath, ['diff', '--name-only', '-z', '--no-renames', remoteBase, '--'], false));
		if (!samePaths(replayedPaths, record.sourceChangedPaths)) return this.#block(id, principal, 'changed_paths_mismatch', 'Replayed paths do not match the approved patch paths', { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths });
		const protectedPaths = replayedPaths.filter((path) => context.repository.protectedBoundaries.some((boundary) => boundary.paths.some((pattern) => matchesProtectedPath(path, pattern))));
		if (protectedPaths.length > 0) return this.#block(id, principal, 'protected_path', `Current policy protects replayed paths: ${protectedPaths.join(', ')}`, { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths });
		const diffLines = await this.#diffLines(workspacePath, remoteBase);
		if (replayedPaths.length > context.repository.executionPolicy.maxFiles || diffLines > context.repository.executionPolicy.maxDiffLines) return this.#block(id, principal, 'policy_limit', 'Replayed patch exceeds current repository size limits', { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths });
		const beforeGates = await this.#git(workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', remoteBase, '--'], false);
		const beforeDigest = digest(beforeGates);
		const gates: GateResult[] = [];
		const gatesById = new Map(context.repository.qualityGates.map((gate) => [gate.id, gate]));
		for (const gateId of context.repository.executionPolicy.requiredGateIds) {
			const gate = gatesById.get(gateId);
			if (!gate) return this.#block(id, principal, 'gate_failed', `Required gate is missing from current policy: ${gateId}`, { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths, replayedPatchSha256: beforeDigest, gates });
			let result;
			try { result = await this.#runner(gate.command, runnerContext, context.repository.executionPolicy.gateTimeoutMinutes * 60_000); }
			catch (error) { return this.#block(id, principal, 'gate_failed', error instanceof Error ? error.message : `Required gate runner failed: ${gate.id}`, { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths, replayedPatchSha256: beforeDigest, gates }); }
			gates.push(v.parse(GateResultSchema, { ...result, id: gate.id, name: gate.name, command: gate.command }));
			if (result.status !== 'passed') return this.#block(id, principal, 'gate_failed', `Required gate did not pass: ${gate.id}`, { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths, replayedPatchSha256: beforeDigest, gates });
		}
		if (gates.length === 0) return this.#block(id, principal, 'gate_failed', 'Current policy has no required trusted gates', { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths, replayedPatchSha256: beforeDigest, gates });
		const finalHead = await this.#git(workspacePath, ['rev-parse', 'HEAD']);
		if (finalHead !== remoteBase) return this.#block(id, principal, 'head_moved', 'A trusted gate moved the replay workspace HEAD', { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: replayedPaths, replayedPatchSha256: beforeDigest, gates });
		const afterPaths = paths(await this.#git(workspacePath, ['diff', '--name-only', '-z', '--no-renames', remoteBase, '--'], false));
		const afterPatch = await this.#git(workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', remoteBase, '--'], false);
		const afterUntracked = paths(await this.#git(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z'], false));
		if (!samePaths(afterPaths, replayedPaths) || digest(afterPatch) !== beforeDigest || afterUntracked.length > 0) return this.#block(id, principal, 'post_gate_changed', 'Trusted gates changed the replayed patch or created untracked files', { newBaseCommit: remoteBase, workspacePath, preparation, replayedChangedPaths: afterPaths, replayedPatchSha256: digest(afterPatch), gates });
		const settled = this.#db.prepare(`UPDATE publication_rebases SET status = 'validated', new_base_commit = ?, replayed_patch_sha256 = ?,
			replayed_changed_paths_json = ?, conflict_paths_json = '[]', workspace_path = ?, preparation_json = ?, gates_json = ?, block_reason = NULL,
			detail = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'running'`).run(
			remoteBase, beforeDigest, json(replayedPaths), workspacePath, json(preparation), json(gates), this.#now().toISOString(), id, principal.id,
		);
		if (settled.changes !== 1) throw new PublicationRebaseConflictError('Publication rebase was settled concurrently');
		return this.get(id, principal);
	}

	#leaseMs(repositoryId: string): number {
		const repository = this.#repository(repositoryId);
		if (!repository) return 65 * 60_000;
		return (repository.workspacePreparation.timeoutMinutes
			+ repository.executionPolicy.gateTimeoutMinutes * Math.max(1, repository.executionPolicy.requiredGateIds.length)
			+ 5) * 60_000;
	}

	#sourceContext(sourcePublicationId: string, principal: Principal): PublicationRebaseSourceContext {
		const row = this.#db.prepare('SELECT id, owner_id, run_id, run_version, job_id, attempt_id, review_id, repository_id, status, base_commit, approved_patch_sha256, blocked_reason, commit_sha, pull_number FROM draft_publications WHERE id = ?').get(sourcePublicationId) as SourcePublicationRow | undefined;
		if (!row) throw new PublicationRebaseNotFoundError('Source publication not found');
		if (row.owner_id !== principal.id) throw new PublicationRebaseForbiddenError('Source publication belongs to another principal');
		const repository = this.#repository(row.repository_id);
		if (!repository) throw new PublicationRebaseConflictError('Source repository is no longer enrolled');
		const expectedReason = `Remote ${repository.defaultBranch} moved beyond the approved base commit`;
		if (row.status !== 'blocked' || row.blocked_reason !== expectedReason || row.commit_sha !== null || row.pull_number !== null) throw new PublicationRebaseConflictError('Only a side-effect-free stale-base publication can be replayed');
		const run = this.#ledger.get(row.run_id, principal);
		if (run.version !== row.run_version) throw new PublicationRebaseConflictError('Source run version no longer matches publication evidence');
		const job = run.jobs.find(({ id }) => id === row.job_id);
		const attempt = job?.attempts.find(({ id }) => id === row.attempt_id);
		const review = job?.reviews.find(({ id, status }) => id === row.review_id && status === 'approved');
		if (!job || job.status !== 'succeeded' || !attempt || attempt.status !== 'succeeded' || !review || review.status !== 'approved') throw new PublicationRebaseConflictError('Source publication lineage is no longer approved');
		const evidence = v.parse(DraftPatchEvidenceSchema, (review.outcome as { evidence?: unknown } | undefined)?.evidence);
		const artifact = job.artifacts.find((item) => item.kind === 'review_draft_patch' && item.attemptId === attempt.id && item.metadata.reviewId === review.id);
		if (!artifact?.digest || artifact.digest !== evidence.diffSha256 || evidence.baseCommit !== row.base_commit || evidence.diffSha256 !== row.approved_patch_sha256) throw new PublicationRebaseConflictError('Source publication patch evidence is inconsistent');
		const snapshot = v.parse(RepositoryContractSchema, job.policySnapshot);
		if (snapshot.id !== repository.id) throw new PublicationRebaseConflictError('Source publication repository snapshot is inconsistent');
		return { sourcePublicationId: row.id, repository, evidence, oldBaseCommit: row.base_commit, approvedPatchSha256: row.approved_patch_sha256 };
	}

	async #sourceSnapshot(context: PublicationRebaseSourceContext): Promise<SourceSnapshot> {
		const workspace = resolve(context.evidence.workspacePath);
		if (await realpath(workspace).catch(() => undefined) !== workspace) throw new PublicationRebaseConflictError('Approved review workspace is unavailable');
		const head = await this.#git(workspace, ['rev-parse', 'HEAD']);
		if (head !== context.oldBaseCommit) throw new PublicationRebaseConflictError('Approved review workspace HEAD changed');
		const untracked = paths(await this.#git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], false));
		if (untracked.length > 0) throw new PublicationRebaseConflictError('Approved review workspace contains unreviewed files');
		const patch = await this.#git(workspace, ['diff', '--binary', '--no-ext-diff', '--no-renames', context.oldBaseCommit, '--'], false);
		return { patch, patchSha256: digest(patch), changedPaths: paths(await this.#git(workspace, ['diff', '--name-only', '-z', '--no-renames', context.oldBaseCommit, '--'], false)) };
	}

	#validateSourceContext(context: PublicationRebaseSourceContext): void {
		if (context.evidence.baseCommit !== context.oldBaseCommit || context.evidence.headCommit !== context.oldBaseCommit || context.evidence.headMoved
			|| context.evidence.diffSha256 !== context.approvedPatchSha256 || context.evidence.changedPaths.length === 0
			|| context.evidence.policyViolations.length > 0 || context.evidence.gates.length === 0 || context.evidence.gates.some(({ status }) => status !== 'passed')) {
			throw new PublicationRebaseConflictError('Source publication evidence is not an approved, unchanged, gated patch');
		}
	}

	async #sourceCheckout(repositoryId: string): Promise<string> {
		const root = await realpath(this.#repositorySourceRoot).catch(() => undefined);
		const configured = resolve(this.#repositorySourceRoot, ...repositoryId.split('/'));
		const source = await realpath(configured).catch(() => undefined);
		if (!root || !source || !source.startsWith(`${root}/`)) throw new PublicationRebaseConflictError('Trusted repository source is unavailable or escapes its root');
		if (await realpath(await this.#git(source, ['rev-parse', '--show-toplevel'])) !== source) throw new PublicationRebaseConflictError('Trusted repository source must be the Git worktree root');
		return source;
	}

	async #diffLines(workspacePath: string, base: string): Promise<number> {
		const numstat = await this.#git(workspacePath, ['diff', '--numstat', '--no-renames', base, '--']);
		return numstat.split('\n').filter(Boolean).reduce((sum, line) => {
			const [added, deleted] = line.split('\t', 3);
			return added === '-' || deleted === '-' ? sum : sum + Number(added) + Number(deleted);
		}, 0);
	}

	#block(id: string, principal: Principal, blockReason: PublicationRebaseBlockReason, detail: string, partial: Partial<PublicationRebaseRecord> = {}): PublicationRebaseRecord {
		this.#db.prepare(`UPDATE publication_rebases SET status = 'blocked', new_base_commit = COALESCE(?, new_base_commit),
			replayed_patch_sha256 = COALESCE(?, replayed_patch_sha256), replayed_changed_paths_json = ?, conflict_paths_json = ?, workspace_path = COALESCE(?, workspace_path),
			preparation_json = COALESCE(?, preparation_json), gates_json = ?, block_reason = ?, detail = ?, lease_expires_at = NULL, updated_at = ?
			WHERE id = ? AND owner_id = ?`).run(
			partial.newBaseCommit ?? null, partial.replayedPatchSha256 ?? null, json(partial.replayedChangedPaths ?? []), json(partial.conflictPaths ?? []), partial.workspacePath ?? null,
			partial.preparation ? json(partial.preparation) : null, json(partial.gates ?? []), blockReason, detail.slice(0, 10_000), this.#now().toISOString(), id, principal.id,
		);
		return this.get(id, principal);
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		const result = await this.#gitResult(cwd, args);
		if (result.exitCode !== 0) throw new PublicationRebaseConflictError(`Git command failed: git ${args.join(' ')}\n${result.stderr.trim()}`);
		return trim ? result.stdout.trim() : result.stdout;
	}

	async #gitResult(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const result = await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' } });
			return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
		} catch (error) {
			const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
			if (typeof failure.code !== 'number') throw new PublicationRebaseConflictError(`Unable to run Git: ${failure.message}`);
			return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code };
		}
	}

	#migrate(): void {
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensurePublicationRebaseSchema(this.#db);
	}
}
