import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { projectMultiRepositoryChangeSetReadiness } from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import {
	MultiRepositoryChangeSetStore,
	type MultiRepositoryChangeSetParent,
} from './multi-repository-change-set-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryMemberAuthorizationSchema = v.object({
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	unitSha256: Sha256Schema,
	policySnapshotSha256: Sha256Schema,
});

export const MultiRepositoryChangeSetAuthorizationSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.literal('authorized'),
	planSha256: Sha256Schema,
	memberSetSha256: Sha256Schema,
	members: v.pipe(v.array(MultiRepositoryMemberAuthorizationSchema), v.minLength(2), v.maxLength(16)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	coordinationAuthorized: v.literal(true),
	workspaceAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	createdAt: v.string(),
});

const AuthorizeRequestSchema = v.object({
	changeSetId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
});

export type MultiRepositoryChangeSetAuthorization = v.InferOutput<typeof MultiRepositoryChangeSetAuthorizationSchema>;
export class MultiRepositoryAuthorizationConflictError extends Error {}
export class MultiRepositoryAuthorizationForbiddenError extends Error {}
export class MultiRepositoryAuthorizationNotFoundError extends Error {}
export class MultiRepositoryAuthorizationPolicyDriftError extends Error {}

interface AuthorizationRow {
	id: string; change_set_id: string; owner_id: string; idempotency_key: string; request_sha256: string;
	plan_sha256: string; member_set_sha256: string; members_json: string; reason: string; status: string; created_at: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function authorizedMembers(parent: MultiRepositoryChangeSetParent): v.InferOutput<typeof MultiRepositoryMemberAuthorizationSchema>[] {
	return parent.members.map(({ repositoryId, runId, jobId, unitSha256, policySnapshotSha256 }) => ({
		repositoryId, runId, jobId, unitSha256, policySnapshotSha256,
	}));
}

export class MultiRepositoryChangeSetAuthorizationStore {
	readonly #db: Database.Database;
	readonly #parents: MultiRepositoryChangeSetStore;
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
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#db.close(); }

