import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { RepositoryContractSchema, type RepositoryContract } from './contracts.ts';
import { dataPath } from '../paths.ts';

const PrincipalSchema = v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) });
const RecordRequestSchema = v.object({
	repository: RepositoryContractSchema,
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(0)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export interface RepositoryEnrollmentRecord {
	repository: RepositoryContract;
	version: number;
	policySha256: string;
	action: 'enrolled' | 'policy_updated' | 'enabled' | 'disabled' | 'bootstrap';
	actorId: string;
	reason: string;
	createdAt: string;
}

interface CurrentRow {
	repository_id: string;
	github_repository_id: number;
	version: number;
	policy_sha256: string;
	policy_json: string;
	created_at: string;
	updated_at: string;
}

interface EventRow extends CurrentRow {
	action: RepositoryEnrollmentRecord['action'];
	actor_id: string;
	idempotency_key: string;
	request_sha256: string;
	reason: string;
}

export class RepositoryEnrollmentConflictError extends Error {}
export class RepositoryEnrollmentIntegrityError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function parseRepository(json: string): RepositoryContract {
	return v.parse(RepositoryContractSchema, JSON.parse(json));
}

function toRecord(row: EventRow): RepositoryEnrollmentRecord {
	const repository = parseRepository(row.policy_json);
	if (repository.id !== row.repository_id || repository.githubRepositoryId !== row.github_repository_id || digest(repository) !== row.policy_sha256) {
		throw new RepositoryEnrollmentIntegrityError(`Repository enrollment evidence is inconsistent: ${row.repository_id}`);
	}
	return {
		repository,
		version: row.version,
		policySha256: row.policy_sha256,
		action: row.action,
		actorId: row.actor_id,
		reason: row.reason,
		createdAt: row.created_at,
	};
}

export function ensureRepositoryEnrollmentSchema(
	db: Database.Database,
	bootstrap: readonly RepositoryContract[],
	now: () => Date = () => new Date(),
): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS repository_enrollments (
			repository_id TEXT PRIMARY KEY,
			github_repository_id INTEGER NOT NULL UNIQUE,
			version INTEGER NOT NULL,
			policy_sha256 TEXT NOT NULL,
			policy_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS repository_enrollment_events (
			id TEXT PRIMARY KEY,
			repository_id TEXT NOT NULL,
			github_repository_id INTEGER NOT NULL,
			version INTEGER NOT NULL,
			actor_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			request_sha256 TEXT NOT NULL,
			action TEXT NOT NULL CHECK(action IN ('enrolled','policy_updated','enabled','disabled','bootstrap')),
			policy_sha256 TEXT NOT NULL,
			policy_json TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(repository_id, version),
			UNIQUE(actor_id, idempotency_key)
		);
		CREATE INDEX IF NOT EXISTS repository_enrollment_events_repository_idx
			ON repository_enrollment_events(repository_id, version DESC);
	`);
	if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=47').get()) return;
	db.transaction(() => {
		if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=47').get()) return;
		const timestamp = now().toISOString();
		const insertCurrent = db.prepare('INSERT INTO repository_enrollments (repository_id,github_repository_id,version,policy_sha256,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
		const insertEvent = db.prepare("INSERT INTO repository_enrollment_events (id,repository_id,github_repository_id,version,actor_id,idempotency_key,request_sha256,action,policy_sha256,policy_json,reason,created_at) VALUES (?,?,?,?,?,?,?,'bootstrap',?,?,?,?)");
		for (const candidate of bootstrap) {
			const repository = v.parse(RepositoryContractSchema, candidate);
			const json = JSON.stringify(repository);
			const sha = digest(repository);
			insertCurrent.run(repository.id, repository.githubRepositoryId, 1, sha, json, timestamp, timestamp);
			insertEvent.run(randomUUID(), repository.id, repository.githubRepositoryId, 1, 'system:bootstrap', `bootstrap:${repository.id}`, sha, sha, json, 'Migrate the reviewed source declaration into durable enrollment', timestamp);
		}
		db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (47,?)').run(timestamp);
	}).immediate();
}

export class RepositoryEnrollmentStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date(), bootstrap: readonly RepositoryContract[] = []) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#now = now;
		ensureRepositoryEnrollmentSchema(this.#db, bootstrap, now);
	}

	close(): void { this.#db.close(); }

	list(): RepositoryEnrollmentRecord[] {
		const rows = this.#db.prepare(`
			SELECT c.*, e.action, e.actor_id, e.reason
			FROM repository_enrollments c
			JOIN repository_enrollment_events e ON e.repository_id=c.repository_id AND e.version=c.version
			ORDER BY c.rowid
		`).all() as EventRow[];
		return rows.map(toRecord);
	}

	get(repositoryId: string): RepositoryEnrollmentRecord | undefined {
		const row = this.#db.prepare(`
			SELECT c.*, e.action, e.actor_id, e.reason
			FROM repository_enrollments c
			JOIN repository_enrollment_events e ON e.repository_id=c.repository_id AND e.version=c.version
			WHERE c.repository_id=?
		`).get(repositoryId) as EventRow | undefined;
		return row && toRecord(row);
	}

	history(repositoryId: string): RepositoryEnrollmentRecord[] {
		const rows = this.#db.prepare('SELECT * FROM repository_enrollment_events WHERE repository_id=? ORDER BY version').all(repositoryId) as EventRow[];
		return rows.map(toRecord);
	}

	record(input: unknown, principal: { id: string }, idempotencyKey: string): RepositoryEnrollmentRecord {
		const request = v.parse(RecordRequestSchema, input);
		const actor = v.parse(PrincipalSchema, principal);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new RepositoryEnrollmentConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		return this.#db.transaction(() => {
			const replay = this.#db.prepare('SELECT * FROM repository_enrollment_events WHERE actor_id=? AND idempotency_key=?').get(actor.id, idempotencyKey) as EventRow | undefined;
			if (replay) {
				if (replay.request_sha256 !== requestSha256) throw new RepositoryEnrollmentConflictError('Idempotency key was already used for different enrollment input');
				return toRecord(replay);
			}
			const current = this.#db.prepare('SELECT * FROM repository_enrollments WHERE repository_id=?').get(request.repository.id) as CurrentRow | undefined;
			if ((current?.version ?? 0) !== request.expectedVersion) throw new RepositoryEnrollmentConflictError('Repository enrollment changed; reload before updating it');
			if (current && current.github_repository_id !== request.repository.githubRepositoryId) {
				throw new RepositoryEnrollmentConflictError('Immutable GitHub repository identity cannot change through a policy update');
			}
			const identityOwner = this.#db.prepare('SELECT repository_id FROM repository_enrollments WHERE github_repository_id=?').get(request.repository.githubRepositoryId) as { repository_id: string } | undefined;
			if (identityOwner && identityOwner.repository_id !== request.repository.id) {
				throw new RepositoryEnrollmentConflictError('GitHub repository identity is already enrolled under another name');
			}
			const version = (current?.version ?? 0) + 1;
			const action: RepositoryEnrollmentRecord['action'] = !current ? 'enrolled' :
				parseRepository(current.policy_json).enabled !== request.repository.enabled ? (request.repository.enabled ? 'enabled' : 'disabled') : 'policy_updated';
			const timestamp = this.#now().toISOString();
			const policyJson = JSON.stringify(request.repository);
			const policySha256 = digest(request.repository);
			if (current) {
				const changed = this.#db.prepare('UPDATE repository_enrollments SET version=?,policy_sha256=?,policy_json=?,updated_at=? WHERE repository_id=? AND version=?').run(version, policySha256, policyJson, timestamp, request.repository.id, request.expectedVersion);
				if (changed.changes !== 1) throw new RepositoryEnrollmentConflictError('Repository enrollment update raced with another process');
			} else {
				this.#db.prepare('INSERT INTO repository_enrollments (repository_id,github_repository_id,version,policy_sha256,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(request.repository.id, request.repository.githubRepositoryId, version, policySha256, policyJson, timestamp, timestamp);
			}
			const id = randomUUID();
			this.#db.prepare('INSERT INTO repository_enrollment_events (id,repository_id,github_repository_id,version,actor_id,idempotency_key,request_sha256,action,policy_sha256,policy_json,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, request.repository.id, request.repository.githubRepositoryId, version, actor.id, idempotencyKey, requestSha256, action, policySha256, policyJson, request.reason, timestamp);
			return toRecord(this.#db.prepare('SELECT * FROM repository_enrollment_events WHERE id=?').get(id) as EventRow);
		}).immediate();
	}
}
