import type Database from 'better-sqlite3';

export function ensureIntakeConversationSchema(db:Database.Database):void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS intake_conversations (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, repository_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, status TEXT NOT NULL,
			version INTEGER NOT NULL, seed_json TEXT NOT NULL, current_brief_sha256 TEXT NOT NULL,
			current_brief_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			terminal_reason TEXT,
			UNIQUE(owner_id, idempotency_key)
		);
		CREATE INDEX IF NOT EXISTS intake_conversations_owner_updated_idx
			ON intake_conversations(owner_id, updated_at DESC);
		CREATE TABLE IF NOT EXISTS intake_conversation_turns (
			id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, sequence INTEGER NOT NULL,
			role TEXT NOT NULL, text TEXT NOT NULL, brief_sha256 TEXT NOT NULL, brief_json TEXT NOT NULL,
			created_at TEXT NOT NULL, UNIQUE(conversation_id, idempotency_key), UNIQUE(conversation_id, sequence),
			FOREIGN KEY(conversation_id) REFERENCES intake_conversations(id)
		);
		CREATE TABLE IF NOT EXISTS intake_conversation_revisions (
			id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, base_version INTEGER NOT NULL,
			operator_turn_id TEXT NOT NULL, status TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0,
			reason TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
			assistant_turn_id TEXT, error TEXT, result_sha256 TEXT, result_json TEXT,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(conversation_id) REFERENCES intake_conversations(id),
			FOREIGN KEY(operator_turn_id) REFERENCES intake_conversation_turns(id),
			FOREIGN KEY(assistant_turn_id) REFERENCES intake_conversation_turns(id)
		);
		CREATE INDEX IF NOT EXISTS intake_conversation_revisions_conversation_status_idx
			ON intake_conversation_revisions(conversation_id, status);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (41, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (42, datetime('now'));
	`);
}
