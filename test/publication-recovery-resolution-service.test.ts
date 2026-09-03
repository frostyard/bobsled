import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { PublicationRebaseService } from '../src/control-plane/publication-rebase-service.ts';
import { DraftPublicationService } from '../src/control-plane/publication-service.ts';
import {
	PublicationRecoveryResolutionConflictError,
	PublicationRecoveryResolutionForbiddenError,
	PublicationRecoveryResolutionService,
} from '../src/control-plane/publication-recovery-resolution-service.ts';

const principal = { id: 'operator:recovery-resolution' };

function fixture() {
	const path = join(mkdtempSync(join(tmpdir(), 'bobsled-recovery-resolution-')), 'bobsled.db');
	new DraftPublicationService({ path }).close(); new PublicationRebaseService({ path }).close();
	const database = new Database(path); const sourceId = randomUUID(); const targetId = randomUUID();
	const runId = randomUUID(); const targetRunId = randomUUID(); const jobId = randomUUID(); const attemptId = randomUUID(); const reviewId = randomUUID();
	const insert = database.prepare(`INSERT INTO draft_publications
		(id, owner_id, idempotency_key, request_sha256, run_id, run_version, job_id, attempt_id, review_id, repository_id,
		 status, base_commit, approved_patch_sha256, branch_name, title, body, marker, required_checks_json, reason,
		 blocked_reason, attempt_count, checks_json, commit_sha, pull_number, pull_url, pull_state, pull_draft, pull_merged_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'frostyard/frostyard-org', ?, ?, ?, ?, ?, 'body', ?, '["verify"]', 'reason', ?, 0, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`);
	insert.run(sourceId, principal.id, 'source', 'a'.repeat(64), runId, jobId, attemptId, reviewId, 'blocked', 'b'.repeat(40), 'c'.repeat(64), 'bobsled/stale', 'Add canonical metadata', '<!-- source -->', 'Remote main moved beyond the approved base commit', null, null, null, null, null, null, '2026-09-03T10:00:00.000Z', '2026-09-03T10:00:00.000Z');
	insert.run(targetId, principal.id, 'target', 'd'.repeat(64), targetRunId, jobId, attemptId, reviewId, 'merged', 'e'.repeat(40), 'f'.repeat(64), 'bobsled/retry', 'Add canonical metadata', '<!-- target -->', null, '1'.repeat(40), 7, 'https://github.com/frostyard/frostyard-org/pull/7', 'closed', 0, '2026-09-03T10:06:00.000Z', '2026-09-03T10:05:00.000Z', '2026-09-03T10:06:00.000Z');
	database.prepare(`INSERT INTO publication_rebases
		(id, owner_id, idempotency_key, request_sha256, source_publication_id, repository_id, status, old_base_commit,
		 approved_patch_sha256, source_changed_paths_json, replayed_changed_paths_json, conflict_paths_json, gates_json,
		 block_reason, detail, reason, created_at, updated_at)
		VALUES (?, ?, 'rebase', ?, ?, 'frostyard/frostyard-org', 'blocked', ?, ?, '["src/layouts/Site.astro"]', '[]', '["src/layouts/Site.astro"]', '[]', 'patch_conflict', 'conflict', 'reason', ?, ?)`).run(
		randomUUID(), principal.id, '9'.repeat(64), sourceId, 'b'.repeat(40), 'c'.repeat(64), '2026-09-03T10:02:00.000Z', '2026-09-03T10:03:00.000Z',
	);
	database.close(); return { path, sourceId, targetId };
}

test('records immutable supersession of a stale conflict by a later merged publication', () => {
	const value = fixture(); const service = new PublicationRecoveryResolutionService(value.path, () => new Date('2026-09-03T10:10:00.000Z'));
	try {
		const request = { sourcePublicationId: value.sourceId, supersedingPublicationId: value.targetId, reason: 'The later human-merged publication delivered the same task.' };
		const record = service.admit(request, principal, 'resolution');
		assert.equal(record.disposition, 'superseded_by_merged_publication'); assert.equal(record.modelCalls, 0); assert.equal(record.githubMutations, 0);
		assert.equal(service.admit(request, principal, 'resolution').id, record.id); assert.equal(service.list(principal).length, 1);
		const database = new Database(value.path, { readonly: true });
		assert.equal((database.prepare('SELECT status FROM draft_publications WHERE id = ?').get(value.sourceId) as { status: string }).status, 'blocked');
		assert.equal((database.prepare('SELECT status FROM publication_rebases WHERE source_publication_id = ?').get(value.sourceId) as { status: string }).status, 'blocked');
		database.close();
		assert.throws(() => service.admit({ ...request, reason: 'Changed idempotent input must be rejected.' }, principal, 'resolution'), /different input/);
		assert.throws(() => service.admit(request, { id: 'another' }, 'other-owner'), PublicationRecoveryResolutionForbiddenError);
	} finally { service.close(); }
});
