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
		CREATE TABLE IF NOT EXISTS multi_repository_change_set_authorizations (
			id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, plan_sha256 TEXT NOT NULL,
			member_set_sha256 TEXT NOT NULL, members_json TEXT NOT NULL, reason TEXT NOT NULL,
			status TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id)
		);
		CREATE INDEX IF NOT EXISTS multi_repository_change_set_authorizations_owner_created_idx
			ON multi_repository_change_set_authorizations(owner_id, created_at DESC);
		CREATE TABLE IF NOT EXISTS multi_repository_change_set_schedules (
			id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL UNIQUE, change_set_id TEXT NOT NULL,
			owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			plan_sha256 TEXT NOT NULL, authorization_member_set_sha256 TEXT NOT NULL,
			dependency_layers_json TEXT NOT NULL, scheduled_member_set_sha256 TEXT NOT NULL,
			reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(authorization_id) REFERENCES multi_repository_change_set_authorizations(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_change_set_schedule_members (
			schedule_id TEXT NOT NULL, repository_id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
			unit_sha256 TEXT NOT NULL, layer_index INTEGER NOT NULL, state TEXT NOT NULL,
			policy_snapshot_sha256 TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
			PRIMARY KEY(schedule_id, repository_id), UNIQUE(schedule_id, run_id), UNIQUE(schedule_id, job_id),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(job_id) REFERENCES jobs(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_member_preparation_leases (
			id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, change_set_id TEXT NOT NULL,
			repository_id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, unit_sha256 TEXT NOT NULL,
			policy_snapshot_sha256 TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL,
			reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key), UNIQUE(schedule_id, repository_id),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id),
			FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(job_id) REFERENCES jobs(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_member_preparations (
			lease_id TEXT PRIMARY KEY, result_sha256 TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
			FOREIGN KEY(lease_id) REFERENCES multi_repository_member_preparation_leases(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_member_execution_reservations (
			id TEXT PRIMARY KEY, lease_id TEXT NOT NULL UNIQUE, schedule_id TEXT NOT NULL, change_set_id TEXT NOT NULL,
			repository_id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, preparation_result_sha256 TEXT NOT NULL,
			policy_snapshot_sha256 TEXT NOT NULL, policy_snapshot_json TEXT NOT NULL,
			base_commit TEXT NOT NULL, workspace_path TEXT NOT NULL, evidence_path TEXT NOT NULL,
			reason TEXT NOT NULL, status TEXT NOT NULL, worker_calls INTEGER NOT NULL DEFAULT 0,
			attempt_id TEXT, attempt_number INTEGER, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(lease_id) REFERENCES multi_repository_member_preparation_leases(id),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id),
			FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(job_id) REFERENCES jobs(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_member_execution_preflights (
			reservation_id TEXT PRIMARY KEY, result_sha256 TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
			FOREIGN KEY(reservation_id) REFERENCES multi_repository_member_execution_reservations(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_verification_plans (
			id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL UNIQUE, change_set_id TEXT NOT NULL,
			owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			member_evidence_sha256 TEXT NOT NULL, result_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
			reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_verification_authorizations (
			id TEXT PRIMARY KEY, verification_plan_id TEXT NOT NULL UNIQUE, schedule_id TEXT NOT NULL,
			change_set_id TEXT NOT NULL, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
			request_sha256 TEXT NOT NULL, verification_plan_sha256 TEXT NOT NULL,
			gate_set_sha256 TEXT NOT NULL, gates_json TEXT NOT NULL, reason TEXT NOT NULL,
			status TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(verification_plan_id) REFERENCES multi_repository_verification_plans(id),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_compatibility_executions (
			id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL UNIQUE, verification_plan_id TEXT NOT NULL,
			schedule_id TEXT NOT NULL, change_set_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, authorization_sha256 TEXT NOT NULL,
			gate_set_sha256 TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
			commands_started INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
			result_sha256 TEXT, result_json TEXT,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(authorization_id) REFERENCES multi_repository_verification_authorizations(id),
			FOREIGN KEY(verification_plan_id) REFERENCES multi_repository_verification_plans(id),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_compatibility_preflights (
			execution_id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY(execution_id) REFERENCES multi_repository_compatibility_executions(id)
		);
		CREATE TABLE IF NOT EXISTS multi_repository_publication_authorizations (
			id TEXT PRIMARY KEY, compatibility_execution_id TEXT NOT NULL UNIQUE,
			verification_plan_id TEXT NOT NULL, schedule_id TEXT NOT NULL, change_set_id TEXT NOT NULL,
			owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
			compatibility_result_sha256 TEXT NOT NULL, member_set_sha256 TEXT NOT NULL,
			members_json TEXT NOT NULL, rollout_layers_json TEXT NOT NULL, rollback_layers_json TEXT NOT NULL,
			reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(compatibility_execution_id) REFERENCES multi_repository_compatibility_executions(id),
			FOREIGN KEY(verification_plan_id) REFERENCES multi_repository_verification_plans(id),
			FOREIGN KEY(schedule_id) REFERENCES multi_repository_change_set_schedules(id),
			FOREIGN KEY(change_set_id) REFERENCES multi_repository_change_sets(id)
		);
		CREATE INDEX IF NOT EXISTS multi_repository_publication_authorizations_owner_created_idx
			ON multi_repository_publication_authorizations(owner_id, created_at DESC);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (26, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (27, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (28, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (29, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (30, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (31, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (32, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (33, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (34, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (35, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (36, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (37, datetime('now'));
	`);
	const leaseColumns = new Set((db.prepare('PRAGMA table_info(multi_repository_member_preparation_leases)').all() as Array<{ name: string }>).map(({ name }) => name));
	if (!leaseColumns.has('started_at')) db.exec('ALTER TABLE multi_repository_member_preparation_leases ADD COLUMN started_at TEXT');
	if (!leaseColumns.has('finished_at')) db.exec('ALTER TABLE multi_repository_member_preparation_leases ADD COLUMN finished_at TEXT');
	const executionColumns = new Set((db.prepare('PRAGMA table_info(multi_repository_member_execution_reservations)').all() as Array<{ name: string }>).map(({ name }) => name));
	if (!executionColumns.has('worker_calls')) db.exec('ALTER TABLE multi_repository_member_execution_reservations ADD COLUMN worker_calls INTEGER NOT NULL DEFAULT 0');
	if (!executionColumns.has('attempt_id')) db.exec('ALTER TABLE multi_repository_member_execution_reservations ADD COLUMN attempt_id TEXT');
	if (!executionColumns.has('attempt_number')) db.exec('ALTER TABLE multi_repository_member_execution_reservations ADD COLUMN attempt_number INTEGER');
	if (!executionColumns.has('started_at')) db.exec('ALTER TABLE multi_repository_member_execution_reservations ADD COLUMN started_at TEXT');
	if (!executionColumns.has('finished_at')) db.exec('ALTER TABLE multi_repository_member_execution_reservations ADD COLUMN finished_at TEXT');
	db.exec(`
		DROP INDEX IF EXISTS one_reserved_multi_repository_member_per_schedule;
		CREATE UNIQUE INDEX IF NOT EXISTS one_active_multi_repository_member_per_schedule
			ON multi_repository_member_preparation_leases(schedule_id)
			WHERE status IN ('reserved', 'preparing', 'prepared');
	`);
}
