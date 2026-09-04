import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { FleetOperationsProjector } from '../src/control-plane/fleet-operations-view.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

test('projects fleet workload, immutable plan quotas, and retention extent without authority', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-fleet-view-'));
	const path = join(root, 'bobsled.db');
	const db = new Database(path);
	const repository = getRepository('frostyard/frostyard-org')!;
	try {
		db.exec(`
			CREATE TABLE runs (id TEXT PRIMARY KEY,status TEXT NOT NULL);
			CREATE TABLE jobs (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,repository_id TEXT NOT NULL);
			CREATE TABLE attempts (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,status TEXT NOT NULL);
			CREATE TABLE reviews (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,status TEXT NOT NULL);
			CREATE TABLE draft_publications (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,status TEXT NOT NULL);
			CREATE TABLE multi_worker_plans (id TEXT PRIMARY KEY,job_id TEXT NOT NULL);
			CREATE TABLE multi_worker_budgets (plan_id TEXT PRIMARY KEY,policy_json TEXT NOT NULL,deadline_at TEXT NOT NULL);
			CREATE TABLE multi_worker_budget_attempts (id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL,model_calls INTEGER NOT NULL);
			CREATE TABLE organization_capacity_claims (id TEXT PRIMARY KEY,status TEXT NOT NULL,openai_codex_slots INTEGER NOT NULL,github_copilot_slots INTEGER NOT NULL,would_exceed_policy INTEGER NOT NULL);
			CREATE TABLE flue_observations (id INTEGER PRIMARY KEY,event_timestamp TEXT NOT NULL,payload_blob BLOB NOT NULL,payload_json TEXT NOT NULL);
			INSERT INTO runs VALUES ('pending','pending'),('active','active');
			INSERT INTO jobs VALUES ('pending-job','pending','${repository.id}'),('active-job','active','${repository.id}');
			INSERT INTO attempts VALUES ('attempt','active-job','running');
			INSERT INTO reviews VALUES ('review','active-job','queued');
			INSERT INTO draft_publications VALUES ('publication','active','checks_pending');
			INSERT INTO multi_worker_plans VALUES ('plan','active-job');
			INSERT INTO organization_capacity_claims VALUES ('claim','active',1,0,1);
			INSERT INTO flue_observations VALUES (1,'2026-09-01T00:00:00.000Z',X'01','{}'),(2,'2026-09-04T00:00:00.000Z',X'0102','{}');
		`);
		const policy = { ...repository.multiWorkerPolicy, enabled: true, maxWorkerAttempts: 4, subscriptionCalls: { openaiCodex: 3, githubCopilot: 2 } };
		db.prepare('INSERT INTO multi_worker_budgets VALUES (?,?,?)').run('plan', JSON.stringify(policy), '2026-09-05T00:00:00.000Z');
		db.prepare('INSERT INTO multi_worker_budget_attempts VALUES (?,?,?,?,?)').run('worker-1','plan','running','openai-codex',1);
		db.prepare('INSERT INTO multi_worker_budget_attempts VALUES (?,?,?,?,?)').run('worker-2','plan','succeeded','github-copilot',1);
	} finally { db.close(); }
	const projector = new FleetOperationsProjector(path, () => new Date('2026-09-04T12:00:00.000Z'));
	try {
		const view = projector.project([repository]);
		assert.equal(view.organization.concurrencyLimitConfigured, false);
		assert.deepEqual(view.organization.workload, { pendingRuns: 1, activeRuns: 1, activeAttempts: 1, activeReviews: 1, activePublications: 1 });
		assert.deepEqual(view.organization.multiWorkerQuota, { activePlans: 1, activeAttempts: 1, workerAttempts: { used: 2, declared: 4 }, subscriptionCalls: { openaiCodex: { used: 1, declared: 3 }, githubCopilot: { used: 1, declared: 2 } } });
		assert.deepEqual(view.organization.capacityUsage, { activeWorkflows: 1, providerCalls: { openaiCodex: 1, githubCopilot: 0 }, wouldExceedPolicyClaims: 1 });
		assert.deepEqual(view.observability, { events: 2, storedBytes: 7, oldestObservedAt: '2026-09-01T00:00:00.000Z', lastObservedAt: '2026-09-04T00:00:00.000Z', retentionMode: 'indefinite' });
	} finally { projector.close(); rmSync(root, { recursive: true, force: true }); }
});
