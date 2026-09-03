import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import {
	AdmitRunRequestSchema,
	CancelRunRequestSchema,
	HumanOverrideRequestSchema,
	RunRecordSchema,
	type RunRecord,
} from './ledger-contracts.ts';
import {
	ExecutionAuthorizationRequestSchema,
	ReviewAuthorizationRequestSchema,
	type ExecutionAuthorizationRequest,
	type ReviewAuthorizationRequest,
	type ReviewReport,
} from './execution-contracts.ts';
import {
	RepositoryContractSchema,
	type RepositoryContract,
	type TriageDecision,
	type WorkItem,
} from './contracts.ts';
import { getRepository } from './repositories.ts';
import { projectReviewForOperator } from './operator-review-view.ts';
import { ensureIntegrationInvocationSchema } from './integration-invocation-store.ts';
import { ensureIntegrationConflictAgentInvocationSchema } from './integration-conflict-agent-invocation-store.ts';
import { ensureMultiWorkerBudgetSchema } from './multi-worker-budget-store.ts';
import { ensurePublicationRebaseSchema } from './publication-rebase-schema.ts';
import { dataPath } from '../paths.ts';

export interface Principal {
	id: string;
}

export class LedgerConflictError extends Error {}
export class LedgerNotFoundError extends Error {}
export class LedgerForbiddenError extends Error {}

export interface AuthorizedExecution {
	runId: string;
	jobId: string;
	attemptId: string;
	attemptNumber: number;
	repository: RepositoryContract;
	workItem: WorkItem;
	triageDecision?: TriageDecision;
}

export interface AuthorizedReview {
	runId: string;
	jobId: string;
	attemptId: string;
	attemptNumber: number;
	reviewId: string;
	reviewNumber: number;
	actorId: string;
	repository: RepositoryContract;
	workItem: WorkItem;
}

export interface ExecutionArtifactInput {
	kind: string;
	uri: string;
	digest?: string;
	metadata: Record<string, unknown>;
}

