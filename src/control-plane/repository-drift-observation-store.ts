import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryDriftRecordSchema, type RepositoryDriftRecord } from './repository-drift.ts';
import { RepositoryIdSchema } from './contracts.ts';

const PrincipalSchema = v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) });
const ObservationSchema = v.object({ record: RepositoryDriftRecordSchema, enrollmentVersion: v.pipe(v.number(), v.integer(), v.minValue(1)) });

interface ObservationRow {
	id: string; batch_id: string; repository_id: string; enrollment_version: number; policy_sha256: string;
	record_sha256: string; record_json: string; actor_id: string; idempotency_key: string; request_sha256: string; created_at: string;
}

export interface RepositoryDriftObservation {
	id: string; batchId: string; repositoryId: string; enrollmentVersion: number; record: RepositoryDriftRecord; createdAt: string;
}

export class RepositoryDriftObservationConflictError extends Error {}
export class RepositoryDriftObservationIntegrityError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function ensureRepositoryDriftObservationSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS repository_drift_observations (
			id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, repository_id TEXT NOT NULL, enrollment_version INTEGER NOT NULL,
			policy_sha256 TEXT NOT NULL, record_sha256 TEXT NOT NULL, record_json TEXT NOT NULL,
			actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(actor_id,idempotency_key,repository_id)
		);
		CREATE INDEX IF NOT EXISTS repository_drift_observations_repository_idx
			ON repository_drift_observations(repository_id,created_at DESC,id DESC);
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (48,datetime('now'));
	`);
}

export class RepositoryDriftObservationStore {
	readonly #db: Database.Database;
	constructor(path = dataPath('bobsled.db')) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		ensureRepositoryDriftObservationSchema(this.#db);
	}
	close(): void { this.#db.close(); }

	replay(principal: { id: string }, idempotencyKey: string): RepositoryDriftObservation[] | undefined {
		const actor = v.parse(PrincipalSchema, principal);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new RepositoryDriftObservationConflictError('A bounded Idempotency-Key is required');
		const rows = this.#db.prepare('SELECT * FROM repository_drift_observations WHERE actor_id=? AND idempotency_key=? ORDER BY repository_id').all(actor.id, idempotencyKey) as ObservationRow[];
		return rows.length ? rows.map((row) => this.#read(row)) : undefined;
	}

	record(records: unknown[], principal: { id: string }, idempotencyKey: string): RepositoryDriftObservation[] {
		const actor = v.parse(PrincipalSchema, principal);
		const parsed = v.parse(v.pipe(v.array(ObservationSchema), v.minLength(1), v.maxLength(1_000)), records);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new RepositoryDriftObservationConflictError('A bounded Idempotency-Key is required');
		const repositoryIds = parsed.map(({ record }) => record.repositoryId);
		if (new Set(repositoryIds).size !== repositoryIds.length) throw new RepositoryDriftObservationConflictError('A drift batch cannot repeat a repository');
		const requestSha256 = digest(parsed);
		return this.#db.transaction(() => {
			const replay = this.#db.prepare('SELECT * FROM repository_drift_observations WHERE actor_id=? AND idempotency_key=? ORDER BY repository_id').all(actor.id, idempotencyKey) as ObservationRow[];
			if (replay.length) {
				if (replay.some((row) => row.request_sha256 !== requestSha256) || replay.length !== parsed.length) throw new RepositoryDriftObservationConflictError('Idempotency key was already used for different drift input');
				return replay.map((row) => this.#read(row));
			}
			const batchId = randomUUID();
			for (const item of parsed) {
				const enrollment = this.#db.prepare('SELECT version,policy_sha256 FROM repository_enrollments WHERE repository_id=?').get(item.record.repositoryId) as { version: number; policy_sha256: string } | undefined;
				if (!enrollment || enrollment.version !== item.enrollmentVersion || enrollment.policy_sha256 !== item.record.policyDigest) throw new RepositoryDriftObservationConflictError(`Repository enrollment changed during drift check: ${item.record.repositoryId}`);
				const id = randomUUID();
				this.#db.prepare('INSERT INTO repository_drift_observations (id,batch_id,repository_id,enrollment_version,policy_sha256,record_sha256,record_json,actor_id,idempotency_key,request_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,batchId,item.record.repositoryId,item.enrollmentVersion,item.record.policyDigest,digest(item.record),JSON.stringify(item.record),actor.id,idempotencyKey,requestSha256,item.record.checkedAt);
			}
			return this.#db.prepare('SELECT * FROM repository_drift_observations WHERE batch_id=? ORDER BY repository_id').all(batchId).map((row) => this.#read(row as ObservationRow));
		}).immediate();
	}

	latest(repositoryId?: string): RepositoryDriftObservation[] {
		if (repositoryId) v.parse(RepositoryIdSchema, repositoryId);
		const rows = this.#db.prepare(`SELECT o.* FROM repository_drift_observations o
			JOIN (SELECT repository_id,MAX(rowid) AS rowid FROM repository_drift_observations GROUP BY repository_id) latest ON latest.rowid=o.rowid
			${repositoryId ? 'WHERE o.repository_id=?' : ''} ORDER BY o.repository_id`).all(...(repositoryId ? [repositoryId] : [])) as ObservationRow[];
		return rows.map((row) => this.#read(row));
	}

	count(repositoryId: string): number {
		v.parse(RepositoryIdSchema, repositoryId);
		return (this.#db.prepare('SELECT COUNT(*) AS count FROM repository_drift_observations WHERE repository_id=?').get(repositoryId) as { count: number }).count;
	}

	policyImpact(repositoryId: string, currentPolicyDigest: string) {
		v.parse(RepositoryIdSchema, repositoryId);
		const hasPublications = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='draft_publications'").get());
		const hasRecoveryResolutions = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publication_recovery_resolutions'").get());
		const rows = this.#db.prepare(`SELECT DISTINCT r.id,r.status,j.policy_snapshot_json,
			(SELECT a.outcome_json FROM attempts a WHERE a.job_id=j.id ORDER BY a.number DESC LIMIT 1) AS outcome_json,
			${hasPublications ? "EXISTS (SELECT 1 FROM draft_publications terminal_publication WHERE terminal_publication.run_id=r.id AND terminal_publication.status IN ('merged','closed'))" : '0'} AS terminal_publication,
			${hasPublications && hasRecoveryResolutions ? 'EXISTS (SELECT 1 FROM draft_publications source_publication JOIN publication_recovery_resolutions resolution ON resolution.source_publication_id=source_publication.id WHERE source_publication.run_id=r.id)' : '0'} AS recovery_resolved
			FROM runs r JOIN jobs j ON j.run_id=r.id
			WHERE j.repository_id=? AND r.status IN ('pending','running','succeeded','blocked')
			AND NOT EXISTS (SELECT 1 FROM audit_events archived WHERE archived.run_id=r.id AND archived.type='run.archived'
				AND archived.sequence>COALESCE((SELECT MAX(restored.sequence) FROM audit_events restored WHERE restored.run_id=r.id AND restored.type='run.restored'),0))
			ORDER BY r.updated_at DESC,r.id`).all(repositoryId) as Array<{ id: string; status: string; policy_snapshot_json: string; outcome_json: string | null; terminal_publication: number; recovery_resolved: number }>;
		const actionable = rows.filter((row) => {
			if (row.terminal_publication || row.recovery_resolved) return false;
			if (row.status !== 'succeeded' || !row.outcome_json) return true;
			try {
				const outcome = JSON.parse(row.outcome_json) as { evidence?: { filesChanged?: unknown }; worker?: { result?: { disposition?: unknown } } };
				return outcome.worker?.result?.disposition !== 'no_change' && outcome.evidence?.filesChanged !== 0;
			} catch { return true; }
		});
		const changed = actionable.filter((row) => { try { return digest(JSON.parse(row.policy_snapshot_json)) !== currentPolicyDigest; } catch { return true; } });
		const byStatus = { pending: 0, running: 0, succeeded: 0, blocked: 0 };
		for (const row of changed) byStatus[row.status as keyof typeof byStatus] += 1;
		return { changedOpenRunCount: changed.length, byStatus, sampleRunIds: changed.slice(0, 20).map(({ id }) => id), truncated: changed.length > 20 };
	}

	#read(row: ObservationRow): RepositoryDriftObservation {
		let record: RepositoryDriftRecord;
		try { record = v.parse(RepositoryDriftRecordSchema, JSON.parse(row.record_json)); } catch { throw new RepositoryDriftObservationIntegrityError('Stored repository drift observation is malformed'); }
		const event = this.#db.prepare('SELECT policy_sha256 FROM repository_enrollment_events WHERE repository_id=? AND version=?').get(row.repository_id,row.enrollment_version) as { policy_sha256: string } | undefined;
		if (!event || event.policy_sha256 !== row.policy_sha256 || record.repositoryId !== row.repository_id || record.policyDigest !== row.policy_sha256 || digest(record) !== row.record_sha256 || record.checkedAt !== row.created_at) throw new RepositoryDriftObservationIntegrityError(`Stored repository drift observation failed verification: ${row.repository_id}`);
		return { id: row.id, batchId: row.batch_id, repositoryId: row.repository_id, enrollmentVersion: row.enrollment_version, record, createdAt: row.created_at };
	}
}

export const repositoryDriftObservationStore = new RepositoryDriftObservationStore();
