import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { MultiRepositoryChangeSetAuthorizationStore } from './multi-repository-change-set-authorization-store.ts';
import { projectMultiRepositoryChangeSetReadiness } from './multi-repository-change-set-contracts.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryChangeSetStore } from './multi-repository-change-set-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryScheduledMemberSchema = v.object({
	repositoryId: RepositoryIdSchema,
	runId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	unitSha256: Sha256Schema,
	layerIndex: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15)),
	state: v.picklist(['eligible', 'waiting']),
	policySnapshotSha256: Sha256Schema,
	policySnapshot: RepositoryContractSchema,
	preparationAuthorized: v.literal(false),
	executionAuthorized: v.literal(false),
});

export const MultiRepositoryChangeSetScheduleSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	authorizationId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.literal('scheduled'),
	planSha256: Sha256Schema,
	authorizationMemberSetSha256: Sha256Schema,
	dependencyLayers: v.pipe(v.array(v.pipe(v.array(RepositoryIdSchema), v.minLength(1))), v.minLength(1), v.maxLength(16)),
	scheduledMemberSetSha256: Sha256Schema,
	members: v.pipe(v.array(MultiRepositoryScheduledMemberSchema), v.minLength(2), v.maxLength(16)),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	schedulingAuthorized: v.literal(true),
	preparationAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	createdAt: v.string(),
});

