import type Database from 'better-sqlite3';

export function ensurePublicationRebaseReviewSchema(database: Database.Database): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS publication_rebase_reviews (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			rebase_id TEXT NOT NULL, source_publication_id TEXT NOT NULL, repository_id TEXT NOT NULL, status TEXT NOT NULL,
			base_commit TEXT NOT NULL, patch_sha256 TEXT NOT NULL, changed_paths_json TEXT NOT NULL, workspace_path TEXT NOT NULL,
			repository_context_path TEXT, report_json TEXT, conversation_id TEXT, submission_id TEXT,
			model_calls INTEGER NOT NULL DEFAULT 0, block_reason TEXT, detail TEXT, lease_expires_at TEXT,
			reason TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS publication_rebase_reviews_one_model_attempt_idx
			ON publication_rebase_reviews(rebase_id) WHERE status IN ('pending', 'preparing', 'running', 'approved') OR model_calls = 1;
		CREATE INDEX IF NOT EXISTS publication_rebase_reviews_owner_status_idx ON publication_rebase_reviews(owner_id, status, updated_at);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (23, datetime('now'));
	`);
}
