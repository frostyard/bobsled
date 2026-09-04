import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { cp, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, type RepositoryContract, type WorkItem } from './contracts.ts';
import {
	DraftPatchEvidenceSchema,
	GateResultSchema,
	parseStoredWorkerOutcome,
	ReviewInitialDataSchema,
	ReviewOutcomeSchema,
	type ImplementationPlan,
	type ImplementationResult,
	type ReviewInitialData,
	type ReviewOutcome,
} from './execution-contracts.ts';
import { jobLedger, type JobLedger, type Principal } from './ledger.ts';
import {
	PublicationRebaseReviewRecordSchema,
	PublicationRebaseReviewRequestSchema,
	type PublicationRebaseReviewBlockReason,
	type PublicationRebaseReviewRecord,
} from './publication-rebase-review-contracts.ts';
import { ensurePublicationRebaseReviewSchema } from './publication-rebase-review-schema.ts';
import { ensurePublicationRebaseSchema } from './publication-rebase-schema.ts';
import { getRepository } from './repositories.ts';
import { runReviewWorker, type ReviewWorkerRunner } from './review-worker-service.ts';
import { claimOrganizationCapacity, ensureOrganizationCapacityClaimSchema, getOrganizationCapacityClaim, releaseOrganizationCapacity } from './organization-capacity-claim-store.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

export class PublicationRebaseReviewConflictError extends Error {}
export class PublicationRebaseReviewForbiddenError extends Error {}
export class PublicationRebaseReviewNotFoundError extends Error {}

interface ReviewRow {
	id: string; owner_id: string; idempotency_key: string; request_sha256: string; rebase_id: string;
	source_publication_id: string; repository_id: string; status: PublicationRebaseReviewRecord['status'];
	base_commit: string; patch_sha256: string; changed_paths_json: string; workspace_path: string;
	repository_context_path: string | null; report_json: string | null; conversation_id: string | null; submission_id: string | null;
	model_calls: 0 | 1; block_reason: PublicationRebaseReviewBlockReason | null; detail: string | null;
	lease_expires_at: string | null; reason: string; created_at: string; updated_at: string;
}

interface RebaseRow {
	id: string; owner_id: string; source_publication_id: string; repository_id: string; status: string;
	new_base_commit: string | null; replayed_patch_sha256: string | null; replayed_changed_paths_json: string;
	workspace_path: string | null; gates_json: string;
}

interface SourcePublicationRow {
	id: string; owner_id: string; run_id: string; run_version: number; job_id: string; attempt_id: string;
	repository_id: string;
}

export interface PublicationRebaseReviewSourceContext {
	repository: RepositoryContract;
	workItem: WorkItem;
	implementationPlan: ImplementationPlan;
	implementationResult: ImplementationResult;
}