const ScheduleRequestSchema = v.object({
	authorizationId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryChangeSetSchedule = v.InferOutput<typeof MultiRepositoryChangeSetScheduleSchema>;
export class MultiRepositoryScheduleConflictError extends Error {}
export class MultiRepositoryScheduleForbiddenError extends Error {}
export class MultiRepositoryScheduleNotFoundError extends Error {}
export class MultiRepositorySchedulePolicyError extends Error {}

interface ScheduleRow {
	id: string; authorization_id: string; change_set_id: string; owner_id: string; idempotency_key: string;
	request_sha256: string; plan_sha256: string; authorization_member_set_sha256: string;
	dependency_layers_json: string; scheduled_member_set_sha256: string; reason: string; status: string; created_at: string;
}

interface ScheduledMemberRow {
	repository_id: string; run_id: string; job_id: string; unit_sha256: string; layer_index: number; state: string;
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

export class MultiRepositoryChangeSetScheduleStore {
	readonly #db: Database.Database;
	readonly #authorizations: MultiRepositoryChangeSetAuthorizationStore;
	readonly #parents: MultiRepositoryChangeSetStore;
	readonly #repositories: readonly RepositoryContract[];
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date(), repositories: readonly RepositoryContract[] = enrolledRepositories) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#authorizations = new MultiRepositoryChangeSetAuthorizationStore(path, now, repositories);
		this.#parents = new MultiRepositoryChangeSetStore(path, now, repositories);
		this.#repositories = repositories;
		this.#now = now;
	}

	close(): void { this.#parents.close(); this.#authorizations.close(); this.#db.close(); }

	schedule(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryChangeSetSchedule {
		const request = v.parse(ScheduleRequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryScheduleConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryScheduleConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		const authorization = this.#authorizations.get(request.authorizationId, principal);
		const parent = this.#parents.get(authorization.changeSetId, principal);
		const readiness = projectMultiRepositoryChangeSetReadiness(parent.plan, this.#repositories);
		if (!readiness.coordinationAllowed) throw new MultiRepositorySchedulePolicyError('Current enrollment no longer mutually authorizes every participant');
		const currentPolicies = new Map(this.#repositories.filter(({ enabled }) => enabled).map((repository) => [repository.id, v.parse(RepositoryContractSchema, repository)]));
		const members = authorization.members.map((member) => {
			const policy = currentPolicies.get(member.repositoryId);
			if (!policy || !policy.capabilities.writeCode || !policy.executionPolicy.enabled) {
				throw new MultiRepositorySchedulePolicyError(`Current repository policy does not permit local execution: ${member.repositoryId}`);
			}
			const gateIds = new Set(policy.qualityGates.map(({ id }) => id));
			const missingGate = policy.executionPolicy.requiredGateIds.find((id) => !gateIds.has(id));
			if (missingGate) throw new MultiRepositorySchedulePolicyError(`Current execution policy references a missing gate for ${member.repositoryId}: ${missingGate}`);
			const layerIndex = readiness.dependencyLayers.findIndex((layer) => layer.includes(member.repositoryId));
			if (layerIndex < 0) throw new MultiRepositoryScheduleConflictError(`Repository is absent from trusted dependency layers: ${member.repositoryId}`);
			return {
				...member, layerIndex, state: layerIndex === 0 ? 'eligible' as const : 'waiting' as const,
				policySnapshotSha256: digest(policy), policySnapshot: policy,
				preparationAuthorized: false as const, executionAuthorized: false as const,
			};
		});
		const scheduledMemberSetSha256 = digest(members.map(({ policySnapshot, preparationAuthorized, executionAuthorized, ...member }) => member));

		return this.#db.transaction(() => {
			const existingReplay = this.#findReplay(principal.id, idempotencyKey);
			if (existingReplay) {
				if (existingReplay.request_sha256 !== requestSha256) throw new MultiRepositoryScheduleConflictError('Idempotency key was already used for different input');
				return this.get(existingReplay.id, principal);
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_change_set_schedules WHERE authorization_id = ?').get(authorization.id)) {
				throw new MultiRepositoryScheduleConflictError('This authorization already has an immutable coordinated schedule');
			}
			const currentAuthorization = this.#db.prepare(`SELECT change_set_id, owner_id, plan_sha256, member_set_sha256, status
				FROM multi_repository_change_set_authorizations WHERE id = ?`).get(authorization.id) as
				{ change_set_id: string; owner_id: string; plan_sha256: string; member_set_sha256: string; status: string } | undefined;
			if (!currentAuthorization || currentAuthorization.change_set_id !== parent.id || currentAuthorization.owner_id !== principal.id
				|| currentAuthorization.plan_sha256 !== parent.planSha256 || currentAuthorization.member_set_sha256 !== authorization.memberSetSha256
				|| currentAuthorization.status !== 'authorized') throw new MultiRepositoryScheduleConflictError('Authorization parent changed before coordinated scheduling');
			for (const member of members) {
				const state = this.#db.prepare(`SELECT r.owner_id, r.status AS run_status, j.status AS job_status, j.current_attempt,
					(SELECT COUNT(*) FROM attempts a WHERE a.job_id = j.id) AS attempts,
					(SELECT COUNT(*) FROM reviews rv WHERE rv.job_id = j.id) AS reviews,
					(SELECT COUNT(*) FROM artifacts ar WHERE ar.job_id = j.id) AS artifacts
					FROM multi_repository_change_set_members m JOIN runs r ON r.id = m.run_id JOIN jobs j ON j.id = m.job_id
					WHERE m.change_set_id = ? AND m.repository_id = ? AND m.run_id = ? AND m.job_id = ? AND m.unit_sha256 = ?`).get(
					parent.id, member.repositoryId, member.runId, member.jobId, member.unitSha256,
				) as { owner_id: string; run_status: string; job_status: string; current_attempt: number; attempts: number; reviews: number; artifacts: number } | undefined;
				if (!state || state.owner_id !== principal.id || state.run_status !== 'blocked' || state.job_status !== 'blocked'
					|| state.current_attempt !== 0 || state.attempts !== 0 || state.reviews !== 0 || state.artifacts !== 0) {
					throw new MultiRepositoryScheduleConflictError('Every scheduled member must retain pristine blocked ledger parentage');
				}
			}
			const id = randomUUID();
			const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_change_set_schedules
				(id, authorization_id, change_set_id, owner_id, idempotency_key, request_sha256, plan_sha256,
				authorization_member_set_sha256, dependency_layers_json, scheduled_member_set_sha256, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`).run(
				id, authorization.id, parent.id, principal.id, idempotencyKey, requestSha256, parent.planSha256,
				authorization.memberSetSha256, JSON.stringify(readiness.dependencyLayers), scheduledMemberSetSha256, request.reason, createdAt,
			);
			for (const member of members) this.#db.prepare(`INSERT INTO multi_repository_change_set_schedule_members
				(schedule_id, repository_id, run_id, job_id, unit_sha256, layer_index, state,
				policy_snapshot_sha256, policy_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				id, member.repositoryId, member.runId, member.jobId, member.unitSha256, member.layerIndex, member.state,
				member.policySnapshotSha256, JSON.stringify(member.policySnapshot), createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryChangeSetSchedule {
		const row = this.#db.prepare('SELECT * FROM multi_repository_change_set_schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
		if (!row) throw new MultiRepositoryScheduleNotFoundError('Coordinated schedule was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryScheduleForbiddenError('Coordinated schedule belongs to another principal');
		return this.#record(row);
	}

	getForAuthorization(authorizationId: string, principal: Principal): MultiRepositoryChangeSetSchedule {
		const row = this.#db.prepare('SELECT * FROM multi_repository_change_set_schedules WHERE authorization_id = ?').get(authorizationId) as ScheduleRow | undefined;
		if (!row) throw new MultiRepositoryScheduleNotFoundError('Coordinated schedule was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryScheduleForbiddenError('Coordinated schedule belongs to another principal');
		return this.#record(row);
	}

	#findReplay(ownerId: string, idempotencyKey: string): ScheduleRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_change_set_schedules WHERE owner_id = ? AND idempotency_key = ?').get(ownerId, idempotencyKey) as ScheduleRow | undefined;
	}

	#record(row: ScheduleRow): MultiRepositoryChangeSetSchedule {
		const authorization = this.#authorizations.get(row.authorization_id, { id: row.owner_id });
		const parent = this.#parents.get(row.change_set_id, { id: row.owner_id });
		const dependencyLayers = v.parse(v.array(v.array(RepositoryIdSchema)), JSON.parse(row.dependency_layers_json));
		const memberRows = this.#db.prepare('SELECT * FROM multi_repository_change_set_schedule_members WHERE schedule_id = ? ORDER BY rowid').all(row.id) as ScheduledMemberRow[];
		const members = memberRows.map((member) => v.parse(MultiRepositoryScheduledMemberSchema, {
			repositoryId: member.repository_id, runId: member.run_id, jobId: member.job_id, unitSha256: member.unit_sha256,
			layerIndex: member.layer_index, state: member.state,
			policySnapshotSha256: member.policy_snapshot_sha256,
			policySnapshot: JSON.parse(member.policy_snapshot_json), preparationAuthorized: false, executionAuthorized: false,
		}));
		const memberDigest = digest(members.map(({ policySnapshot, preparationAuthorized, executionAuthorized, ...member }) => member));
		const trustedLayers = projectMultiRepositoryChangeSetReadiness(parent.plan, members.map(({ policySnapshot }) => policySnapshot)).dependencyLayers;
		if (row.status !== 'scheduled' || row.change_set_id !== authorization.changeSetId || row.plan_sha256 !== parent.planSha256
			|| row.authorization_member_set_sha256 !== authorization.memberSetSha256
			|| digest({ authorizationId: row.authorization_id, reason: row.reason }) !== row.request_sha256
			|| memberDigest !== row.scheduled_member_set_sha256 || members.length !== authorization.members.length
			|| JSON.stringify(dependencyLayers) !== JSON.stringify(trustedLayers)
			|| members.some((member, index) => {
				const authorized = authorization.members[index];
				return !authorized || member.repositoryId !== authorized.repositoryId || member.runId !== authorized.runId
					|| member.jobId !== authorized.jobId || member.unitSha256 !== authorized.unitSha256
					|| digest(member.policySnapshot) !== member.policySnapshotSha256
					|| dependencyLayers[member.layerIndex]?.includes(member.repositoryId) !== true
					|| member.state !== (member.layerIndex === 0 ? 'eligible' : 'waiting');
			})) throw new MultiRepositoryScheduleConflictError('Stored coordinated schedule failed parent, policy, layer, or member integrity verification');
		return v.parse(MultiRepositoryChangeSetScheduleSchema, {
			id: row.id, authorizationId: row.authorization_id, changeSetId: row.change_set_id, ownerId: row.owner_id,
			status: row.status, planSha256: row.plan_sha256, authorizationMemberSetSha256: row.authorization_member_set_sha256,
			dependencyLayers, scheduledMemberSetSha256: row.scheduled_member_set_sha256, members, reason: row.reason,
			schedulingAuthorized: true, preparationAuthorized: false, modelDispatchAuthorized: false,
			publicationAuthorized: false, createdAt: row.created_at,
		});
	}
}
