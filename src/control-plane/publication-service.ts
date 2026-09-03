import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { DraftPatchEvidenceSchema } from './execution-contracts.ts';
import { RepositoryContractSchema, type RepositoryContract, type WorkItem } from './contracts.ts';
import {
	GitHubInstallationConfigurationError,
	githubInstallationAuthority,
	type GitHubInstallationAuthority,
	type ScopedInstallationAuthority,
} from './github-installation.ts';
import { jobLedger, type JobLedger, type Principal } from './ledger.ts';
import {
	DraftPublicationRecordSchema,
	DraftPublicationRequestSchema,
	PublicationCheckSchema,
	type DraftPublicationRecord,
	type DraftPublicationRequest,
	type PublicationCheck,
} from './publication-contracts.ts';
import { getRepository } from './repositories.ts';

const execFileAsync = promisify(execFile);
const PUBLICATION_LEASE_MS = 5 * 60 * 1000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export class PublicationConflictError extends Error {}
export class PublicationForbiddenError extends Error {}
export class PublicationNotFoundError extends Error {}
export class PublicationPolicyBlockedError extends Error {}
export class PublicationUpstreamError extends Error {}

interface PublicationCandidate {
	runId: string;
	runVersion: number;
	jobId: string;
	attemptId: string;
	reviewId: string;
	repository: RepositoryContract;
	workItem: WorkItem;
	workspacePath: string;
	baseCommit: string;
	approvedPatchSha256: string;
}

interface PublicationBlobEntry {
	path: string;
	mode: '100644' | '100755' | '120000';
	contentBase64?: string;
	deleted: boolean;
}

interface WorkspacePublicationSnapshot {
	patchSha256: string;
	entries: PublicationBlobEntry[];
	totalBlobBytes: number;
}

interface PublicationRow {
	id: string; owner_id: string; idempotency_key: string; request_sha256: string;
	run_id: string; run_version: number; job_id: string; attempt_id: string; review_id: string;
	repository_id: string; status: DraftPublicationRecord['status']; base_commit: string;
	approved_patch_sha256: string; branch_name: string; title: string; body: string; marker: string;
	required_checks_json: string; reason: string; blocked_reason: string | null; attempt_count: number; lease_expires_at: string | null;
	commit_sha: string | null; pull_number: number | null; pull_url: string | null;
	pull_state: 'open' | 'closed' | null; pull_draft: number | null; pull_merged_at: string | null; pull_closed_at: string | null;
	checks_json: string; error: string | null; created_at: string; updated_at: string;
}

type CandidateResolver = (request: DraftPublicationRequest, principal: Principal) => PublicationCandidate;
type WorkspaceInspector = (candidate: PublicationCandidate) => Promise<WorkspacePublicationSnapshot>;

export interface DraftPublicationServiceOptions {
	path?: string;
	now?: () => Date;
	ledger?: JobLedger;
	authority?: GitHubInstallationAuthority;
	repository?: (id: string) => RepositoryContract | undefined;
	candidateResolver?: CandidateResolver;
	workspaceInspector?: WorkspaceInspector;
}

const GitRefSchema = v.object({ object: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) }) });
const BlobSchema = v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) });
const TreeSchema = v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) });
const CommitSchema = v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) });
const PullSchema = v.object({
	number: v.pipe(v.number(), v.integer(), v.minValue(1)),
	html_url: v.string(), body: v.nullable(v.string()), draft: v.boolean(),
	head: v.object({ ref: v.string(), sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) }),
});
const PullLifecycleSchema = v.object({
	number: v.pipe(v.number(), v.integer(), v.minValue(1)),
	html_url: v.string(), body: v.nullable(v.string()), draft: v.boolean(), state: v.picklist(['open', 'closed']),
	merged_at: v.nullable(v.string()), closed_at: v.nullable(v.string()),
	head: v.object({ ref: v.string(), sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)) }),
	base: v.object({ ref: v.string() }),
});
const PullListSchema = v.array(PullSchema);
const CheckRunsSchema = v.object({
	check_runs: v.array(v.object({
		name: v.string(), status: v.picklist(['queued', 'in_progress', 'completed']),
		conclusion: v.optional(v.nullable(v.string())), details_url: v.optional(v.nullable(v.string())),
	})),
});

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function json(value: unknown): string { return JSON.stringify(canonical(value)); }
function hash(value: unknown): string { return createHash('sha256').update(json(value)).digest('hex'); }

