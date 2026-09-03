import type Database from 'better-sqlite3';

export function ensurePublicationRebaseSchema(database: Database.Database): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS publication_rebases (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			source_publication_id TEXT NOT NULL, repository_id TEXT NOT NULL, status TEXT NOT NULL,
			old_base_commit TEXT NOT NULL, new_base_commit TEXT, approved_patch_sha256 TEXT NOT NULL, replayed_patch_sha256 TEXT,
			source_changed_paths_json TEXT NOT NULL, replayed_changed_paths_json TEXT NOT NULL DEFAULT '[]', conflict_paths_json TEXT NOT NULL DEFAULT '[]', workspace_path TEXT,
			preparation_json TEXT, gates_json TEXT NOT NULL DEFAULT '[]', block_reason TEXT, detail TEXT, reason TEXT NOT NULL,
			lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS publication_rebases_one_active_source_idx ON publication_rebases(source_publication_id) WHERE status IN ('pending', 'running');
		CREATE UNIQUE INDEX IF NOT EXISTS publication_rebases_one_validated_source_idx ON publication_rebases(source_publication_id) WHERE status = 'validated';
		CREATE INDEX IF NOT EXISTS publication_rebases_owner_status_idx ON publication_rebases(owner_id, status, updated_at);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (22, datetime('now'));
	`);
}
