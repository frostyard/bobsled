import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { RepositoryDriftObservationIntegrityError, RepositoryDriftObservationStore } from '../src/control-plane/repository-drift-observation-store.ts';
import { RepositoryEnrollmentStore } from '../src/control-plane/repository-enrollment-store.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const repository = getRepository('frostyard/frostyard-org')!;
const principal = { id: 'github:1' };
const checkedAt = '2026-09-04T12:00:00.000Z';

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-drift-observations-'));
	const path = join(directory, 'bobsled.db');
	const enrollments = new RepositoryEnrollmentStore(path, () => new Date(checkedAt), [repository]);
	const policySha256 = enrollments.get(repository.id)!.policySha256;
	const store = new RepositoryDriftObservationStore(path);
	const record = {
		repositoryId: repository.id, status: 'aligned' as const, checkedAt, policyDigest: policySha256,
		policy: { enabled: true, readOnly: repository.readOnly, executionEnabled: repository.executionPolicy.enabled, reviewEnabled: repository.reviewPolicy.enabled, publicationEnabled: repository.publicationPolicy.enabled, multiWorkerEnabled: repository.multiWorkerPolicy.enabled },
		findings: [],
	};
	return { directory, path, enrollments, store, record };
}

test('retains idempotent version-bound drift observations and rejects tampering', () => {
	const { directory, path, enrollments, store, record } = fixture();
	try {
		const first = store.record([{ record, enrollmentVersion: 1 }], principal, 'check-1');
		const replay = store.record([{ record, enrollmentVersion: 1 }], principal, 'check-1');
		assert.equal(replay[0]?.id, first[0]?.id);
		assert.equal(store.replay(principal, 'check-1')?.[0]?.id, first[0]?.id);
		assert.equal(store.replay(principal, 'unused'), undefined);
		assert.equal(store.count(repository.id), 1);
		assert.equal(store.latest()[0]?.record.status, 'aligned');
		const db = new Database(path);
		db.prepare("UPDATE repository_drift_observations SET record_json=json_set(record_json,'$.status','drifted')").run();
		db.close();
		assert.throws(() => store.latest(), RepositoryDriftObservationIntegrityError);
	} finally { store.close(); enrollments.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reports open non-archived runs whose policy snapshot differs from current enrollment', () => {
	const { directory, path, enrollments, store } = fixture();
	const ledger = new JobLedger(path, () => new Date(checkedAt), () => repository);
	try {
		const run = ledger.admit({ repositoryId: repository.id, workItem: { source: 'manual', key: 'manual:drift', title: 'Drift impact', body: '', labels: [] }, triageDecision: { route: 'needs_spec', risk: 'low', confidence: 0.9, summary: 'Specification is incomplete.', rationale: 'A decision is still required.', acceptanceCriteria: ['Capture the decision.'], missingInformation: ['Which behavior is intended?'], suggestedLabels: ['bobsled:needs-spec'], eligibleForOneClick: false } }, principal, 'run-1');
		const updated = enrollments.record({ repository: { ...repository, executionPolicy: { ...repository.executionPolicy, maxFiles: repository.executionPolicy.maxFiles + 1 } }, expectedVersion: 1, reason: 'Tighten the reviewed policy' }, principal, 'policy-2');
		assert.deepEqual(store.policyImpact(repository.id, updated.policySha256), { changedOpenRunCount: 1, byStatus: { pending: 0, running: 0, succeeded: 0, blocked: 1 }, sampleRunIds: [run.id], truncated: false });
		ledger.archive(run.id, { expectedVersion: run.version, reason: 'Retire the fixture' }, principal);
		assert.equal(store.policyImpact(repository.id, updated.policySha256).changedOpenRunCount, 0);
	} finally { ledger.close(); store.close(); enrollments.close(); rmSync(directory, { recursive: true, force: true }); }
});
