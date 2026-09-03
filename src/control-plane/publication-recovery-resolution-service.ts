import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import type { Principal } from './ledger.ts';
import {
	PublicationRecoveryResolutionRecordSchema,
	PublicationRecoveryResolutionRequestSchema,
	type PublicationRecoveryResolutionRecord,
} from './publication-recovery-resolution-contracts.ts';
import { ensurePublicationRecoveryResolutionSchema } from './publication-recovery-resolution-schema.ts';
import { ensurePublicationRebaseSchema } from './publication-rebase-schema.ts';
import { getRepository } from './repositories.ts';

export class PublicationRecoveryResolutionConflictError extends Error {}
export class PublicationRecoveryResolutionForbiddenError extends Error {}

interface ResolutionRow {
	id: string; owner_id: string; idempotency_key: string; request_sha256: string; source_publication_id: string;
	superseding_publication_id: string; repository_id: string; disposition: string; reason: string; created_at: string;
}

interface PublicationRow {
	id: string; owner_id: string; run_id: string; repository_id: string; status: string; title: string;
	blocked_reason: string | null; commit_sha: string | null; pull_number: number | null; created_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function rowToRecord(row: ResolutionRow): PublicationRecoveryResolutionRecord {
	return v.parse(PublicationRecoveryResolutionRecordSchema, {
		id: row.id, ownerId: row.owner_id, sourcePublicationId: row.source_publication_id,
		supersedingPublicationId: row.superseding_publication_id, repositoryId: row.repository_id,
		disposition: row.disposition, modelCalls: 0, githubMutations: 0, reason: row.reason, createdAt: row.created_at,
	});
}

export class PublicationRecoveryResolutionService {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path); if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#now = now; this.#migrate();
	}

	close(): void { this.#db.close(); }

	admit(input: unknown, principal: Principal, idempotencyKey: string): PublicationRecoveryResolutionRecord {
		const request = v.parse(PublicationRecoveryResolutionRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new PublicationRecoveryResolutionConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
		const existing = this.#db.prepare('SELECT * FROM publication_recovery_resolutions WHERE owner_id = ? AND idempotency_key = ?').get(principal.id, idempotencyKey) as ResolutionRow | undefined;
		if (existing) {
			if (existing.request_sha256 !== requestSha256) throw new PublicationRecoveryResolutionConflictError('Idempotency key was already used for different input');
			return rowToRecord(existing);
		}
		const source = this.#publication(request.sourcePublicationId, principal);
		const target = this.#publication(request.supersedingPublicationId, principal);
		const repository = getRepository(source.repository_id);
		if (source.id === target.id || source.run_id === target.run_id || source.repository_id !== target.repository_id || source.title !== target.title) {
			throw new PublicationRecoveryResolutionConflictError('Superseding publication must be a distinct publication for the same repository and task title');
		}
		if (!repository || source.status !== 'blocked' || source.blocked_reason !== `Remote ${repository.defaultBranch} moved beyond the approved base commit` || source.commit_sha !== null || source.pull_number !== null) {
			throw new PublicationRecoveryResolutionConflictError('Only a side-effect-free stale-base publication can be superseded');
		}
		if (target.status !== 'merged' || target.pull_number === null || target.created_at <= source.created_at) {
			throw new PublicationRecoveryResolutionConflictError('Superseding publication must be a later merged pull request');
		}
		const rebase = this.#db.prepare("SELECT status, block_reason FROM publication_rebases WHERE source_publication_id = ? ORDER BY created_at DESC LIMIT 1").get(source.id) as { status: string; block_reason: string | null } | undefined;
		if (!rebase || rebase.status !== 'blocked' || rebase.block_reason !== 'patch_conflict') throw new PublicationRecoveryResolutionConflictError('Supersession requires retained zero-model patch-conflict evidence');
		const id = randomUUID(); const createdAt = this.#now().toISOString();
		try {
			this.#db.prepare(`INSERT INTO publication_recovery_resolutions
				(id, owner_id, idempotency_key, request_sha256, source_publication_id, superseding_publication_id, repository_id, disposition, reason, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'superseded_by_merged_publication', ?, ?)`).run(
				id, principal.id, idempotencyKey, requestSha256, source.id, target.id, source.repository_id, request.reason, createdAt,
			);
		} catch (error) {
			if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new PublicationRecoveryResolutionConflictError('This stale publication already has a terminal recovery resolution');
			throw error;
		}
		return rowToRecord(this.#db.prepare('SELECT * FROM publication_recovery_resolutions WHERE id = ?').get(id) as ResolutionRow);
	}

	list(principal: Principal): PublicationRecoveryResolutionRecord[] {
		return (this.#db.prepare('SELECT * FROM publication_recovery_resolutions WHERE owner_id = ? ORDER BY created_at DESC').all(principal.id) as ResolutionRow[]).map(rowToRecord);
	}

	#publication(id: string, principal: Principal): PublicationRow {
		const row = this.#db.prepare('SELECT id, owner_id, run_id, repository_id, status, title, blocked_reason, commit_sha, pull_number, created_at FROM draft_publications WHERE id = ?').get(id) as PublicationRow | undefined;
		if (!row) throw new PublicationRecoveryResolutionConflictError('Publication evidence was not found');
		if (row.owner_id !== principal.id) throw new PublicationRecoveryResolutionForbiddenError('Publication evidence belongs to another principal');
		return row;
	}

	#migrate(): void {
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensurePublicationRebaseSchema(this.#db); ensurePublicationRecoveryResolutionSchema(this.#db);
	}
}

export const publicationRecoveryResolutions = new PublicationRecoveryResolutionService();
