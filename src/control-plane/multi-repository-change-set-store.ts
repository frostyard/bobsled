import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, RepositoryPolicySnapshotSchema, WorkItemSchema, type RepositoryContract } from './contracts.ts';
import { JobLedger, type Principal } from './ledger.ts';
import {
	MultiRepositoryChangeSetPlanV1Schema,
	MultiRepositoryChangeUnitSchema,
	projectMultiRepositoryChangeSetReadiness,
	type MultiRepositoryChangeSetPlanV1,
} from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryChangeSetMemberParentSchema = v.object({
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	unitSha256: Sha256Schema,
	unit: MultiRepositoryChangeUnitSchema,
	policySnapshotSha256: Sha256Schema,
	policySnapshot: RepositoryPolicySnapshotSchema,
	createdAt: v.string(),
});

export const MultiRepositoryChangeSetParentSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.literal('planned'),
	planSha256: Sha256Schema,
	plan: MultiRepositoryChangeSetPlanV1Schema,
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	members: v.pipe(v.array(MultiRepositoryChangeSetMemberParentSchema), v.minLength(2), v.maxLength(16)),
	executionAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	createdAt: v.string(),
	updatedAt: v.string(),
});

const AdmitMultiRepositoryChangeSetRequestSchema = v.object({
	plan: MultiRepositoryChangeSetPlanV1Schema,
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryChangeSetParent = v.InferOutput<typeof MultiRepositoryChangeSetParentSchema>;
export class MultiRepositoryChangeSetConflictError extends Error {}
export class MultiRepositoryChangeSetForbiddenError extends Error {}
export class MultiRepositoryChangeSetNotFoundError extends Error {}
export class MultiRepositoryCoordinationBlockedError extends Error {
	constructor(readonly violations: ReturnType<typeof projectMultiRepositoryChangeSetReadiness>['violations']) {
		super('Repository enrollment does not authorize this multi-repository change set');
	}
}

interface ChangeSetRow {
	id: string; owner_id: string; request_sha256: string; plan_sha256: string; plan_json: string;
	reason: string; status: string; created_at: string; updated_at: string;
}

interface MemberRow {
	repository_id: string; run_id: string; job_id: string; unit_sha256: string; unit_json: string;
	policy_snapshot_sha256: string; policy_snapshot_json: string; created_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function multiRepositoryChangeSetPlanDigest(plan: MultiRepositoryChangeSetPlanV1): string {
	return digest(v.parse(MultiRepositoryChangeSetPlanV1Schema, plan));
}

export function multiRepositoryMemberRunIdempotencyKey(planSha256: string, repositoryId: string): string {
	return `multi-repository-member:${digest({ planSha256, repositoryId })}`;
}

export class MultiRepositoryChangeSetStore {
	readonly #db: Database.Database;
	readonly #ledger: JobLedger;
	readonly #repositories: readonly RepositoryContract[];
	readonly #now: () => Date;

	constructor(
		path = dataPath('bobsled.db'),
		now: () => Date = () => new Date(),
		repositories: readonly RepositoryContract[] = enrolledRepositories,
	) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#ledger = new JobLedger(path, now, (id) => repositories.find((repository) => repository.enabled && repository.id === id));
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#ledger.close(); this.#db.close(); }

	admit(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryChangeSetParent {
		const request = v.parse(AdmitMultiRepositoryChangeSetRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryChangeSetConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryChangeSetConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		const readiness = projectMultiRepositoryChangeSetReadiness(request.plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositoryCoordinationBlockedError(readiness.violations);
		const planSha256 = multiRepositoryChangeSetPlanDigest(request.plan);
		if (this.#db.prepare('SELECT id FROM multi_repository_change_sets WHERE owner_id = ? AND plan_sha256 = ?').get(principal.id, planSha256)) {
			throw new MultiRepositoryChangeSetConflictError('This principal already has immutable parentage for the same change-set plan');
		}
		const runs = request.plan.repositories.map((unit) => this.#ledger.admit({
			repositoryId: unit.repositoryId,
			workItem: v.parse(WorkItemSchema, {
				source: 'manual', key: `multi-repository:${planSha256}:${unit.repositoryId}`,
				title: unit.title,
				body: `${unit.objective}\n\nAcceptance criteria:\n${unit.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`,
				labels: [],
			}),
			triageDecision: {
				route: 'needs_human', risk: 'high', confidence: 1,
				summary: 'This repository job belongs to a planned multi-repository change set.',
				rationale: 'Cross-repository execution authority is not implemented; the member remains blocked after immutable parent admission.',
				acceptanceCriteria: unit.acceptanceCriteria,
				missingInformation: ['A later M6 boundary must authorize coordinated execution.'],
				suggestedLabels: ['bobsled:needs-human'], eligibleForOneClick: false,
			},
		}, principal, multiRepositoryMemberRunIdempotencyKey(planSha256, unit.repositoryId)));

		const write = this.#db.transaction(() => {
			const existing = this.#findReplay(principal.id, idempotencyKey);
			if (existing) {
				if (existing.request_sha256 !== requestSha256) throw new MultiRepositoryChangeSetConflictError('Idempotency key was already used for different input');
				return this.get(existing.id, principal);
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_change_sets WHERE owner_id = ? AND plan_sha256 = ?').get(principal.id, planSha256)) {
				throw new MultiRepositoryChangeSetConflictError('This principal already has immutable parentage for the same change-set plan');
			}
			const id = randomUUID();
			const timestamp = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_change_sets
				(id, owner_id, idempotency_key, request_sha256, plan_sha256, plan_json, reason, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`).run(
				id, principal.id, idempotencyKey, requestSha256, planSha256, JSON.stringify(request.plan), request.reason, timestamp, timestamp,
			);
			for (const [index, unit] of request.plan.repositories.entries()) {
				const run = runs[index]!;
				const job = run.jobs[0];
				if (!job || run.ownerId !== principal.id || run.status !== 'blocked' || job.status !== 'blocked' || job.currentAttempt !== 0
					|| job.attempts.length !== 0 || job.reviews.length !== 0 || job.artifacts.length !== 0
					|| job.repositoryId !== unit.repositoryId || job.policySnapshot.id !== unit.repositoryId) {
					throw new MultiRepositoryChangeSetConflictError('Repository job lineage does not match its change-set member');
				}
				this.#db.prepare(`INSERT INTO multi_repository_change_set_members
					(change_set_id, repository_id, run_id, job_id, unit_sha256, unit_json, policy_snapshot_sha256, policy_snapshot_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					id, unit.repositoryId, run.id, job.id, digest(unit), JSON.stringify(unit),
					digest(job.policySnapshot), JSON.stringify(job.policySnapshot), timestamp,
				);
			}
			return this.get(id, principal);
		});
		return write.immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryChangeSetParent {
		const row = this.#db.prepare('SELECT * FROM multi_repository_change_sets WHERE id = ?').get(id) as ChangeSetRow | undefined;
		if (!row) throw new MultiRepositoryChangeSetNotFoundError('Multi-repository change set was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryChangeSetForbiddenError('Multi-repository change set belongs to another principal');
		return this.#record(row);
	}

	list(principal: Principal): MultiRepositoryChangeSetParent[] {
		return (this.#db.prepare('SELECT * FROM multi_repository_change_sets WHERE owner_id = ? ORDER BY created_at DESC, id').all(principal.id) as ChangeSetRow[]).map((row) => this.#record(row));
	}

	#findReplay(ownerId: string, idempotencyKey: string): ChangeSetRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_change_sets WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, idempotencyKey) as ChangeSetRow | undefined;
	}

	#record(row: ChangeSetRow): MultiRepositoryChangeSetParent {
		const members = this.#db.prepare('SELECT * FROM multi_repository_change_set_members WHERE change_set_id = ? ORDER BY created_at, rowid').all(row.id) as MemberRow[];
		const plan = v.parse(MultiRepositoryChangeSetPlanV1Schema, JSON.parse(row.plan_json));
		if (digest(plan) !== row.plan_sha256 || members.length !== plan.repositories.length) {
			throw new MultiRepositoryChangeSetConflictError('Stored change-set plan or member count failed integrity verification');
		}
		const verifiedMembers = members.map((member, index) => {
			const unit = v.parse(MultiRepositoryChangeUnitSchema, JSON.parse(member.unit_json));
			const policySnapshot = v.parse(RepositoryPolicySnapshotSchema, JSON.parse(member.policy_snapshot_json));
			const plannedUnit = plan.repositories[index];
			const run = this.#ledger.get(member.run_id, { id: row.owner_id });
			const job = run.jobs.find(({ id }) => id === member.job_id);
			if (!plannedUnit || !job
				|| member.repository_id !== plannedUnit.repositoryId || unit.repositoryId !== member.repository_id
				|| JSON.stringify(canonical(unit)) !== JSON.stringify(canonical(plannedUnit))
				|| digest(unit) !== member.unit_sha256
				|| policySnapshot.id !== member.repository_id || digest(policySnapshot) !== member.policy_snapshot_sha256
				|| job.repositoryId !== member.repository_id
				|| JSON.stringify(canonical(job.policySnapshot)) !== JSON.stringify(canonical(policySnapshot))) {
				throw new MultiRepositoryChangeSetConflictError('Stored change-set member failed ledger, unit, or policy integrity verification');
			}
			return {
				repositoryId: member.repository_id, runId: member.run_id, jobId: member.job_id,
				unitSha256: member.unit_sha256, unit,
				policySnapshotSha256: member.policy_snapshot_sha256, policySnapshot,
				createdAt: member.created_at,
			};
		});
		return v.parse(MultiRepositoryChangeSetParentSchema, {
			id: row.id, ownerId: row.owner_id, status: row.status,
			planSha256: row.plan_sha256, plan, reason: row.reason,
			members: verifiedMembers,
			executionAuthorized: false, publicationAuthorized: false,
			createdAt: row.created_at, updatedAt: row.updated_at,
		});
	}
}
