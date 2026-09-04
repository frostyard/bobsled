import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import { RepositoryEnrollmentConflictError, RepositoryEnrollmentIntegrityError, RepositoryEnrollmentStore } from '../src/control-plane/repository-enrollment-store.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const seed = getRepository('frostyard/clix')!;
const principal = { id: 'github:operator-1' };

function databasePath(): string {
	const directory = join(tmpdir(), `bobsled-repository-enrollment-${randomUUID()}`);
	mkdirSync(directory, { recursive: true });
	return join(directory, 'registry.db');
}

test('migrates bootstrap declarations exactly once and reloads durable policy', () => {
	const path = databasePath();
	const first = new RepositoryEnrollmentStore(path, () => new Date('2026-09-04T15:00:00Z'), [seed]);
	assert.deepEqual(first.list().map(({ repository, version, action }) => ({ id: repository.id, version, action })), [
		{ id: seed.id, version: 1, action: 'bootstrap' },
	]);
	first.close();

	const reopened = new RepositoryEnrollmentStore(path, () => new Date('2026-09-04T16:00:00Z'), []);
	assert.deepEqual(reopened.get(seed.id)?.repository, seed);
	const db = new Database(path, { readonly: true });
	assert.equal((db.prepare('SELECT COUNT(*) AS count FROM repository_enrollment_events').get() as { count: number }).count, 1);
	assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version=47').get());
	db.close();
	reopened.close();
});

test('records append-only versioned changes with idempotent replay', () => {
	const store = new RepositoryEnrollmentStore(':memory:', () => new Date('2026-09-04T15:00:00Z'), [seed]);
	const disabled = { ...seed, enabled: false } satisfies RepositoryContract;
	const recorded = store.record({ repository: disabled, expectedVersion: 1, reason: 'Pause new work while repository maintenance is in progress' }, principal, 'disable-clix');
	assert.equal(recorded.version, 2);
	assert.equal(recorded.action, 'disabled');
	assert.equal(recorded.repository.enabled, false);
	assert.deepEqual(store.history(seed.id).map(({ version, action }) => ({ version, action })), [
		{ version: 1, action: 'bootstrap' },
		{ version: 2, action: 'disabled' },
	]);
	assert.deepEqual(store.record({ repository: disabled, expectedVersion: 1, reason: 'Pause new work while repository maintenance is in progress' }, principal, 'disable-clix'), recorded);
	assert.throws(
		() => store.record({ repository: seed, expectedVersion: 1, reason: 'Use stale version' }, principal, 'stale-update'),
		RepositoryEnrollmentConflictError,
	);
	assert.throws(
		() => store.record({ repository: { ...disabled, description: 'changed' }, expectedVersion: 1, reason: 'Reuse key' }, principal, 'disable-clix'),
		RepositoryEnrollmentConflictError,
	);
	store.close();
});

test('fails closed when retained current policy evidence is changed', () => {
	const path = databasePath();
	const store = new RepositoryEnrollmentStore(path, undefined, [seed]);
	store.close();
	const database = new Database(path);
	database.prepare('UPDATE repository_enrollments SET policy_json=? WHERE repository_id=?').run(JSON.stringify({ ...seed, description: 'tampered' }), seed.id);
	database.close();
	const reopened = new RepositoryEnrollmentStore(path);
	assert.throws(() => reopened.get(seed.id), RepositoryEnrollmentIntegrityError);
	reopened.close();
});

test('rejects immutable GitHub identity changes while permitting reviewed policy revisions', () => {
	const store = new RepositoryEnrollmentStore(':memory:', undefined, [seed]);
	assert.throws(
		() => store.record({ repository: { ...seed, githubRepositoryId: seed.githubRepositoryId + 1 }, expectedVersion: 1, reason: 'Invalid identity replacement' }, principal, 'replace-identity'),
		RepositoryEnrollmentConflictError,
	);
	const updated = store.record({ repository: { ...seed, description: 'Updated reviewed description' }, expectedVersion: 1, reason: 'Refresh reviewed policy metadata' }, principal, 'policy-update');
	assert.equal(updated.version, 2);
	assert.equal(updated.action, 'policy_updated');
	assert.match(updated.policySha256, /^[a-f0-9]{64}$/);
	store.close();
});

test('serializes competing policy revisions across database connections', () => {
	const path = databasePath();
	const first = new RepositoryEnrollmentStore(path, undefined, [seed]);
	const second = new RepositoryEnrollmentStore(path);
	first.record({ repository: { ...seed, description: 'First reviewed policy' }, expectedVersion: 1, reason: 'First update wins' }, principal, 'first-update');
	assert.throws(
		() => second.record({ repository: { ...seed, description: 'Competing policy' }, expectedVersion: 1, reason: 'Competing stale update' }, principal, 'second-update'),
		RepositoryEnrollmentConflictError,
	);
	assert.equal(second.get(seed.id)?.repository.description, 'First reviewed policy');
	first.close();
	second.close();
});