export interface PublicationRebaseReviewServiceOptions {
	path?: string;
	ledger?: JobLedger;
	repository?: (id: string) => RepositoryContract | undefined;
	reviewer?: ReviewWorkerRunner;
	workspaceRoot?: string;
	sourceResolver?: (rebaseId: string, principal: Principal) => PublicationRebaseReviewSourceContext;
	now?: () => Date;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function json(value: unknown): string { return JSON.stringify(canonical(value)); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function nulList(value: string): string[] { return value.split('\0').filter(Boolean); }
function samePaths(left: readonly string[], right: readonly string[]): boolean { return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0'); }
function matchesProtectedPath(path: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) { const prefix = pattern.slice(0, -3); return path === prefix || path.startsWith(`${prefix}/`); }
	return path === pattern;
}

function rowToRecord(row: ReviewRow): PublicationRebaseReviewRecord {
	return v.parse(PublicationRebaseReviewRecordSchema, {
		id: row.id, ownerId: row.owner_id, rebaseId: row.rebase_id, sourcePublicationId: row.source_publication_id,
		repositoryId: row.repository_id, status: row.status, baseCommit: row.base_commit, patchSha256: row.patch_sha256,
		changedPaths: JSON.parse(row.changed_paths_json), workspacePath: row.workspace_path,
		repositoryContextPath: row.repository_context_path ?? undefined, report: row.report_json ? JSON.parse(row.report_json) : undefined,
		conversationId: row.conversation_id ?? undefined, submissionId: row.submission_id ?? undefined,
		modelCalls: row.model_calls, blockReason: row.block_reason ?? undefined, detail: row.detail ?? undefined,
		promotionAuthorized: false, publicationAuthorized: false, reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
	});
}

export class PublicationRebaseReviewService {
	readonly #db: Database.Database;
	readonly #ledger: JobLedger;
	readonly #repository: (id: string) => RepositoryContract | undefined;
	readonly #reviewer: ReviewWorkerRunner;
	readonly #workspaceRoot: string;
	readonly #resolveSource: (rebaseId: string, principal: Principal) => PublicationRebaseReviewSourceContext;
	readonly #now: () => Date;

	constructor(options: PublicationRebaseReviewServiceOptions = {}) {
		const databasePath = options.path ?? dataPath('bobsled.db');
		if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
		this.#db = new Database(databasePath); if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#ledger = options.ledger ?? jobLedger;
		this.#repository = options.repository ?? getRepository;
		this.#reviewer = options.reviewer ?? runReviewWorker;
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
		this.#resolveSource = options.sourceResolver ?? ((rebaseId, principal) => this.#sourceContext(rebaseId, principal));
		this.#now = options.now ?? (() => new Date());
		this.#migrate();
	}

	close(): void { this.#db.close(); }

	admit(input: unknown, principal: Principal, idempotencyKey: string): PublicationRebaseReviewRecord {
		const request = v.parse(PublicationRebaseReviewRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new PublicationRebaseReviewConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(json(request));
		const existing = this.#db.prepare('SELECT * FROM publication_rebase_reviews WHERE owner_id = ? AND idempotency_key = ?').get(principal.id, idempotencyKey) as ReviewRow | undefined;
		if (existing) {
			if (existing.request_sha256 !== requestSha256) throw new PublicationRebaseReviewConflictError('Idempotency key was already used for different input');
			return rowToRecord(existing);
		}
		const rebase = this.#rebase(request.rebaseId, principal);
		this.#validateRebase(rebase);
		this.#validateCurrentPolicy(rebase.repository_id);
		this.#resolveSource(rebase.id, principal);
		const occupied = this.#db.prepare("SELECT id FROM publication_rebase_reviews WHERE rebase_id = ? AND (status IN ('pending','preparing','running','approved') OR model_calls = 1) LIMIT 1").get(rebase.id);
		if (occupied) throw new PublicationRebaseReviewConflictError('This replay already has an active or model-bearing fresh review');
		const id = randomUUID(); const now = this.#now().toISOString();
		try {
			this.#db.prepare(`INSERT INTO publication_rebase_reviews
				(id, owner_id, idempotency_key, request_sha256, rebase_id, source_publication_id, repository_id, status,
				 base_commit, patch_sha256, changed_paths_json, workspace_path, model_calls, reason, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?)`).run(
				id, principal.id, idempotencyKey, requestSha256, rebase.id, rebase.source_publication_id, rebase.repository_id,
				rebase.new_base_commit, rebase.replayed_patch_sha256, rebase.replayed_changed_paths_json, rebase.workspace_path,
				request.reason, now, now,
			);
		} catch (error) {
			if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new PublicationRebaseReviewConflictError('This replay already has an active or model-bearing fresh review');
			throw error;
		}
		return this.get(id, principal);
	}

	get(id: string, principal: Principal): PublicationRebaseReviewRecord {
		const row = this.#db.prepare('SELECT * FROM publication_rebase_reviews WHERE id = ?').get(id) as ReviewRow | undefined;
		if (!row) throw new PublicationRebaseReviewNotFoundError('Publication replay review not found');
		if (row.owner_id !== principal.id) throw new PublicationRebaseReviewForbiddenError('Publication replay review belongs to another principal');
		return rowToRecord(row);
	}

	list(principal: Principal): PublicationRebaseReviewRecord[] {
		return (this.#db.prepare('SELECT * FROM publication_rebase_reviews WHERE owner_id = ? ORDER BY created_at DESC').all(principal.id) as ReviewRow[]).map(rowToRecord);
	}

	async execute(id: string, principal: Principal): Promise<PublicationRebaseReviewRecord> {
		const record = this.get(id, principal);
		if (record.status === 'approved' || record.status === 'blocked' || record.status === 'failed') return record;
		const now = this.#now();
		if (record.status === 'preparing' || record.status === 'running') {
			const row = this.#db.prepare('SELECT lease_expires_at FROM publication_rebase_reviews WHERE id = ?').get(id) as { lease_expires_at: string | null };
			if (!row.lease_expires_at || row.lease_expires_at > now.toISOString()) throw new PublicationRebaseReviewConflictError('Fresh replay review is already running');
			return record.status === 'running'
				? this.#settle(id, principal, 'failed', 'reviewer_failed', 'The prior model-bearing review expired; it cannot be retried.')
				: this.#settle(id, principal, 'blocked', 'unexpected_failure', 'The prior zero-call review preflight expired; create a superseding attempt.');
		}
		const preparing = this.#db.prepare(`UPDATE publication_rebase_reviews SET status = 'preparing', lease_expires_at = ?, updated_at = ?
			WHERE id = ? AND owner_id = ? AND status = 'pending' AND model_calls = 0`).run(
			new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString(), id, principal.id,
		);
		if (preparing.changes !== 1) throw new PublicationRebaseReviewConflictError('Fresh replay review preflight could not be claimed');

		let input: ReviewInitialData;
		let repositoryContextPath: string;
		try {
			({ input, repositoryContextPath } = await this.#preflight(record, principal));
		} catch (error) {
			return this.#settle(id, principal, 'blocked', 'rebase_evidence_changed', error instanceof Error ? error.message : 'Replay review preflight failed');
		}
		const claimed = this.#db.transaction(() => {
			claimOrganizationCapacity(this.#db, { sourceKind: 'publication_rebase_review', sourceId: id, ownerId: principal.id, repositoryId: record.repositoryId, slots: { openaiCodex: 0, githubCopilot: 1 } }, this.#now());
			return this.#db.prepare(`UPDATE publication_rebase_reviews SET status = 'running', model_calls = 1,
				repository_context_path = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'preparing' AND model_calls = 0`).run(
				repositoryContextPath, new Date(now.getTime() + this.#reviewTimeoutMs(record.repositoryId) + 60_000).toISOString(), now.toISOString(), id, principal.id,
			);
		}).immediate();
		if (claimed.changes !== 1) throw new PublicationRebaseReviewConflictError('Fresh replay review could not claim its sole model call');

		let outcome: ReviewOutcome;
		try { outcome = v.parse(ReviewOutcomeSchema, await this.#reviewer(input, this.#reviewTimeoutMs(record.repositoryId))); }
		catch (error) { return this.#settle(id, principal, 'failed', 'reviewer_failed', error instanceof Error ? error.message : 'Fresh reviewer failed'); }
		try { await this.#verifyWorkspace(record, this.#validateCurrentPolicy(record.repositoryId)); }
		catch (error) { return this.#settle(id, principal, 'blocked', 'workspace_changed', error instanceof Error ? error.message : 'Replay workspace changed during review', outcome); }
		if (outcome.report.verdict === 'approve') return this.#settle(id, principal, 'approved', undefined, undefined, outcome);
		return this.#settle(id, principal, 'blocked', outcome.report.verdict === 'reject' ? 'reviewer_rejected' : 'reviewer_changes_requested', outcome.report.summary, outcome);
	}

	async #preflight(record: PublicationRebaseReviewRecord, principal: Principal): Promise<{ input: ReviewInitialData; repositoryContextPath: string }> {
		const rebase = this.#rebase(record.rebaseId, principal); this.#validateRebase(rebase);
		if (rebase.source_publication_id !== record.sourcePublicationId || rebase.repository_id !== record.repositoryId
			|| rebase.new_base_commit !== record.baseCommit || rebase.replayed_patch_sha256 !== record.patchSha256
			|| !samePaths(JSON.parse(rebase.replayed_changed_paths_json), record.changedPaths) || rebase.workspace_path !== record.workspacePath) {
			throw new PublicationRebaseReviewConflictError('Validated replay no longer matches the admitted review');
		}
		const source = this.#resolveSource(rebase.id, principal);
		const repository = this.#validateCurrentPolicy(record.repositoryId);
		if (source.repository.id !== repository.id) throw new PublicationRebaseReviewConflictError('Review source repository does not match current enrollment');
		const evidence = await this.#verifyWorkspace(record, repository);
		const reviewRoot = resolve(this.#workspaceRoot, 'publication-rebase-reviews', record.id);
		const repositoryContextPath = resolve(reviewRoot, 'repository-context');
		if (await lstat(reviewRoot).then(() => true, () => false)) throw new PublicationRebaseReviewConflictError('Fresh replay review evidence path already exists');
		await cp(record.workspacePath, repositoryContextPath, {
			recursive: true, preserveTimestamps: true,
			filter: (sourcePath) => sourcePath === record.workspacePath || basename(sourcePath) !== '.git',
		});
		if (await realpath(repositoryContextPath) !== repositoryContextPath) throw new PublicationRebaseReviewConflictError('Fresh repository context is not a canonical directory');
		const patch = await this.#git(record.workspacePath, ['diff', '--binary', '--no-ext-diff', '--no-renames', record.baseCommit, '--'], false);
		await writeFile(resolve(reviewRoot, 'review-input.json'), `${JSON.stringify({ rebaseId: record.rebaseId, evidence }, null, 2)}\n`, { mode: 0o600 });
		return { repositoryContextPath, input: v.parse(ReviewInitialDataSchema, {
			reviewId: record.id, round: 'initial', repositoryContextPath, repository, workItem: source.workItem,
			implementationPlan: source.implementationPlan, implementationResult: source.implementationResult, evidence, patch,
		}) };
	}

	async #verifyWorkspace(record: PublicationRebaseReviewRecord, repository: RepositoryContract) {
		const workspace = resolve(record.workspacePath);
		if (await realpath(workspace).catch(() => undefined) !== workspace) throw new PublicationRebaseReviewConflictError('Validated replay workspace is unavailable');
		if (await this.#git(workspace, ['rev-parse', 'HEAD']) !== record.baseCommit) throw new PublicationRebaseReviewConflictError('Validated replay workspace HEAD changed');
		const untracked = nulList(await this.#git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], false));
		if (untracked.length > 0) throw new PublicationRebaseReviewConflictError('Validated replay workspace contains unreviewed files');
		const patch = await this.#git(workspace, ['diff', '--binary', '--no-ext-diff', '--no-renames', record.baseCommit, '--'], false);
		const changedPaths = nulList(await this.#git(workspace, ['diff', '--name-only', '-z', '--no-renames', record.baseCommit, '--'], false));
		if (digest(patch) !== record.patchSha256 || !samePaths(changedPaths, record.changedPaths)) throw new PublicationRebaseReviewConflictError('Validated replay patch bytes or paths changed');
		const numstat = await this.#git(workspace, ['diff', '--numstat', '--no-renames', record.baseCommit, '--']);
		const diffLines = numstat.split('\n').filter(Boolean).reduce((sum, line) => { const [added, deleted] = line.split('\t', 3); return added === '-' || deleted === '-' ? sum : sum + Number(added) + Number(deleted); }, 0);
		const row = this.#db.prepare('SELECT gates_json FROM publication_rebases WHERE id = ?').get(record.rebaseId) as { gates_json: string };
		const gates = v.parse(v.array(GateResultSchema), JSON.parse(row.gates_json));
		const gateById = new Map(repository.qualityGates.map((gate) => [gate.id, gate]));
		if (gates.length !== repository.executionPolicy.requiredGateIds.length || repository.executionPolicy.requiredGateIds.some((id, index) => {
			const policyGate = gateById.get(id); const evidenceGate = gates[index];
			return !policyGate || !evidenceGate || evidenceGate.id !== id || evidenceGate.command !== policyGate.command || evidenceGate.status !== 'passed';
		})) throw new PublicationRebaseReviewConflictError('Validated replay gates no longer satisfy current repository policy');
		const protectedPaths = changedPaths.filter((path) => repository.protectedBoundaries.some((boundary) => boundary.paths.some((pattern) => matchesProtectedPath(path, pattern))));
		if (changedPaths.length > repository.executionPolicy.maxFiles || diffLines > repository.executionPolicy.maxDiffLines || protectedPaths.length > 0) {
			throw new PublicationRebaseReviewConflictError('Validated replay no longer satisfies current path and size policy');
		}
		return v.parse(DraftPatchEvidenceSchema, {
			baseCommit: record.baseCommit, headCommit: record.baseCommit, headMoved: false, changedPaths, filesChanged: changedPaths.length,
			diffLines, diffSha256: record.patchSha256, protectedPaths, policyViolations: [], gates,
			workspacePath: workspace, evidencePath: resolve(this.#workspaceRoot, 'publication-rebase-reviews', record.id),
		});
	}

	#sourceContext(rebaseId: string, principal: Principal): PublicationRebaseReviewSourceContext {
		const rebase = this.#rebase(rebaseId, principal);
		const source = this.#db.prepare('SELECT id, owner_id, run_id, run_version, job_id, attempt_id, repository_id FROM draft_publications WHERE id = ?').get(rebase.source_publication_id) as SourcePublicationRow | undefined;
		if (!source || source.owner_id !== principal.id) throw new PublicationRebaseReviewConflictError('Source publication lineage is unavailable');
		const run = this.#ledger.get(source.run_id, principal);
		if (run.version !== source.run_version) throw new PublicationRebaseReviewConflictError('Source run version changed');
		const job = run.jobs.find(({ id }) => id === source.job_id);
		const attempt = job?.attempts.find(({ id }) => id === source.attempt_id);
		if (!job || !attempt || attempt.status !== 'succeeded') throw new PublicationRebaseReviewConflictError('Source implementation lineage is unavailable');
		const stored = attempt.outcome as { worker?: unknown } | undefined;
		const worker = parseStoredWorkerOutcome(stored?.worker);
		const repository = this.#repository(source.repository_id);
		if (!repository) throw new PublicationRebaseReviewConflictError('Source repository is no longer enrolled');
		return { repository, workItem: job.workItemSnapshot, implementationPlan: worker.plan, implementationResult: worker.result };
	}

	#rebase(id: string, principal: Principal): RebaseRow {
		const row = this.#db.prepare('SELECT id, owner_id, source_publication_id, repository_id, status, new_base_commit, replayed_patch_sha256, replayed_changed_paths_json, workspace_path, gates_json FROM publication_rebases WHERE id = ?').get(id) as RebaseRow | undefined;
		if (!row) throw new PublicationRebaseReviewNotFoundError('Validated publication replay not found');
		if (row.owner_id !== principal.id) throw new PublicationRebaseReviewForbiddenError('Validated publication replay belongs to another principal');
		return row;
	}

	#validateRebase(row: RebaseRow): void {
		if (row.status !== 'validated' || !row.new_base_commit || !row.replayed_patch_sha256 || !row.workspace_path
			|| (JSON.parse(row.replayed_changed_paths_json) as unknown[]).length === 0
			|| (JSON.parse(row.gates_json) as Array<{ status?: string }>).length === 0
			|| (JSON.parse(row.gates_json) as Array<{ status?: string }>).some(({ status }) => status !== 'passed')) {
			throw new PublicationRebaseReviewConflictError('Only complete validated replay evidence can enter fresh review');
		}
	}

	#validateCurrentPolicy(repositoryId: string): RepositoryContract {
		const repository = this.#repository(repositoryId);
		if (!repository?.reviewPolicy.enabled || !repository.publicationPolicy.enabled || repository.readOnly
			|| !repository.capabilities.writeCode || !repository.capabilities.writeGitHub) {
			throw new PublicationRebaseReviewConflictError('Current repository policy does not permit fresh review and eventual draft publication');
		}
		return v.parse(RepositoryContractSchema, repository);
	}

	#reviewTimeoutMs(repositoryId: string): number { return (this.#repository(repositoryId)?.reviewPolicy.reviewerTimeoutMinutes ?? 15) * 60_000; }

	#settle(id: string, principal: Principal, status: 'approved' | 'blocked' | 'failed', blockReason?: PublicationRebaseReviewBlockReason, detail?: string, outcome?: ReviewOutcome): PublicationRebaseReviewRecord {
		this.#db.transaction(() => {
			const changed = this.#db.prepare(`UPDATE publication_rebase_reviews SET status = ?, report_json = COALESCE(?, report_json),
				conversation_id = COALESCE(?, conversation_id), submission_id = COALESCE(?, submission_id), block_reason = ?, detail = ?,
				lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND status IN ('pending','preparing','running')`).run(
				status, outcome ? json(outcome.report) : null, outcome?.conversationId ?? null, outcome?.submissionId ?? null,
				blockReason ?? null, detail?.slice(0, 10_000) ?? null, this.#now().toISOString(), id, principal.id,
			);
			if (changed.changes !== 1) throw new PublicationRebaseReviewConflictError('Fresh replay review was settled concurrently');
			if (getOrganizationCapacityClaim(this.#db,'publication_rebase_review',id)?.status === 'active') releaseOrganizationCapacity(this.#db,'publication_rebase_review',id,`publication_rebase_review.${status}`,this.#now());
		}).immediate();
		return this.get(id, principal);
	}

	async #git(cwd: string, args: string[], trim = true): Promise<string> {
		try {
			const result = await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' } });
			return trim ? result.stdout.trim() : result.stdout;
		} catch (error) { throw new PublicationRebaseReviewConflictError(`Unable to verify replay workspace: ${error instanceof Error ? error.message : 'git failed'}`); }
	}

	#migrate(): void {
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensurePublicationRebaseSchema(this.#db); ensurePublicationRebaseReviewSchema(this.#db); ensureOrganizationCapacityClaimSchema(this.#db);
	}
}

export const publicationRebaseReviews = new PublicationRebaseReviewService();
