import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, TriageLabelSchema, type RepositoryContract } from './contracts.ts';
import {
	githubInstallationAuthority,
	type GitHubInstallationAuthority,
	type ScopedInstallationAuthority,
} from './github-installation.ts';
import type { Principal } from './ledger.ts';
import { getRepository } from './repositories.ts';

const routeLabels = [
	'bobsled:ready', 'bobsled:needs-spec', 'bobsled:needs-human', 'bobsled:needs-info', 'bobsled:ignore',
] as const;
const ACTION_LEASE_MS = 2 * 60 * 1000;
const MAX_COMMENT_PAGES = 20;
const CreatedCommentSchema = v.object({
	id: v.pipe(v.number(), v.integer(), v.minValue(1)),
	html_url: v.optional(v.string()),
});

export const GitHubIssueActionRequestSchema = v.variant('kind', [
	v.object({
		kind: v.literal('set_triage_label'),
		repositoryId: RepositoryIdSchema,
		issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
		label: TriageLabelSchema,
	}),
	v.object({
		kind: v.literal('comment'),
		repositoryId: RepositoryIdSchema,
		issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
		body: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
	}),
]);

export type GitHubIssueActionRequest = v.InferOutput<typeof GitHubIssueActionRequestSchema>;
export type GitHubIssueActionStatus = 'blocked' | 'pending' | 'running' | 'succeeded' | 'failed';

export interface GitHubIssueActionRecord {
	id: string;
	ownerId: string;
	status: GitHubIssueActionStatus;
	request: GitHubIssueActionRequest;
	marker?: string;
	blockedReason?: string;
	attemptCount: number;
	result?: unknown;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

interface ActionRow {
	id: string;
	owner_id: string;
	status: GitHubIssueActionStatus;
	request_json: string;
	marker: string | null;
	blocked_reason: string | null;
	attempt_count: number;
	result_json: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
}

export class GitHubActionConflictError extends Error {}
export class GitHubActionForbiddenError extends Error {}
export class GitHubActionNotFoundError extends Error {}
export class GitHubActionPolicyBlockedError extends Error {}
export class GitHubActionUpstreamError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function json(value: unknown): string {
	return JSON.stringify(canonical(value));
}

function hash(value: unknown): string {
	return createHash('sha256').update(json(value)).digest('hex');
}

function record(row: ActionRow): GitHubIssueActionRecord {
	return {
		id: row.id,
		ownerId: row.owner_id,
		status: row.status,
		request: JSON.parse(row.request_json) as GitHubIssueActionRequest,
		marker: row.marker ?? undefined,
		blockedReason: row.blocked_reason ?? undefined,
		attemptCount: row.attempt_count,
		result: row.result_json ? JSON.parse(row.result_json) : undefined,
		error: row.error ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function policyBlock(repository: RepositoryContract): string | undefined {
	if (repository.readOnly) return 'Repository policy is read-only';
	if (!repository.capabilities.writeGitHub) return 'Repository policy does not allow GitHub writes';
	return undefined;
}

function parseLastPage(link: string | null): number {
	if (!link) return 1;
	for (const part of link.split(',')) {
		if (!/rel="last"/.test(part)) continue;
		const match = part.match(/[?&]page=(\d+)/);
		if (match?.[1]) return Number(match[1]);
	}
	return 1;
}

class ScopedGitHubIssueClient {
	readonly #authority: ScopedInstallationAuthority;

	constructor(authority: ScopedInstallationAuthority) {
		this.#authority = authority;
	}

	async setTriageLabel(repository: string, issueNumber: number, label: typeof routeLabels[number]): Promise<unknown> {
		await this.#request(`/repos/${repository}/issues/${issueNumber}/labels`, {
			method: 'POST', body: JSON.stringify({ labels: [label] }),
		});
		for (const oldLabel of routeLabels) {
			if (oldLabel === label) continue;
			const response = await this.#request(`/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(oldLabel)}`, {
				method: 'DELETE', allowNotFound: true,
			});
			if (!response.ok && response.status !== 404) throw new GitHubActionUpstreamError(`GitHub label removal failed with HTTP ${response.status}`);
		}
		return { label };
	}

	async comment(repository: string, issueNumber: number, body: string, marker: string): Promise<unknown> {
		const existing = await this.#findComment(repository, issueNumber, marker);
		if (existing) return { commentId: existing.id, url: existing.html_url, recovered: true };
		const response = await this.#request(`/repos/${repository}/issues/${issueNumber}/comments`, {
			method: 'POST', body: JSON.stringify({ body: `${body}\n\n${marker}` }),
		});
		const created = v.parse(CreatedCommentSchema, await this.#responseJson(response, 'GitHub comment creation'));
		return { commentId: created.id, url: created.html_url, recovered: false };
	}

	async #findComment(repository: string, issueNumber: number, marker: string): Promise<{ id: number; html_url?: string } | undefined> {
		const first = await this.#request(`/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=1`, { method: 'GET' });
		const lastPage = parseLastPage(first.headers.get('link'));
		if (lastPage > MAX_COMMENT_PAGES) throw new GitHubActionPolicyBlockedError(`Comment reconciliation exceeds ${MAX_COMMENT_PAGES * 100} comments`);
		for (let page = lastPage; page >= 1; page -= 1) {
			const response = page === 1 ? first : await this.#request(`/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`, { method: 'GET' });
			const comments = await this.#responseJson(response, 'GitHub comment reconciliation') as Array<{ id: number; html_url?: string; body?: string }>;
			const found = comments.find((comment) => comment.body?.includes(marker));
			if (found) return found;
		}
		return undefined;
	}

	async #request(path: string, options: { method: string; body?: string; allowNotFound?: boolean }): Promise<Response> {
		const response = await this.#authority.request(path as `/${string}`, {
			method: options.method,
			headers: {
				...(options.body ? { 'content-type': 'application/json' } : {}),
			},
			body: options.body,
		});
		if (!response.ok && !(options.allowNotFound && response.status === 404)) {
			throw new GitHubActionUpstreamError(`GitHub ${options.method} request failed with HTTP ${response.status}`);
		}
		return response;
	}

	async #responseJson(response: Response, label: string): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			throw new GitHubActionUpstreamError(`${label} returned invalid JSON`);
		}
	}
}

