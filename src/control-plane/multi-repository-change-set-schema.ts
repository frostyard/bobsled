import type Database from 'better-sqlite3';

export function ensureMultiRepositoryChangeSetSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS multi_repository_change_sets (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			plan_sha256 TEXT NOT NULL, plan_json TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key), UNIQUE(owner_id, plan_sha256)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_change_set_members (
			change_set_id TEXT NOT NULL, repository_id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
			unit_sha256 TEXT NOT NULL, unit_json TEXT NOT NULL,
			policy_snapshot_sha256 TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
			PRIMARY KEY(change_set_id, repository_id), UNIQUE(change_set_id, run_id), UNIQUE(change_set_id, job_id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id),
			FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(job_id) REFERENCES jobs(id)
		);
		CREATE INDEX IF NOT EXISTS multi_repository_change_sets_owner_created_idx
			ON multi_repository_change_sets(owner_id, created_at DESC);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (26, datetime('now'));
	`);
}