function rowToRecord(row: PublicationRow): DraftPublicationRecord {
	return v.parse(DraftPublicationRecordSchema, {
		id: row.id, ownerId: row.owner_id, runId: row.run_id, jobId: row.job_id,
		attemptId: row.attempt_id, reviewId: row.review_id, repositoryId: row.repository_id,
		status: row.status, baseCommit: row.base_commit, approvedPatchSha256: row.approved_patch_sha256,
		branchName: row.branch_name, title: row.title, body: row.body, marker: row.marker,
		requiredCheckNames: JSON.parse(row.required_checks_json),
		reason: row.reason, blockedReason: row.blocked_reason ?? undefined, attemptCount: row.attempt_count,
		commitSha: row.commit_sha ?? undefined, pullNumber: row.pull_number ?? undefined,
		pullUrl: row.pull_url ?? undefined, pullState: row.pull_state ?? undefined,
		pullDraft: row.pull_draft === null ? undefined : Boolean(row.pull_draft),
		pullMergedAt: row.pull_merged_at ?? undefined, pullClosedAt: row.pull_closed_at ?? undefined,
		checks: JSON.parse(row.checks_json),
		error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
	});
}

function publicationPolicyBlock(snapshot: RepositoryContract, current: RepositoryContract | undefined): string | undefined {
	if (!snapshot.publicationPolicy.enabled) return 'Run policy snapshot does not permit draft publication';
	if (!current) return 'Repository is no longer enrolled';
	if (current.readOnly) return 'Repository policy is read-only';
	if (!current.capabilities.writeGitHub) return 'Repository policy does not allow GitHub writes';
	if (!current.publicationPolicy.enabled) return 'Repository policy does not permit draft publication';
	return undefined;
}

function branchSlug(title: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
	return slug || 'change';
}

function publicationBody(candidate: PublicationCandidate, marker: string): string {
	const taskBody = candidate.workItem.body.trim().slice(0, 30_000);
	return [
		'## Summary', candidate.workItem.title,
		...(taskBody ? ['', '## Task context', taskBody] : []),
		'', '## Bobsled evidence',
		`- Run: \`${candidate.runId}\``,
		`- Review: \`${candidate.reviewId}\``,
		`- Base commit: \`${candidate.baseCommit}\``,
		`- Approved patch SHA-256: \`${candidate.approvedPatchSha256}\``,
		'', '## Human boundary',
		'This pull request is intentionally a draft. Bobsled cannot merge it; human review and repository checks remain mandatory.',
		'', marker,
	].join('\n');
}

async function git(cwd: string, args: string[], trim = true): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', args, {
			cwd, maxBuffer: GIT_MAX_BUFFER,
			env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' },
		});
		return trim ? stdout.trim() : stdout;
	} catch (error) {
		throw new PublicationPolicyBlockedError(`Unable to verify approved workspace: ${error instanceof Error ? error.message : 'git failed'}`);
	}
}

