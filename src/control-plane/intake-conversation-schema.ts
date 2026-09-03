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
		CREATE TABLE IF NOT EXISTS intake_brief_snapshots (
			id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, source_version INTEGER NOT NULL,
			source_turn_count INTEGER NOT NULL, source_turns_sha256 TEXT NOT NULL, source_turns_json TEXT NOT NULL,
			brief_sha256 TEXT NOT NULL, brief_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(conversation_id) REFERENCES intake_conversations(id)
		);
		CREATE INDEX IF NOT EXISTS intake_brief_snapshots_owner_created_idx
			ON intake_brief_snapshots(owner_id, created_at DESC);
		CREATE TABLE IF NOT EXISTS intake_snapshot_triages (
			id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, brief_sha256 TEXT NOT NULL,
			repository_sha256 TEXT NOT NULL, repository_json TEXT NOT NULL, status TEXT NOT NULL,
			model_calls INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, result_sha256 TEXT,
			result_json TEXT, error TEXT, supersedes_triage_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(snapshot_id) REFERENCES intake_brief_snapshots(id),
			FOREIGN KEY(supersedes_triage_id) REFERENCES intake_snapshot_triages(id)
		);
		CREATE INDEX IF NOT EXISTS intake_snapshot_triages_owner_created_idx
			ON intake_snapshot_triages(owner_id, created_at DESC);
		CREATE UNIQUE INDEX IF NOT EXISTS intake_snapshot_triages_one_model_call_idx
			ON intake_snapshot_triages(snapshot_id) WHERE model_calls=1;
		CREATE TABLE IF NOT EXISTS intake_snapshot_run_admissions (
			id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, triage_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, repository_sha256 TEXT NOT NULL,
			work_item_sha256 TEXT NOT NULL, work_item_json TEXT NOT NULL, triage_result_sha256 TEXT NOT NULL,
			status TEXT NOT NULL, run_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(snapshot_id) REFERENCES intake_brief_snapshots(id),
			FOREIGN KEY(triage_id) REFERENCES intake_snapshot_triages(id),
			FOREIGN KEY(run_id) REFERENCES runs(id)
		);
		CREATE INDEX IF NOT EXISTS intake_snapshot_run_admissions_owner_created_idx
			ON intake_snapshot_run_admissions(owner_id, created_at DESC);
		CREATE TABLE IF NOT EXISTS intake_conversation_supersessions (
			id TEXT PRIMARY KEY, source_conversation_id TEXT NOT NULL, source_snapshot_id TEXT NOT NULL,
			conversation_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
			request_sha256 TEXT NOT NULL, source_brief_sha256 TEXT NOT NULL, source_seed_sha256 TEXT NOT NULL,
			reason TEXT NOT NULL, previous_supersession_id TEXT, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(source_conversation_id) REFERENCES intake_conversations(id),
			FOREIGN KEY(source_snapshot_id) REFERENCES intake_brief_snapshots(id),
			FOREIGN KEY(conversation_id) REFERENCES intake_conversations(id),
			FOREIGN KEY(previous_supersession_id) REFERENCES intake_conversation_supersessions(id)
		);
		CREATE INDEX IF NOT EXISTS intake_conversation_supersessions_source_idx
			ON intake_conversation_supersessions(source_snapshot_id, created_at DESC);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (41, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (42, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (43, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (44, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (45, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (46, datetime('now'));
	`);
}