export interface GitHubIssueActionServiceOptions {
	path?: string;
	now?: () => Date;
	installationAuthority?: GitHubInstallationAuthority;
	repository?: (id: string) => RepositoryContract | undefined;
}

export class GitHubIssueActionService {
	readonly #db: Database.Database;
	readonly #now: () => Date;
	readonly #authority: GitHubInstallationAuthority;
	readonly #repository: (id: string) => RepositoryContract | undefined;

	constructor(options: GitHubIssueActionServiceOptions = {}) {
		const path = options.path ?? dataPath('bobsled.db');
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#now = options.now ?? (() => new Date());
		this.#authority = options.installationAuthority ?? githubInstallationAuthority;
		this.#repository = options.repository ?? getRepository;
		this.#migrate();
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS github_issue_actions (
				id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
				status TEXT NOT NULL, repository_id TEXT NOT NULL, issue_number INTEGER NOT NULL, kind TEXT NOT NULL,
				request_json TEXT NOT NULL, marker TEXT, blocked_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
				lease_expires_at TEXT, result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				UNIQUE(owner_id, idempotency_key)
			);
			CREATE INDEX IF NOT EXISTS github_issue_actions_status_idx ON github_issue_actions(status, updated_at);
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, datetime('now'));
		`);
	}

	admit(input: unknown, principal: Principal, idempotencyKey: string): GitHubIssueActionRecord {
		const request = v.parse(GitHubIssueActionRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded Idempotency-Key is required');
		const repository = this.#repository(request.repositoryId);
		if (!repository) throw new GitHubActionNotFoundError(`Repository is not enrolled: ${request.repositoryId}`);
		const requestHash = hash(request);
		return this.#db.transaction(() => {
			const existing = this.#db.prepare('SELECT id, request_sha256 FROM github_issue_actions WHERE owner_id = ? AND idempotency_key = ?').get(principal.id, idempotencyKey) as { id: string; request_sha256: string } | undefined;
			if (existing) {
				if (existing.request_sha256 !== requestHash) throw new GitHubActionConflictError('Idempotency key was already used for different input');
				return this.get(existing.id, principal);
			}
			const id = randomUUID();
			const timestamp = this.#now().toISOString();
			const blockedReason = policyBlock(repository);
			const marker = request.kind === 'comment' ? `<!-- bobsled-action:${id} -->` : null;
			this.#db.prepare(`INSERT INTO github_issue_actions
				(id, owner_id, idempotency_key, request_sha256, status, repository_id, issue_number, kind,
				 request_json, marker, blocked_reason, attempt_count, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
				id, principal.id, idempotencyKey, requestHash, blockedReason ? 'blocked' : 'pending',
				request.repositoryId, request.issueNumber, request.kind, json(request), marker, blockedReason ?? null, timestamp, timestamp,
			);
			return this.get(id, principal);
		})();
	}

	list(principal: Principal): GitHubIssueActionRecord[] {
		return (this.#db.prepare('SELECT * FROM github_issue_actions WHERE owner_id = ? ORDER BY created_at DESC').all(principal.id) as ActionRow[]).map(record);
	}

	get(id: string, principal: Principal): GitHubIssueActionRecord {
		const row = this.#db.prepare('SELECT * FROM github_issue_actions WHERE id = ?').get(id) as ActionRow | undefined;
		if (!row) throw new GitHubActionNotFoundError('GitHub issue action not found');
		if (row.owner_id !== principal.id) throw new GitHubActionForbiddenError('GitHub issue action belongs to another principal');
		return record(row);
	}

	async execute(id: string, principal: Principal): Promise<GitHubIssueActionRecord> {
		const action = this.get(id, principal);
		if (action.status === 'succeeded') return action;
		const repository = this.#repository(action.request.repositoryId);
		if (!repository) throw new GitHubActionNotFoundError(`Repository is not enrolled: ${action.request.repositoryId}`);
		const blockedReason = policyBlock(repository);
		if (blockedReason) {
			this.#db.prepare("UPDATE github_issue_actions SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?")
				.run(blockedReason, this.#now().toISOString(), id);
			throw new GitHubActionPolicyBlockedError(blockedReason);
		}
		const now = this.#now();
		const claimed = this.#db.prepare(`UPDATE github_issue_actions SET status = 'running', blocked_reason = NULL,
			attempt_count = attempt_count + 1, lease_expires_at = ?, error = NULL, updated_at = ?
			WHERE id = ? AND owner_id = ? AND (status IN ('pending','failed','blocked') OR (status = 'running' AND lease_expires_at <= ?))`).run(
			new Date(now.getTime() + ACTION_LEASE_MS).toISOString(), now.toISOString(), id, principal.id, now.toISOString(),
		);
		if (claimed.changes !== 1) throw new GitHubActionConflictError('GitHub issue action is already running');
		try {
			const result = await this.#authority.withRequest(action.request.repositoryId, 'issue_metadata_write', async (authority) => {
				const client = new ScopedGitHubIssueClient(authority);
				if (action.request.kind === 'set_triage_label') {
					return client.setTriageLabel(action.request.repositoryId, action.request.issueNumber, action.request.label);
				}
				return client.comment(action.request.repositoryId, action.request.issueNumber, action.request.body, action.marker!);
			});
			this.#db.prepare(`UPDATE github_issue_actions SET status = 'succeeded', result_json = ?, error = NULL,
				lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(json(result), this.#now().toISOString(), id);
			return this.get(id, principal);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'GitHub issue action failed';
			this.#db.prepare(`UPDATE github_issue_actions SET status = 'failed', error = ?, lease_expires_at = NULL,
				updated_at = ? WHERE id = ?`).run(message, this.#now().toISOString(), id);
			throw error;
		}
	}
}

export const githubIssueActions = new GitHubIssueActionService();