async function inspectWorkspace(candidate: PublicationCandidate): Promise<WorkspacePublicationSnapshot> {
	const workspace = resolve(candidate.workspacePath);
	if (await realpath(workspace).catch(() => undefined) !== workspace) throw new PublicationPolicyBlockedError('Approved review workspace is unavailable');
	const head = await git(workspace, ['rev-parse', 'HEAD']);
	if (head !== candidate.baseCommit) throw new PublicationPolicyBlockedError('Approved workspace HEAD no longer matches its base commit');
	const untracked = (await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], false)).split('\0').filter(Boolean);
	if (untracked.length > 0) throw new PublicationPolicyBlockedError(`Approved workspace contains unreviewed files: ${untracked.join(', ')}`);
	const patch = await git(workspace, ['diff', '--binary', '--no-ext-diff', '--no-renames', candidate.baseCommit, '--'], false);
	const patchSha256 = createHash('sha256').update(patch).digest('hex');
	const names = (await git(workspace, ['diff', '--name-status', '-z', '--no-renames', candidate.baseCommit, '--'], false)).split('\0').filter(Boolean);
	const entries: PublicationBlobEntry[] = [];
	let totalBlobBytes = 0;
	for (let index = 0; index < names.length; index += 2) {
		const status = names[index]; const path = names[index + 1];
		if (!status || !path || !/^[AMD]$/.test(status) || path.startsWith('/') || path.split('/').includes('..')) throw new PublicationPolicyBlockedError('Approved patch contains an unsupported path operation');
		if (status === 'D') { entries.push({ path, mode: '100644', deleted: true }); continue; }
		const absolute = resolve(workspace, path);
		if (absolute !== workspace && !absolute.startsWith(`${workspace}/`)) throw new PublicationPolicyBlockedError('Approved patch path escapes the workspace');
		const info = await lstat(absolute);
		let content: Buffer;
		let mode: PublicationBlobEntry['mode'];
		if (info.isSymbolicLink()) { content = Buffer.from(await readlink(absolute)); mode = '120000'; }
		else if (info.isFile()) { content = await readFile(absolute); mode = (info.mode & 0o111) ? '100755' : '100644'; }
		else throw new PublicationPolicyBlockedError(`Approved path is not a file or symlink: ${path}`);
		totalBlobBytes += content.byteLength;
		entries.push({ path, mode, contentBase64: content.toString('base64'), deleted: false });
	}
	if (entries.length === 0) throw new PublicationPolicyBlockedError('Approved patch contains no publishable files');
	if (totalBlobBytes > candidate.repository.publicationPolicy.maxTotalBlobBytes) throw new PublicationPolicyBlockedError(`Approved files total ${totalBlobBytes} bytes; publication policy allows ${candidate.repository.publicationPolicy.maxTotalBlobBytes}`);
	return { patchSha256, entries, totalBlobBytes };
}

