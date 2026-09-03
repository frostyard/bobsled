import type Database from 'better-sqlite3';

export function ensurePublicationRecoveryResolutionSchema(database: Database.Database): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS publication_recovery_resolutions (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			source_publication_id TEXT NOT NULL, superseding_publication_id TEXT NOT NULL, repository_id TEXT NOT NULL,
			disposition TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key), UNIQUE(source_publication_id)
		);
		CREATE INDEX IF NOT EXISTS publication_recovery_resolutions_owner_idx ON publication_recovery_resolutions(owner_id, created_at);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (25, datetime('now'));
	`);
}
