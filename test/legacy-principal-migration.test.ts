import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
	LegacyPrincipalMigration,
	LegacyPrincipalMigrationError,
} from '../src/control-plane/legacy-principal-migration.ts';

function fixture(): { directory: string; path: string } {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-principal-migration-'));
	const path = join(directory, 'bobsled.db');
	const database = new Database(path);
	database.exec(`
		CREATE TABLE operator_sessions (
			token_sha256 TEXT PRIMARY KEY, github_user_id INTEGER NOT NULL, github_login TEXT NOT NULL,
			organization TEXT NOT NULL, organization_role TEXT NOT NULL, created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT
		);
		CREATE TABLE runs (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL,
			request_hash TEXT NOT NULL, supersedes_run_id TEXT, version INTEGER NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id, idempotency_key)
		);
		CREATE TABLE audit_events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
			job_id TEXT, actor_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id)
		);
		CREATE TABLE github_issue_actions (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key)
		);
		CREATE TABLE draft_publications (
			id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key)
		);
	`);
	return { directory, path };
}

test('atomically transfers legacy local history to the sole active GitHub principal with audit evidence', () => {
	const { directory, path } = fixture();
	const database = new Database(path);
	database.prepare(`INSERT INTO operator_sessions VALUES
		('token', 42, 'operator', 'frostyard', 'admin', ?, ?, ?, NULL)`).run(
		'2026-09-02T12:00:00.000Z', '2026-09-03T12:00:00.000Z', '2026-09-02T12:00:00.000Z',
	);
	for (const [id, key] of [['run-one', 'one'], ['run-two', 'two']]) {
		database.prepare(`INSERT INTO runs VALUES (?, 'local-operator', 'blocked', ?, 'hash', NULL, 3, ?, ?)`).run(
			id, key, '2026-09-02T12:00:00.000Z', '2026-09-02T12:00:00.000Z',
		);
	}
	database.prepare("INSERT INTO github_issue_actions VALUES ('action', 'local-operator', 'action-key')").run();
	database.prepare("INSERT INTO draft_publications VALUES ('publication', 'local-operator', 'publication-key')").run();
	database.close();

	const migration = new LegacyPrincipalMigration(path, () => new Date('2026-09-02T13:00:00.000Z'));
	try {
		assert.throws(() => migration.migrate(false), LegacyPrincipalMigrationError);
		assert.deepEqual(migration.migrate(true), {
			targetPrincipalId: 'github:42', runsTransferred: 2, issueActionsTransferred: 1, publicationsTransferred: 1,
		});
		assert.deepEqual(migration.migrate(true), {
			targetPrincipalId: 'github:42', runsTransferred: 0, issueActionsTransferred: 0, publicationsTransferred: 0,
		});
	} finally {
		migration.close();
	}

	const proof = new Database(path, { readonly: true });
	try {
		assert.equal((proof.prepare("SELECT COUNT(*) AS count FROM runs WHERE owner_id = 'github:42'").get() as { count: number }).count, 2);
		assert.equal((proof.prepare("SELECT COUNT(*) AS count FROM github_issue_actions WHERE owner_id = 'github:42'").get() as { count: number }).count, 1);
		assert.equal((proof.prepare("SELECT COUNT(*) AS count FROM draft_publications WHERE owner_id = 'github:42'").get() as { count: number }).count, 1);
		const events = proof.prepare("SELECT actor_id, type, payload_json FROM audit_events ORDER BY sequence").all() as Array<Record<string, string>>;
		assert.equal(events.length, 2);
		assert.equal(events[0]?.actor_id, 'system:operator-auth-cutover');
		assert.equal(events[0]?.type, 'run.owner_transferred');
		assert.deepEqual(JSON.parse(events[0]?.payload_json ?? '{}'), {
			fromOwnerId: 'local-operator', toOwnerId: 'github:42', reason: 'GitHub operator authentication cutover',
		});
	} finally {
		proof.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('refuses ambiguous active users without partial transfer', () => {
	const { directory, path } = fixture();
	const database = new Database(path);
	const insertSession = database.prepare(`INSERT INTO operator_sessions VALUES
		(?, ?, ?, 'frostyard', 'member', ?, ?, ?, NULL)`);
	for (const [token, id] of [['one', 42], ['two', 43]] as const) {
		insertSession.run(token, id, `operator-${id}`, '2026-09-02T12:00:00.000Z', '2026-09-03T12:00:00.000Z', '2026-09-02T12:00:00.000Z');
	}
	database.prepare("INSERT INTO runs VALUES ('run', 'local-operator', 'blocked', 'same-key', 'hash', NULL, 1, ?, ?)").run(
		'2026-09-02T12:00:00.000Z', '2026-09-02T12:00:00.000Z',
	);
	database.close();

	const migration = new LegacyPrincipalMigration(path, () => new Date('2026-09-02T13:00:00.000Z'));
	try {
		assert.throws(() => migration.migrate(true), /exactly one active GitHub principal/);
	} finally {
		migration.close();
	}

	const proof = new Database(path, { readonly: true });
	try {
		assert.equal((proof.prepare("SELECT owner_id FROM runs WHERE id = 'run'").get() as { owner_id: string }).owner_id, 'local-operator');
		assert.equal((proof.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count, 0);
	} finally {
		proof.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('refuses an ownership idempotency collision without partial transfer', () => {
	const { directory, path } = fixture();
	const database = new Database(path);
	database.prepare(`INSERT INTO operator_sessions VALUES
		('token', 42, 'operator', 'frostyard', 'admin', ?, ?, ?, NULL)`).run(
		'2026-09-02T12:00:00.000Z', '2026-09-03T12:00:00.000Z', '2026-09-02T12:00:00.000Z',
	);
	const insertRun = database.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)');
	insertRun.run('legacy-run', 'local-operator', 'blocked', 'same-key', 'legacy-hash', '2026-09-02T12:00:00.000Z', '2026-09-02T12:00:00.000Z');
	insertRun.run('github-run', 'github:42', 'pending', 'same-key', 'github-hash', '2026-09-02T12:00:00.000Z', '2026-09-02T12:00:00.000Z');
	database.close();

	const migration = new LegacyPrincipalMigration(path, () => new Date('2026-09-02T13:00:00.000Z'));
	try {
		assert.throws(() => migration.migrate(true), /Idempotency conflict/);
	} finally {
		migration.close();
	}

	const proof = new Database(path, { readonly: true });
	try {
		assert.equal((proof.prepare("SELECT owner_id FROM runs WHERE id = 'legacy-run'").get() as { owner_id: string }).owner_id, 'local-operator');
		assert.equal((proof.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count, 0);
	} finally {
		proof.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