	authorize(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryChangeSetAuthorization {
		const request = v.parse(AuthorizeRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryAuthorizationConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryAuthorizationConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		const parent = this.#parents.get(request.changeSetId, principal);
		this.#assertCurrentPolicy(parent);
		const members = authorizedMembers(parent);
		const memberSetSha256 = digest(members);

		return this.#db.transaction(() => {
			const existingReplay = this.#findReplay(principal.id, idempotencyKey);
			if (existingReplay) {
				if (existingReplay.request_sha256 !== requestSha256) throw new MultiRepositoryAuthorizationConflictError('Idempotency key was already used for different input');
				return this.get(existingReplay.id, principal);
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_change_set_authorizations WHERE change_set_id = ?').get(parent.id)) {
				throw new MultiRepositoryAuthorizationConflictError('This change set already has an immutable coordinated authorization');
			}
			const currentParent = this.#db.prepare('SELECT owner_id, status, plan_sha256 FROM multi_repository_change_sets WHERE id = ?').get(parent.id) as { owner_id: string; status: string; plan_sha256: string } | undefined;
			if (!currentParent || currentParent.owner_id !== principal.id || currentParent.status !== 'planned' || currentParent.plan_sha256 !== parent.planSha256) {
				throw new MultiRepositoryAuthorizationConflictError('Change-set parent changed before coordinated authorization');
			}
			for (const member of members) {
				const state = this.#db.prepare(`SELECT r.owner_id, r.status AS run_status, j.status AS job_status, j.current_attempt,
					(SELECT COUNT(*) FROM attempts a WHERE a.job_id = j.id) AS attempts,
					(SELECT COUNT(*) FROM reviews rv WHERE rv.job_id = j.id) AS reviews,
					(SELECT COUNT(*) FROM artifacts ar WHERE ar.job_id = j.id) AS artifacts
					FROM multi_repository_change_set_members m
					JOIN runs r ON r.id = m.run_id JOIN jobs j ON j.id = m.job_id
					WHERE m.change_set_id = ? AND m.repository_id = ? AND m.run_id = ? AND m.job_id = ?
						AND m.unit_sha256 = ? AND m.policy_snapshot_sha256 = ?`).get(
					parent.id, member.repositoryId, member.runId, member.jobId, member.unitSha256, member.policySnapshotSha256,
				) as { owner_id: string; run_status: string; job_status: string; current_attempt: number; attempts: number; reviews: number; artifacts: number } | undefined;
				if (!state || state.owner_id !== principal.id || state.run_status !== 'blocked' || state.job_status !== 'blocked'
					|| state.current_attempt !== 0 || state.attempts !== 0 || state.reviews !== 0 || state.artifacts !== 0) {
					throw new MultiRepositoryAuthorizationConflictError('Every member must retain pristine blocked ledger parentage');
				}
			}
			const id = randomUUID();
			const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_change_set_authorizations
				(id, change_set_id, owner_id, idempotency_key, request_sha256, plan_sha256, member_set_sha256, members_json, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`).run(
				id, parent.id, principal.id, idempotencyKey, requestSha256, parent.planSha256,
				memberSetSha256, JSON.stringify(members), request.reason, createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryChangeSetAuthorization {
		const row = this.#db.prepare('SELECT * FROM multi_repository_change_set_authorizations WHERE id = ?').get(id) as AuthorizationRow | undefined;
		if (!row) throw new MultiRepositoryAuthorizationNotFoundError('Coordinated authorization was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryAuthorizationForbiddenError('Coordinated authorization belongs to another principal');
		return this.#record(row);
	}

	getForChangeSet(changeSetId: string, principal: Principal): MultiRepositoryChangeSetAuthorization {
		const row = this.#db.prepare('SELECT * FROM multi_repository_change_set_authorizations WHERE change_set_id = ?').get(changeSetId) as AuthorizationRow | undefined;
		if (!row) throw new MultiRepositoryAuthorizationNotFoundError('Coordinated authorization was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryAuthorizationForbiddenError('Coordinated authorization belongs to another principal');
		return this.#record(row);
	}

	#assertCurrentPolicy(parent: MultiRepositoryChangeSetParent): void {
		const readiness = projectMultiRepositoryChangeSetReadiness(parent.plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositoryAuthorizationPolicyDriftError('Current enrollment no longer mutually authorizes every participant');
	}

	#findReplay(ownerId: string, idempotencyKey: string): AuthorizationRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_change_set_authorizations WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, idempotencyKey) as AuthorizationRow | undefined;
	}

	#record(row: AuthorizationRow): MultiRepositoryChangeSetAuthorization {
		const parent = this.#parents.get(row.change_set_id, { id: row.owner_id });
		const members = v.parse(v.array(MultiRepositoryMemberAuthorizationSchema), JSON.parse(row.members_json));
		if (row.status !== 'authorized' || row.plan_sha256 !== parent.planSha256
			|| digest({ changeSetId: row.change_set_id, reason: row.reason }) !== row.request_sha256
			|| digest(members) !== row.member_set_sha256
			|| JSON.stringify(canonical(members)) !== JSON.stringify(canonical(authorizedMembers(parent)))) {
			throw new MultiRepositoryAuthorizationConflictError('Stored coordinated authorization failed parent or member integrity verification');
		}
		return v.parse(MultiRepositoryChangeSetAuthorizationSchema, {
			id: row.id, changeSetId: row.change_set_id, ownerId: row.owner_id, status: row.status,
			planSha256: row.plan_sha256, memberSetSha256: row.member_set_sha256, members,
			reason: row.reason, coordinationAuthorized: true, workspaceAuthorized: false,
			modelDispatchAuthorized: false, publicationAuthorized: false, createdAt: row.created_at,
		});
	}
}