interface OwnedRunRow {
	id: string;
	owner_id: string;
	status: string;
	supersedes_run_id: string | null;
	version: number;
	created_at: string;
	updated_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function json(value: unknown): string {
	return JSON.stringify(canonical(value));
}

function hash(value: unknown): string {
	return createHash('sha256').update(json(value)).digest('hex');
}

function optionalJson(value: string | null): unknown | undefined {
	return value === null ? undefined : JSON.parse(value);
}

export class JobLedger {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#now = now;
		this.#migrate();
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL,
				idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, supersedes_run_id TEXT,
				version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				UNIQUE(owner_id, idempotency_key), FOREIGN KEY(supersedes_run_id) REFERENCES runs(id)
			);
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY, run_id TEXT NOT NULL, repository_id TEXT NOT NULL, status TEXT NOT NULL,
				policy_snapshot_json TEXT NOT NULL, work_item_snapshot_json TEXT NOT NULL,
				triage_decision_json TEXT, current_attempt INTEGER NOT NULL DEFAULT 0,
				version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(id)
			);
			CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY, job_id TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL,
				started_at TEXT, finished_at TEXT, outcome_json TEXT,
				UNIQUE(job_id, number), FOREIGN KEY(job_id) REFERENCES jobs(id)
			);
			CREATE TABLE IF NOT EXISTS artifacts (
				id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT, kind TEXT NOT NULL,
				uri TEXT NOT NULL, digest TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
				FOREIGN KEY(job_id) REFERENCES jobs(id), FOREIGN KEY(attempt_id) REFERENCES attempts(id)
			);
			CREATE TABLE IF NOT EXISTS reviews (
				id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
				number INTEGER NOT NULL, status TEXT NOT NULL,
				initial_verdict_json TEXT, final_verdict_json TEXT, outcome_json TEXT,
				started_at TEXT, finished_at TEXT,
				UNIQUE(job_id, attempt_id, number), FOREIGN KEY(job_id) REFERENCES jobs(id),
				FOREIGN KEY(attempt_id) REFERENCES attempts(id)
			);
			CREATE TABLE IF NOT EXISTS approvals (
				id TEXT PRIMARY KEY, run_id TEXT NOT NULL, job_id TEXT, kind TEXT NOT NULL,
				actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(job_id) REFERENCES jobs(id)
			);
			CREATE TABLE IF NOT EXISTS audit_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
				job_id TEXT, actor_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(job_id) REFERENCES jobs(id)
			);
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
		`);
		ensureIntegrationInvocationSchema(this.#db);
		ensureIntegrationConflictAgentInvocationSchema(this.#db);
		ensureMultiWorkerBudgetSchema(this.#db);
		ensurePublicationRebaseSchema(this.#db);
	}

	admit(input: unknown, principal: Principal, idempotencyKey: string): RunRecord {
		const request = v.parse(AdmitRunRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded Idempotency-Key is required');
		const repository = getRepository(request.repositoryId);
		if (!repository) throw new LedgerNotFoundError(`Repository is not enrolled: ${request.repositoryId}`);
		const requestHash = hash(request);

		return this.#db.transaction(() => {
			const existing = this.#db.prepare('SELECT id, request_hash FROM runs WHERE owner_id = ? AND idempotency_key = ?').get(principal.id, idempotencyKey) as { id: string; request_hash: string } | undefined;
			if (existing) {
				if (existing.request_hash !== requestHash) throw new LedgerConflictError('Idempotency key was already used for different input');
				return this.get(existing.id, principal);
			}

			if (request.supersedesRunId) {
				const prior = this.#ownedRun(request.supersedesRunId, principal);
				if (!['blocked', 'cancelled', 'failed'].includes(prior.status)) throw new LedgerConflictError('Only blocked, cancelled, or failed runs may be superseded');
			}

			const runId = randomUUID();
			const jobId = randomUUID();
			const timestamp = this.#now().toISOString();
			const blocked = request.triageDecision !== undefined && request.triageDecision.route !== 'ready_for_agent';
			this.#db.prepare(`INSERT INTO runs
				(id, owner_id, status, idempotency_key, request_hash, supersedes_run_id, version, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
				.run(runId, principal.id, blocked ? 'blocked' : 'pending', idempotencyKey, requestHash, request.supersedesRunId ?? null, timestamp, timestamp);
			this.#db.prepare(`INSERT INTO jobs
				(id, run_id, repository_id, status, policy_snapshot_json, work_item_snapshot_json, triage_decision_json, current_attempt, version, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`)
				.run(jobId, runId, repository.id, blocked ? 'blocked' : 'admitted', json(repository), json(request.workItem), request.triageDecision ? json(request.triageDecision) : null, timestamp, timestamp);
			this.#audit(runId, jobId, principal.id, 'run.admitted', { blocked, supersedesRunId: request.supersedesRunId ?? null }, timestamp);
			return this.get(runId, principal);
		})();
	}

	list(principal: Principal): RunRecord[] {
		const rows = this.#db.prepare('SELECT id FROM runs WHERE owner_id = ? ORDER BY created_at DESC').all(principal.id) as Array<{ id: string }>;
		return rows.map(({ id }) => this.get(id, principal));
	}

	get(runId: string, principal: Principal): RunRecord {
		const run = this.#ownedRun(runId, principal);
		const jobs = this.#db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at, id').all(runId) as Array<Record<string, unknown>>;
		const attempts = this.#db.prepare('SELECT attempts.* FROM attempts JOIN jobs ON jobs.id = attempts.job_id WHERE jobs.run_id = ? ORDER BY attempts.number').all(runId) as Array<Record<string, unknown>>;
		const artifacts = this.#db.prepare('SELECT artifacts.* FROM artifacts JOIN jobs ON jobs.id = artifacts.job_id WHERE jobs.run_id = ? ORDER BY artifacts.created_at, artifacts.id').all(runId) as Array<Record<string, unknown>>;
		const reviews = this.#db.prepare('SELECT reviews.* FROM reviews JOIN jobs ON jobs.id = reviews.job_id WHERE jobs.run_id = ? ORDER BY reviews.number').all(runId) as Array<Record<string, unknown>>;
		const approvals = this.#db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at, id').all(runId) as Array<Record<string, unknown>>;
		const audit = this.#db.prepare('SELECT * FROM audit_events WHERE run_id = ? ORDER BY sequence').all(runId) as Array<Record<string, unknown>>;
		return v.parse(RunRecordSchema, {
			id: run.id,
			ownerId: run.owner_id,
			status: run.status,
			supersedesRunId: run.supersedes_run_id ?? undefined,
			version: run.version,
			createdAt: run.created_at,
			updatedAt: run.updated_at,
			jobs: jobs.map((job) => ({
				id: job.id, runId: job.run_id, repositoryId: job.repository_id, status: job.status,
				policySnapshot: JSON.parse(job.policy_snapshot_json as string),
				workItemSnapshot: JSON.parse(job.work_item_snapshot_json as string),
				triageDecision: optionalJson(job.triage_decision_json as string | null),
				currentAttempt: job.current_attempt, version: job.version,
				attempts: attempts.filter((attempt) => attempt.job_id === job.id).map((attempt) => ({
					id: attempt.id, jobId: attempt.job_id, number: attempt.number, status: attempt.status,
					startedAt: attempt.started_at ?? undefined, finishedAt: attempt.finished_at ?? undefined,
					outcome: optionalJson(attempt.outcome_json as string | null),
				})),
				reviews: reviews.filter((review) => review.job_id === job.id).map((review) => {
					const initialVerdict = optionalJson(review.initial_verdict_json as string | null);
					const finalVerdict = optionalJson(review.final_verdict_json as string | null);
					const outcome = optionalJson(review.outcome_json as string | null);
					const status = review.status as 'queued' | 'running' | 'approved' | 'blocked' | 'failed';
					return {
						id: review.id, jobId: review.job_id, attemptId: review.attempt_id,
						number: review.number, status, initialVerdict, finalVerdict, outcome,
						operatorView: projectReviewForOperator({ status, initialVerdict, finalVerdict, outcome }),
						startedAt: review.started_at ?? undefined, finishedAt: review.finished_at ?? undefined,
					};
				}),
				artifacts: artifacts.filter((artifact) => artifact.job_id === job.id).map((artifact) => ({
					id: artifact.id, jobId: artifact.job_id, attemptId: artifact.attempt_id ?? undefined,
					kind: artifact.kind, uri: artifact.uri, digest: artifact.digest ?? undefined,
					metadata: JSON.parse(artifact.metadata_json as string), createdAt: artifact.created_at,
				})),
				createdAt: job.created_at, updatedAt: job.updated_at,
			})),
			approvals: approvals.map((approval) => ({
				id: approval.id, runId: approval.run_id, jobId: approval.job_id ?? undefined,
				kind: approval.kind, actorId: approval.actor_id, reason: approval.reason, createdAt: approval.created_at,
			})),
			audit: audit.map((event) => ({
				sequence: event.sequence, id: event.id, runId: event.run_id,
				jobId: event.job_id ?? undefined, actorId: event.actor_id, type: event.type,
				payload: JSON.parse(event.payload_json as string), createdAt: event.created_at,
			})),
		});
	}

	authorizeExecution(runId: string, input: unknown, principal: Principal): AuthorizedExecution {
		const request: ExecutionAuthorizationRequest = v.parse(ExecutionAuthorizationRequestSchema, input);
		return this.#db.transaction(() => {
			const run = this.#ownedRun(runId, principal);
			if (run.version !== request.expectedVersion) throw new LedgerConflictError('Run changed; reload before authorizing execution');
			if (run.status !== 'pending') throw new LedgerConflictError('Only a pending run can be authorized for execution');
			const job = this.#db.prepare("SELECT * FROM jobs WHERE run_id = ? AND status = 'admitted'").get(runId) as Record<string, unknown> | undefined;
			if (!job) throw new LedgerConflictError('Pending run has no admitted job');
			const repositoryResult = v.safeParse(RepositoryContractSchema, JSON.parse(job.policy_snapshot_json as string));
			if (!repositoryResult.success) {
				throw new LedgerConflictError('Run policy snapshot predates the M3 execution contract; supersede it with a new run');
			}
			const repository = repositoryResult.output;
			if (!repository.capabilities.writeCode || !repository.executionPolicy.enabled) {
				throw new LedgerConflictError('Repository policy does not permit local draft-patch execution');
			}
			const gateIds = new Set(repository.qualityGates.map(({ id }) => id));
			const missingGate = repository.executionPolicy.requiredGateIds.find((id) => !gateIds.has(id));
			if (missingGate) throw new LedgerConflictError(`Repository execution policy references missing gate: ${missingGate}`);
			const timestamp = this.#now().toISOString();
			const attemptNumber = Number(job.current_attempt) + 1;
			const attemptId = randomUUID();
			this.#db.prepare('INSERT INTO attempts (id, job_id, number, status) VALUES (?, ?, ?, ?)')
				.run(attemptId, job.id, attemptNumber, 'queued');
			this.#db.prepare("UPDATE runs SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, runId);
			this.#db.prepare("UPDATE jobs SET status = 'queued', current_attempt = ?, version = version + 1, updated_at = ? WHERE id = ?")
				.run(attemptNumber, timestamp, job.id);
			this.#db.prepare('INSERT INTO approvals (id, run_id, job_id, kind, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(randomUUID(), runId, job.id, 'go_fix', principal.id, request.reason, timestamp);
			this.#audit(runId, String(job.id), principal.id, 'execution.authorized', { attemptId, attemptNumber, reason: request.reason }, timestamp);
			return {
				runId,
				jobId: String(job.id),
				attemptId,
				attemptNumber,
				repository,
				workItem: JSON.parse(job.work_item_snapshot_json as string) as WorkItem,
				triageDecision: optionalJson(job.triage_decision_json as string | null) as TriageDecision | undefined,
			};
		})();
	}

	markExecutionRunning(execution: AuthorizedExecution, principal: Principal): void {
		this.#db.transaction(() => {
			this.#ownedRun(execution.runId, principal);
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare("UPDATE attempts SET status = 'running', started_at = ? WHERE id = ? AND job_id = ? AND status = 'queued'")
				.run(timestamp, execution.attemptId, execution.jobId).changes;
			if (changed !== 1) throw new LedgerConflictError('Execution attempt is not queued');
			this.#db.prepare("UPDATE jobs SET status = 'running', version = version + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, execution.jobId);
			this.#audit(execution.runId, execution.jobId, principal.id, 'execution.started', { attemptId: execution.attemptId }, timestamp);
		})();
	}

	completeExecution(
		execution: AuthorizedExecution,
		status: 'succeeded' | 'blocked' | 'failed',
		outcome: unknown,
		artifacts: ExecutionArtifactInput[],
		principal: Principal,
	): RunRecord {
		return this.#db.transaction(() => {
			this.#ownedRun(execution.runId, principal);
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare("UPDATE attempts SET status = ?, finished_at = ?, outcome_json = ? WHERE id = ? AND job_id = ? AND status IN ('queued','running')")
				.run(status, timestamp, json(outcome), execution.attemptId, execution.jobId).changes;
			if (changed !== 1) throw new LedgerConflictError('Execution attempt is already settled');
			for (const artifact of artifacts) {
				this.#db.prepare('INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
					.run(randomUUID(), execution.jobId, execution.attemptId, artifact.kind, artifact.uri, artifact.digest ?? null, json(artifact.metadata), timestamp);
			}
			this.#db.prepare('UPDATE jobs SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
				.run(status, timestamp, execution.jobId);
			this.#db.prepare('UPDATE runs SET status = ?, version = version + 1, updated_at = ? WHERE id = ?')
				.run(status, timestamp, execution.runId);
			this.#audit(execution.runId, execution.jobId, principal.id, `execution.${status}`, { attemptId: execution.attemptId, artifactKinds: artifacts.map(({ kind }) => kind) }, timestamp);
			return this.get(execution.runId, principal);
		})();
	}

	authorizeReview(runId: string, input: unknown, principal: Principal, trigger: 'operator' | 'policy' = 'operator'): AuthorizedReview {
		const request: ReviewAuthorizationRequest = v.parse(ReviewAuthorizationRequestSchema, input);
		return this.#db.transaction(() => {
			const run = this.#ownedRun(runId, principal);
			if (run.version !== request.expectedVersion) throw new LedgerConflictError('Run changed; reload before authorizing review');
			if (run.status !== 'succeeded') throw new LedgerConflictError('Only a successfully gated draft can enter adversarial review');
			const job = this.#db.prepare("SELECT * FROM jobs WHERE run_id = ? AND status = 'succeeded'").get(runId) as Record<string, unknown> | undefined;
			if (!job) throw new LedgerConflictError('Succeeded run has no succeeded job');
			const repositoryResult = v.safeParse(RepositoryContractSchema, JSON.parse(job.policy_snapshot_json as string));
			if (!repositoryResult.success || !repositoryResult.output.reviewPolicy.enabled) {
				throw new LedgerConflictError('Run policy snapshot predates or disables the M4 review contract; supersede it with a new run');
			}
			const attempt = this.#db.prepare("SELECT id, number, status, outcome_json FROM attempts WHERE job_id = ? ORDER BY number DESC LIMIT 1").get(job.id) as { id: string; number: number; status: string; outcome_json: string | null } | undefined;
			if (!attempt || attempt.status !== 'succeeded') throw new LedgerConflictError('No successful implementation attempt is available for review');
			const outcome = optionalJson(attempt.outcome_json) as { evidence?: { filesChanged?: number } } | undefined;
			if (outcome?.evidence?.filesChanged === 0) throw new LedgerConflictError('Verified no-change runs have no draft patch to review');
			const active = this.#db.prepare("SELECT id FROM reviews WHERE job_id = ? AND attempt_id = ? AND status IN ('queued','running')").get(job.id, attempt.id);
			if (active) throw new LedgerConflictError('An adversarial review is already active for this attempt');
			const approved = this.#db.prepare("SELECT id FROM reviews WHERE job_id = ? AND attempt_id = ? AND status = 'approved'").get(job.id, attempt.id);
			if (approved) throw new LedgerConflictError('This attempt already has an approved adversarial review');
			const settled = this.#db.prepare("SELECT id FROM reviews WHERE job_id = ? AND attempt_id = ? AND status IN ('blocked','failed')").get(job.id, attempt.id);
			if (settled) throw new LedgerConflictError('This attempt already has a settled adversarial review; start a revised run instead of re-reviewing unchanged evidence');
			const latest = this.#db.prepare('SELECT COALESCE(MAX(number), 0) AS number FROM reviews WHERE job_id = ? AND attempt_id = ?').get(job.id, attempt.id) as { number: number };
			const reviewId = randomUUID();
			const reviewNumber = Number(latest.number) + 1;
			const timestamp = this.#now().toISOString();
			const actorId = trigger === 'policy' ? 'system:repository-review-policy' : principal.id;
			this.#db.prepare('INSERT INTO reviews (id, job_id, attempt_id, number, status) VALUES (?, ?, ?, ?, ?)')
				.run(reviewId, job.id, attempt.id, reviewNumber, 'queued');
			this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE id = ?').run(timestamp, runId);
			this.#db.prepare('UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?').run(timestamp, job.id);
			this.#db.prepare('INSERT INTO approvals (id, run_id, job_id, kind, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(randomUUID(), runId, job.id, trigger === 'policy' ? 'policy_review' : 'review_draft', actorId, request.reason, timestamp);
			this.#audit(runId, String(job.id), actorId, trigger === 'policy' ? 'review.auto_authorized' : 'review.authorized', { reviewId, reviewNumber, attemptId: attempt.id, reason: request.reason }, timestamp);
			return {
				runId, jobId: String(job.id), attemptId: attempt.id, attemptNumber: attempt.number,
				reviewId, reviewNumber, actorId, repository: repositoryResult.output,
				workItem: JSON.parse(job.work_item_snapshot_json as string) as WorkItem,
			};
		})();
	}

	markReviewRunning(review: AuthorizedReview, principal: Principal): void {
		this.#db.transaction(() => {
			this.#ownedRun(review.runId, principal);
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare("UPDATE reviews SET status = 'running', started_at = ? WHERE id = ? AND job_id = ? AND status = 'queued'")
				.run(timestamp, review.reviewId, review.jobId).changes;
			if (changed !== 1) throw new LedgerConflictError('Adversarial review is not queued');
			this.#audit(review.runId, review.jobId, review.actorId, 'review.started', { reviewId: review.reviewId }, timestamp);
		})();
	}

	completeReview(
		review: AuthorizedReview,
		status: 'approved' | 'blocked' | 'failed',
		initialVerdict: ReviewReport | undefined,
		finalVerdict: ReviewReport | undefined,
		outcome: unknown,
		artifacts: ExecutionArtifactInput[],
		principal: Principal,
	): RunRecord {
		return this.#db.transaction(() => {
			this.#ownedRun(review.runId, principal);
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare("UPDATE reviews SET status = ?, initial_verdict_json = ?, final_verdict_json = ?, outcome_json = ?, finished_at = ? WHERE id = ? AND job_id = ? AND status IN ('queued','running')")
				.run(status, initialVerdict ? json(initialVerdict) : null, finalVerdict ? json(finalVerdict) : null, json(outcome), timestamp, review.reviewId, review.jobId).changes;
			if (changed !== 1) throw new LedgerConflictError('Adversarial review is already settled');
			for (const artifact of artifacts) {
				this.#db.prepare('INSERT INTO artifacts (id, job_id, attempt_id, kind, uri, digest, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
					.run(randomUUID(), review.jobId, review.attemptId, artifact.kind, artifact.uri, artifact.digest ?? null, json({ ...artifact.metadata, reviewId: review.reviewId }), timestamp);
			}
			this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE id = ?').run(timestamp, review.runId);
			this.#db.prepare('UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?').run(timestamp, review.jobId);
			this.#audit(review.runId, review.jobId, review.actorId, `review.${status}`, { reviewId: review.reviewId, artifactKinds: artifacts.map(({ kind }) => kind) }, timestamp);
			return this.get(review.runId, principal);
		})();
	}

	overrideBlocked(runId: string, input: unknown, principal: Principal): RunRecord {
		const request = v.parse(HumanOverrideRequestSchema, input);
		return this.#db.transaction(() => {
			const run = this.#ownedRun(runId, principal);
			if (run.version !== request.expectedVersion) throw new LedgerConflictError('Run changed; reload before overriding');
			if (run.status !== 'blocked') throw new LedgerConflictError('Only a blocked run needs an override');
			const timestamp = this.#now().toISOString();
			const job = this.#db.prepare("SELECT id FROM jobs WHERE run_id = ? AND status = 'blocked'").get(runId) as { id: string } | undefined;
			if (!job) throw new LedgerConflictError('Blocked run has no blocked job');
			this.#db.prepare("UPDATE runs SET status = 'pending', version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, runId);
			this.#db.prepare("UPDATE jobs SET status = 'admitted', version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, job.id);
			this.#db.prepare('INSERT INTO approvals (id, run_id, job_id, kind, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run(randomUUID(), runId, job.id, 'human_override', principal.id, request.reason, timestamp);
			this.#audit(runId, job.id, principal.id, 'run.override_granted', { reason: request.reason }, timestamp);
			return this.get(runId, principal);
		})();
	}

	cancel(runId: string, input: unknown, principal: Principal): RunRecord {
		const request = v.parse(CancelRunRequestSchema, input);
		return this.#db.transaction(() => {
			const run = this.#ownedRun(runId, principal);
			if (run.version !== request.expectedVersion) throw new LedgerConflictError('Run changed; reload before cancelling');
			if (run.status === 'cancelled') return this.get(runId, principal);
			if (['succeeded', 'failed'].includes(run.status)) throw new LedgerConflictError('Completed runs are immutable; supersede them with a new run');
			const timestamp = this.#now().toISOString();
			this.#db.prepare("UPDATE runs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, runId);
			this.#db.prepare("UPDATE jobs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE run_id = ? AND status NOT IN ('succeeded','failed','cancelled')").run(timestamp, runId);
			this.#audit(runId, undefined, principal.id, 'run.cancelled', { reason: request.reason }, timestamp);
			return this.get(runId, principal);
		})();
	}

	#ownedRun(runId: string, principal: Principal): OwnedRunRow {
		const row = this.#db.prepare('SELECT id, owner_id, status, supersedes_run_id, version, created_at, updated_at FROM runs WHERE id = ?').get(runId) as OwnedRunRow | undefined;
		if (!row) throw new LedgerNotFoundError('Run not found');
		if (row.owner_id !== principal.id) throw new LedgerForbiddenError('Run belongs to another principal');
		return row;
	}

	#audit(runId: string, jobId: string | undefined, actorId: string, type: string, payload: Record<string, unknown>, createdAt: string): void {
		this.#db.prepare('INSERT INTO audit_events (id, run_id, job_id, actor_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(randomUUID(), runId, jobId ?? null, actorId, type, json(payload), createdAt);
	}
}

export const jobLedger = new JobLedger();
