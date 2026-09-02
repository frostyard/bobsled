import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { dataPath } from '../paths.ts';
import { REQUIRED_GITHUB_ORGANIZATION } from './operator-auth.ts';

const LEGACY_LOCAL_PRINCIPAL = 'local-operator';
const MIGRATION_ACTOR = 'system:operator-auth-cutover';

interface ActiveSessionRow {
	github_user_id: number;
	expires_at: string;
}

interface OwnedRunRow {
	id: string;
}

export interface LegacyPrincipalMigrationResult {
	targetPrincipalId: string;
	runsTransferred: number;
	issueActionsTransferred: number;
	publicationsTransferred: number;
}

export class LegacyPrincipalMigrationError extends Error {}

export class LegacyPrincipalMigration {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		this.#db = new Database(path);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('busy_timeout = 5000');
		this.#now = now;
	}

	close(): void {
		this.#db.close();
	}

	migrate(confirmSingleActiveGitHubUser: boolean): LegacyPrincipalMigrationResult {
		if (!confirmSingleActiveGitHubUser) {
			throw new LegacyPrincipalMigrationError('Explicit single-active-GitHub-user confirmation is required');
		}
		for (const table of ['operator_sessions', 'runs', 'audit_events']) {
			if (!this.#tableExists(table)) throw new LegacyPrincipalMigrationError(`Required table is missing: ${table}`);
		}

		const now = this.#now();
		const activeUserIds = new Set((this.#db.prepare(`SELECT github_user_id, expires_at FROM operator_sessions
			WHERE organization = ? AND revoked_at IS NULL`).all(REQUIRED_GITHUB_ORGANIZATION) as ActiveSessionRow[])
			.filter(({ expires_at }) => new Date(expires_at).getTime() > now.getTime())
			.map(({ github_user_id }) => github_user_id));
		if (activeUserIds.size !== 1) {
			throw new LegacyPrincipalMigrationError(`Expected exactly one active GitHub principal; found ${activeUserIds.size}`);
		}
		const [githubUserId] = activeUserIds;
		const targetPrincipalId = `github:${githubUserId}`;
		const ownedRuns = this.#db.prepare('SELECT id FROM runs WHERE owner_id = ? ORDER BY created_at').all(LEGACY_LOCAL_PRINCIPAL) as OwnedRunRow[];
		const issueActions = this.#ownedCount('github_issue_actions');
		const publications = this.#ownedCount('draft_publications');

		for (const table of ['runs', 'github_issue_actions', 'draft_publications']) {
			if (!this.#tableExists(table)) continue;
			const conflict = this.#db.prepare(`SELECT 1 FROM ${table} legacy JOIN ${table} target
				ON target.owner_id = ? AND target.idempotency_key = legacy.idempotency_key
				WHERE legacy.owner_id = ? LIMIT 1`).get(targetPrincipalId, LEGACY_LOCAL_PRINCIPAL);
			if (conflict) throw new LegacyPrincipalMigrationError(`Idempotency conflict prevents ownership transfer in ${table}`);
		}

		this.#db.transaction(() => {
			this.#db.prepare('UPDATE runs SET owner_id = ? WHERE owner_id = ?').run(targetPrincipalId, LEGACY_LOCAL_PRINCIPAL);
			if (this.#tableExists('github_issue_actions')) {
				this.#db.prepare('UPDATE github_issue_actions SET owner_id = ? WHERE owner_id = ?').run(targetPrincipalId, LEGACY_LOCAL_PRINCIPAL);
			}
			if (this.#tableExists('draft_publications')) {
				this.#db.prepare('UPDATE draft_publications SET owner_id = ? WHERE owner_id = ?').run(targetPrincipalId, LEGACY_LOCAL_PRINCIPAL);
			}
			const insertAudit = this.#db.prepare(`INSERT INTO audit_events
				(id, run_id, job_id, actor_id, type, payload_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`);
			for (const { id } of ownedRuns) {
				insertAudit.run(
					randomUUID(), id, MIGRATION_ACTOR, 'run.owner_transferred',
					JSON.stringify({ fromOwnerId: LEGACY_LOCAL_PRINCIPAL, toOwnerId: targetPrincipalId, reason: 'GitHub operator authentication cutover' }),
					now.toISOString(),
				);
			}
		})();

		return {
			targetPrincipalId,
			runsTransferred: ownedRuns.length,
			issueActionsTransferred: issueActions,
			publicationsTransferred: publications,
		};
	}

	#tableExists(table: string): boolean {
		return Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
	}

	#ownedCount(table: string): number {
		if (!this.#tableExists(table)) return 0;
		return Number((this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ?`).get(LEGACY_LOCAL_PRINCIPAL) as { count: number }).count);
	}
}