class ScopedDraftPullRequestClient {
	readonly #authority: ScopedInstallationAuthority;
	constructor(authority: ScopedInstallationAuthority) { this.#authority = authority; }

	async publish(record: DraftPublicationRecord, candidate: PublicationCandidate, snapshot: WorkspacePublicationSnapshot): Promise<{ commitSha: string; pullNumber: number; pullUrl: string; recovered: boolean }> {
		const baseRef = v.parse(GitRefSchema, await this.#json(await this.#request(`/repos/${record.repositoryId}/git/ref/heads/${encodeURIComponent(candidate.repository.defaultBranch)}`, { method: 'GET' }), 'default branch'));
		if (baseRef.object.sha !== record.baseCommit) throw new PublicationPolicyBlockedError(`Remote ${candidate.repository.defaultBranch} moved beyond the approved base commit`);
		const treeEntries: Array<Record<string, unknown>> = [];
		for (const entry of snapshot.entries) {
			if (entry.deleted) { treeEntries.push({ path: entry.path, mode: '100644', type: 'blob', sha: null }); continue; }
			const blob = v.parse(BlobSchema, await this.#json(await this.#request(`/repos/${record.repositoryId}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: entry.contentBase64, encoding: 'base64' }) }), 'blob creation'));
			treeEntries.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: blob.sha });
		}
		const tree = v.parse(TreeSchema, await this.#json(await this.#request(`/repos/${record.repositoryId}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: record.baseCommit, tree: treeEntries }) }), 'tree creation'));
		const message = `${record.title}\n\nBobsled-Publication: ${record.id}\nApproved-Patch-SHA256: ${record.approvedPatchSha256}`;
		const identity = { name: 'Bobsled', email: 'bobsled@users.noreply.github.com', date: record.createdAt };
		const commit = v.parse(CommitSchema, await this.#json(await this.#request(`/repos/${record.repositoryId}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [record.baseCommit], author: identity, committer: identity }) }), 'commit creation'));
		const existing = await this.#findPull(record);
		if (existing) {
			if (existing.head.sha !== commit.sha) throw new PublicationPolicyBlockedError('Recovered pull request head does not match the deterministic approved commit');
			return { commitSha: commit.sha, pullNumber: existing.number, pullUrl: existing.html_url, recovered: true };
		}
		const branchPath = `/repos/${record.repositoryId}/git/ref/heads/${encodeURIComponent(record.branchName)}` as const;
		const branchResponse = await this.#authority.request(branchPath, { method: 'GET' });
		if (branchResponse.status === 404) {
			await this.#request(`/repos/${record.repositoryId}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${record.branchName}`, sha: commit.sha }) });
		} else {
			const branch = v.parse(GitRefSchema, await this.#jsonChecked(branchResponse, 'branch lookup'));
			if (branch.object.sha === record.baseCommit) await this.#request(branchPath, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
			else if (branch.object.sha !== commit.sha) throw new PublicationPolicyBlockedError('Publication branch exists at an unexpected commit; Bobsled will not force-push');
		}
		const pull = v.parse(PullSchema, await this.#json(await this.#request(`/repos/${record.repositoryId}/pulls`, { method: 'POST', body: JSON.stringify({ title: record.title, body: record.body, head: record.branchName, base: candidate.repository.defaultBranch, draft: true }) }), 'draft pull request creation'));
		if (!pull.draft) throw new PublicationUpstreamError('GitHub did not create the pull request as a draft');
		return { commitSha: commit.sha, pullNumber: pull.number, pullUrl: pull.html_url, recovered: false };
	}

	async #findPull(record: DraftPublicationRecord): Promise<v.InferOutput<typeof PullSchema> | undefined> {
		const [owner] = record.repositoryId.split('/');
		const query = new URLSearchParams({ state: 'open', head: `${owner}:${record.branchName}`, per_page: '100' });
		const response = await this.#request(`/repos/${record.repositoryId}/pulls?${query}`, { method: 'GET' });
		const pulls = v.parse(PullListSchema, await this.#json(response, 'pull request reconciliation'));
		const found = pulls.find(({ body }) => body?.includes(record.marker));
		if (found && !found.draft) throw new PublicationPolicyBlockedError('Recovered pull request is no longer a draft');
		return found;
	}

	async #request(path: `/${string}` | string, init: RequestInit): Promise<Response> {
		const headers = new Headers(init.headers); if (init.body) headers.set('content-type', 'application/json');
		const response = await this.#authority.request(path as `/${string}`, { ...init, headers });
		if (!response.ok) throw new PublicationUpstreamError(`GitHub ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}`);
		return response;
	}

	async #json(response: Response, label: string): Promise<unknown> { return this.#jsonChecked(response, label); }
	async #jsonChecked(response: Response, label: string): Promise<unknown> {
		if (!response.ok) throw new PublicationUpstreamError(`${label} failed with HTTP ${response.status}`);
		try { return await response.json(); } catch { throw new PublicationUpstreamError(`${label} returned invalid JSON`); }
	}
}

export class DraftPublicationService {
	readonly #db: Database.Database;
	readonly #now: () => Date;
	readonly #authority: GitHubInstallationAuthority;
	readonly #repository: (id: string) => RepositoryContract | undefined;
	readonly #resolveCandidate: CandidateResolver;
	readonly #inspectWorkspace: WorkspaceInspector;

	constructor(options: DraftPublicationServiceOptions = {}) {
		const path = options.path ?? dataPath('bobsled.db');
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path); if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#now = options.now ?? (() => new Date());
		this.#authority = options.authority ?? githubInstallationAuthority;
		this.#repository = options.repository ?? getRepository;
		const ledger = options.ledger ?? jobLedger;
		this.#resolveCandidate = options.candidateResolver ?? ((request, principal) => this.#candidateFromLedger(ledger, request, principal));
		this.#inspectWorkspace = options.workspaceInspector ?? inspectWorkspace;
		this.#migrate();
	}

	close(): void { this.#db.close(); }

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS draft_publications (
				id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
				run_id TEXT NOT NULL, run_version INTEGER NOT NULL, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, review_id TEXT NOT NULL,
				repository_id TEXT NOT NULL, status TEXT NOT NULL, base_commit TEXT NOT NULL, approved_patch_sha256 TEXT NOT NULL,
				branch_name TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, marker TEXT NOT NULL,
				required_checks_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL,
				blocked_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
				commit_sha TEXT, pull_number INTEGER, pull_url TEXT, checks_json TEXT NOT NULL DEFAULT '[]', error TEXT,
				pull_state TEXT, pull_draft INTEGER, pull_merged_at TEXT, pull_closed_at TEXT,
				created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key), UNIQUE(run_id, review_id)
			);
			CREATE INDEX IF NOT EXISTS draft_publications_status_idx ON draft_publications(status, updated_at);
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (8, datetime('now'));
		`);
		const columns = this.#db.pragma('table_info(draft_publications)') as Array<{ name: string }>;
		if (!columns.some(({ name }) => name === 'required_checks_json')) this.#db.exec("ALTER TABLE draft_publications ADD COLUMN required_checks_json TEXT NOT NULL DEFAULT '[]'");
		if (!columns.some(({ name }) => name === 'pull_state')) this.#db.exec('ALTER TABLE draft_publications ADD COLUMN pull_state TEXT');
		if (!columns.some(({ name }) => name === 'pull_draft')) this.#db.exec('ALTER TABLE draft_publications ADD COLUMN pull_draft INTEGER');
		if (!columns.some(({ name }) => name === 'pull_merged_at')) this.#db.exec('ALTER TABLE draft_publications ADD COLUMN pull_merged_at TEXT');
		if (!columns.some(({ name }) => name === 'pull_closed_at')) this.#db.exec('ALTER TABLE draft_publications ADD COLUMN pull_closed_at TEXT');
		this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (9, datetime('now'))").run();
		this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (21, datetime('now'))").run();
	}

	async admit(input: unknown, principal: Principal, idempotencyKey: string): Promise<DraftPublicationRecord> {
		const request = v.parse(DraftPublicationRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded Idempotency-Key is required');
		const requestSha256 = hash(request);
		const existing = this.#db.prepare('SELECT * FROM draft_publications WHERE owner_id = ? AND idempotency_key = ?').get(principal.id, idempotencyKey) as PublicationRow | undefined;
		if (existing) { if (existing.request_sha256 !== requestSha256) throw new PublicationConflictError('Idempotency key was already used for different input'); return rowToRecord(existing); }
		const candidate = this.#resolveCandidate(request, principal);
		const snapshot = await this.#inspectWorkspace(candidate);
		const drift = snapshot.patchSha256 === candidate.approvedPatchSha256 ? undefined : 'Workspace patch no longer matches the approved review digest';
		const blockedReason = drift ?? publicationPolicyBlock(candidate.repository, this.#repository(candidate.repository.id));
		const id = randomUUID(); const timestamp = this.#now().toISOString();
		const marker = `<!-- bobsled-publication:${id} patch:${candidate.approvedPatchSha256} -->`;
		const branchName = `${candidate.repository.publicationPolicy.branchPrefix}${candidate.runId.slice(0, 8)}-${branchSlug(candidate.workItem.title)}`.slice(0, 255);
		const title = candidate.workItem.title.slice(0, 256);
		const body = publicationBody(candidate, marker);
		try {
			this.#db.prepare(`INSERT INTO draft_publications
				(id, owner_id, idempotency_key, request_sha256, run_id, run_version, job_id, attempt_id, review_id,
				 repository_id, status, base_commit, approved_patch_sha256, branch_name, title, body, marker, required_checks_json, reason,
				 blocked_reason, attempt_count, checks_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`).run(
				id, principal.id, idempotencyKey, requestSha256, candidate.runId, candidate.runVersion,
				candidate.jobId, candidate.attemptId, candidate.reviewId, candidate.repository.id,
				blockedReason ? 'blocked' : 'pending', candidate.baseCommit, candidate.approvedPatchSha256,
				branchName, title, body, marker, json(candidate.repository.publicationPolicy.requiredCheckNames), request.reason, blockedReason ?? null, timestamp, timestamp,
			);
		} catch (error) {
			if (error instanceof Error && /UNIQUE constraint failed: draft_publications\.run_id/.test(error.message)) throw new PublicationConflictError('This approved review already has a publication record');
			throw error;
		}
		return this.get(id, principal);
	}

	list(principal: Principal): DraftPublicationRecord[] { return (this.#db.prepare('SELECT * FROM draft_publications WHERE owner_id = ? ORDER BY created_at DESC').all(principal.id) as PublicationRow[]).map(rowToRecord); }

	get(id: string, principal: Principal): DraftPublicationRecord {
		const row = this.#db.prepare('SELECT * FROM draft_publications WHERE id = ?').get(id) as PublicationRow | undefined;
		if (!row) throw new PublicationNotFoundError('Draft publication not found');
		if (row.owner_id !== principal.id) throw new PublicationForbiddenError('Draft publication belongs to another principal');
		return rowToRecord(row);
	}

	async execute(id: string, principal: Principal): Promise<DraftPublicationRecord> {
		const record = this.get(id, principal);
		if (['published', 'checks_pending', 'checks_failed', 'ready_for_human', 'merged', 'closed'].includes(record.status)) return record;
		const request = { runId: record.runId, expectedVersion: (this.#db.prepare('SELECT run_version FROM draft_publications WHERE id = ?').get(id) as { run_version: number }).run_version, reason: record.reason };
		const candidate = this.#resolveCandidate(request, principal);
		const blockedReason = publicationPolicyBlock(candidate.repository, this.#repository(record.repositoryId));
		if (blockedReason) { this.#block(id, blockedReason); throw new PublicationPolicyBlockedError(blockedReason); }
		if (record.attemptCount >= candidate.repository.publicationPolicy.maxAttempts) { const reason = 'Publication attempt limit reached'; this.#block(id, reason); throw new PublicationPolicyBlockedError(reason); }
		const snapshot = await this.#inspectWorkspace(candidate);
		if (snapshot.patchSha256 !== record.approvedPatchSha256) { const reason = 'Workspace patch no longer matches the approved review digest'; this.#block(id, reason); throw new PublicationPolicyBlockedError(reason); }
		const now = this.#now();
		const claimed = this.#db.prepare(`UPDATE draft_publications SET status = 'running', blocked_reason = NULL, error = NULL,
			attempt_count = attempt_count + 1, lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?
			AND (status IN ('pending','failed','blocked') OR (status = 'running' AND lease_expires_at <= ?))`).run(
			new Date(now.getTime() + PUBLICATION_LEASE_MS).toISOString(), now.toISOString(), id, principal.id, now.toISOString(),
		);
		if (claimed.changes !== 1) throw new PublicationConflictError('Draft publication is already running');
		try {
			const result = await this.#authority.withRequest(record.repositoryId, 'draft_pr_publish', async (authority) => new ScopedDraftPullRequestClient(authority).publish(record, candidate, snapshot));
			this.#db.prepare("UPDATE draft_publications SET status = 'published', commit_sha = ?, pull_number = ?, pull_url = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
				.run(result.commitSha, result.pullNumber, result.pullUrl, this.#now().toISOString(), id);
			return this.get(id, principal);
		} catch (error) {
			if (error instanceof PublicationPolicyBlockedError || error instanceof GitHubInstallationConfigurationError) {
				const message = error.message; this.#block(id, message); throw new PublicationPolicyBlockedError(message);
			}
			const message = error instanceof Error ? error.message : 'Draft publication failed';
			this.#db.prepare("UPDATE draft_publications SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(message, this.#now().toISOString(), id);
			throw error;
		}
	}

	async refreshChecks(id: string, principal: Principal): Promise<DraftPublicationRecord> {
		const record = this.get(id, principal);
		if (record.status === 'merged') return record;
		if (!record.commitSha || !record.pullNumber || !['published', 'checks_pending', 'checks_failed', 'ready_for_human', 'closed'].includes(record.status)) throw new PublicationConflictError('Draft pull request has not been published');
		const current = this.#repository(record.repositoryId);
		if (!current) throw new PublicationNotFoundError(`Repository is not enrolled: ${record.repositoryId}`);
		const pull = await this.#authority.withRequest(record.repositoryId, 'pull_request_status_read', async (authority) => {
			const response = await authority.request(`/repos/${record.repositoryId}/pulls/${record.pullNumber}`, { method: 'GET' });
			if (!response.ok) throw new PublicationUpstreamError(`GitHub pull-request lookup failed with HTTP ${response.status}`);
			return v.parse(PullLifecycleSchema, await response.json());
		});
		if (pull.number !== record.pullNumber || pull.html_url !== record.pullUrl || pull.head.ref !== record.branchName || pull.head.sha !== record.commitSha || pull.base.ref !== current.defaultBranch || !pull.body?.includes(record.marker)) {
			const reason = 'Published pull request no longer matches Bobsled immutable evidence';
			this.#block(id, reason); throw new PublicationPolicyBlockedError(reason);
		}
		const lifecycle = [pull.state, pull.draft ? 1 : 0, pull.merged_at, pull.closed_at, pull.html_url] as const;
		if (pull.merged_at) {
			this.#db.prepare("UPDATE draft_publications SET status = 'merged', pull_state = ?, pull_draft = ?, pull_merged_at = ?, pull_closed_at = ?, pull_url = ?, updated_at = ? WHERE id = ?")
				.run(...lifecycle, this.#now().toISOString(), id);
			return this.get(id, principal);
		}
		if (pull.state === 'closed') {
			this.#db.prepare("UPDATE draft_publications SET status = 'closed', pull_state = ?, pull_draft = ?, pull_merged_at = ?, pull_closed_at = ?, pull_url = ?, updated_at = ? WHERE id = ?")
				.run(...lifecycle, this.#now().toISOString(), id);
			return this.get(id, principal);
		}
		const checks = await this.#authority.withRequest(record.repositoryId, 'commit_checks_read', async (authority) => {
			const response = await authority.request(`/repos/${record.repositoryId}/commits/${record.commitSha}/check-runs?per_page=100`, { method: 'GET' });
			if (!response.ok) throw new PublicationUpstreamError(`GitHub check-run lookup failed with HTTP ${response.status}`);
			const parsed = v.parse(CheckRunsSchema, await response.json());
			return parsed.check_runs.map((check) => v.parse(PublicationCheckSchema, { name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.details_url ?? undefined }));
		});
		const required = [...new Set([...record.requiredCheckNames, ...current.publicationPolicy.requiredCheckNames])];
		const byName = new Map(checks.map((check) => [check.name, check]));
		const missingOrRunning = required.some((name) => !byName.has(name) || byName.get(name)?.status !== 'completed');
		const failed = required.some((name) => { const conclusion = byName.get(name)?.conclusion; return conclusion !== undefined && conclusion !== null && !['success', 'neutral', 'skipped'].includes(conclusion); });
		const status: DraftPublicationRecord['status'] = failed ? 'checks_failed' : missingOrRunning ? 'checks_pending' : 'ready_for_human';
		this.#db.prepare('UPDATE draft_publications SET status = ?, pull_state = ?, pull_draft = ?, pull_merged_at = ?, pull_closed_at = ?, pull_url = ?, checks_json = ?, updated_at = ? WHERE id = ?')
			.run(status, ...lifecycle, json(checks), this.#now().toISOString(), id);
		return this.get(id, principal);
	}

	#candidateFromLedger(ledger: JobLedger, request: DraftPublicationRequest, principal: Principal): PublicationCandidate {
		const run = ledger.get(request.runId, principal);
		if (run.version !== request.expectedVersion) throw new PublicationConflictError('Run changed; reload before preparing publication');
		if (run.status !== 'succeeded') throw new PublicationConflictError('Only a successfully gated run can be prepared for publication');
		const job = run.jobs[0]; if (!job || job.status !== 'succeeded') throw new PublicationConflictError('Run has no successfully gated job');
		const repositoryResult = v.safeParse(RepositoryContractSchema, job.policySnapshot);
		if (!repositoryResult.success) throw new PublicationConflictError('Run policy snapshot predates the M4 publication contract; supersede it with a new run');
		const attempt = job.attempts.at(-1); if (!attempt || attempt.status !== 'succeeded') throw new PublicationConflictError('Run has no successful implementation attempt');
		const review = [...job.reviews].reverse().find((item) => item.attemptId === attempt.id && item.status === 'approved');
		if (!review) throw new PublicationConflictError('The implementation attempt has no approved adversarial review');
		const evidence = v.parse(DraftPatchEvidenceSchema, (review.outcome as { evidence?: unknown } | undefined)?.evidence);
		const artifact = [...job.artifacts].reverse().find((item) => item.kind === 'review_draft_patch' && item.attemptId === attempt.id && item.metadata.reviewId === review.id);
		if (!artifact?.digest || artifact.digest !== evidence.diffSha256) throw new PublicationConflictError('Approved review has no digest-bound draft artifact');
		return { runId: run.id, runVersion: run.version, jobId: job.id, attemptId: attempt.id, reviewId: review.id, repository: repositoryResult.output, workItem: job.workItemSnapshot, workspacePath: evidence.workspacePath, baseCommit: evidence.baseCommit, approvedPatchSha256: evidence.diffSha256 };
	}

	#block(id: string, reason: string): void { this.#db.prepare("UPDATE draft_publications SET status = 'blocked', blocked_reason = ?, error = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(reason, this.#now().toISOString(), id); }
}

export const draftPublications = new DraftPublicationService();
