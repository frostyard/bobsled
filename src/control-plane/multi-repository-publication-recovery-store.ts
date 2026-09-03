import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import {
	MultiRepositoryPublicationExecutionStore,
	type MultiRepositoryPublicationExecution,
} from './multi-repository-publication-execution-store.ts';
import type { MultiRepositoryPublicationAuthorization } from './multi-repository-publication-authorization-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const PublicationStatusSchema = v.picklist([
	'blocked', 'pending', 'running', 'published', 'checks_pending', 'checks_failed',
	'ready_for_human', 'merged', 'closed', 'failed',
]);

export const MultiRepositoryPublicationRecoveryMemberSchema = v.object({
	repositoryId: RepositoryIdSchema,
	publicationId: v.pipe(v.string(), v.uuid()),
	sourceStatus: PublicationStatusSchema,
	currentStatus: PublicationStatusSchema,
	attemptCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
	disposition: v.picklist(['retained_draft', 'retry_candidate', 'pending_descendant', 'external_progress', 'ambiguous']),
	rolloutLayer: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15)),
	rollbackLayer: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15)),
	pullNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	pullUrl: v.optional(v.string()),
});

export const MultiRepositoryPublicationRollbackStepSchema = v.object({
	repositoryId: RepositoryIdSchema,
	publicationId: v.pipe(v.string(), v.uuid()),
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	pullUrl: v.string(),
	action: v.literal('human_close_or_revert'),
});

export const MultiRepositoryPublicationRecoveryResultSchema = v.object({
	version: v.literal(1),
	sourceExecutionSha256: Sha256Schema,
	status: v.picklist(['retryable', 'operator_decision_required']),
	members: v.pipe(v.array(MultiRepositoryPublicationRecoveryMemberSchema), v.minLength(2), v.maxLength(16)),
	retryOrder: v.array(RepositoryIdSchema),
	rollbackOrder: v.array(MultiRepositoryPublicationRollbackStepSchema),
	violations: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
	supersessionRequirement: v.literal('new_change_set'),
	retryExecutionAuthorized: v.literal(false),
	rollbackExecutionAuthorized: v.literal(false),
	supersessionExecutionAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
});

export const MultiRepositoryPublicationRecoveryPlanSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	sourceExecutionId: v.pipe(v.string(), v.uuid()),
	authorizationId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	result: MultiRepositoryPublicationRecoveryResultSchema,
	createdAt: v.string(),
});

const RequestSchema = v.object({
	sourceExecutionId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryPublicationRecoveryPlan = v.InferOutput<typeof MultiRepositoryPublicationRecoveryPlanSchema>;
export class MultiRepositoryPublicationRecoveryConflictError extends Error {}
export class MultiRepositoryPublicationRecoveryForbiddenError extends Error {}
export class MultiRepositoryPublicationRecoveryNotFoundError extends Error {}

interface RecoveryRow {
	id: string; source_execution_id: string; authorization_id: string; change_set_id: string; owner_id: string;
	idempotency_key: string; request_sha256: string; source_execution_sha256: string;
	result_sha256: string; result_json: string; reason: string; created_at: string;
}

export interface MultiRepositoryPublicationRecoveryPublication {
	id: string; ownerId: string; repositoryId: string; status: v.InferOutput<typeof PublicationStatusSchema>;
	attemptCount: number; pullNumber?: number; pullUrl?: string;
}

interface PublicationRow {
	id: string; owner_id: string; repository_id: string; status: string; attempt_count: number;
	pull_number: number | null; pull_url: string | null;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function executionDigest(execution: MultiRepositoryPublicationExecution): string {
	return digest({
		id: execution.id, authorizationId: execution.authorizationId, changeSetId: execution.changeSetId,
		status: execution.status, publicationsStarted: execution.publicationsStarted,
		authorizationSha256: execution.authorizationSha256, manifestSha256: execution.manifestSha256,
		result: execution.result,
	});
}

const draftStatuses = new Set<MultiRepositoryPublicationRecoveryPublication['status']>(['published', 'checks_pending', 'checks_failed', 'ready_for_human']);

export class MultiRepositoryPublicationRecoveryStore {
	readonly #db: Database.Database;
	readonly #executions: MultiRepositoryPublicationExecutionStore;
	readonly #ownsExecutions: boolean;
	readonly #publicationLookup?: (id: string, principal: Principal) => MultiRepositoryPublicationRecoveryPublication;
	readonly #now: () => Date;

	constructor(
		path = dataPath('bobsled.db'),
		now: () => Date = () => new Date(),
		repositories: readonly RepositoryContract[] = enrolledRepositories,
		executions?: MultiRepositoryPublicationExecutionStore,
		publicationLookup?: (id: string, principal: Principal) => MultiRepositoryPublicationRecoveryPublication,
	) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path); if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#executions = executions ?? new MultiRepositoryPublicationExecutionStore(path, now, repositories);
		this.#ownsExecutions = !executions;
		this.#publicationLookup = publicationLookup;
		this.#now = now;
	}

	close(): void {
		if (this.#ownsExecutions) this.#executions.close();
		this.#db.close();
	}

	admit(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryPublicationRecoveryPlan {
		const request = v.parse(RequestSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryPublicationRecoveryConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryPublicationRecoveryConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}

		return this.#db.transaction(() => {
			const concurrent = this.#findReplay(principal.id, idempotencyKey);
			if (concurrent) {
				if (concurrent.request_sha256 !== requestSha256) throw new MultiRepositoryPublicationRecoveryConflictError('Idempotency key was already used for different input');
				return this.get(concurrent.id, principal);
			}
		const execution = this.#executions.get(request.sourceExecutionId, principal);
		if (!['partial', 'blocked', 'failed'].includes(execution.status) || !execution.manifest || !execution.result) {
			throw new MultiRepositoryPublicationRecoveryConflictError('Only a terminal incomplete linked-publication execution may enter recovery planning');
		}
		const authorization = this.#executions.authorizationFor(execution.id, principal);
		const sourceExecutionSha256 = executionDigest(execution);
		const result = this.#deriveResult(execution, authorization, principal);
		const id = randomUUID(); const createdAt = this.#now().toISOString();
		this.#db.prepare(`INSERT INTO multi_repository_publication_recovery_plans
				(id,source_execution_id,authorization_id,change_set_id,owner_id,idempotency_key,request_sha256,
				 source_execution_sha256,result_sha256,result_json,reason,created_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
				id, execution.id, execution.authorizationId, execution.changeSetId, principal.id, idempotencyKey,
				requestSha256, sourceExecutionSha256, digest(result), JSON.stringify(result), request.reason, createdAt,
			);
		return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryPublicationRecoveryPlan {
		const row = this.#db.prepare('SELECT * FROM multi_repository_publication_recovery_plans WHERE id=?').get(id) as RecoveryRow | undefined;
		if (!row) throw new MultiRepositoryPublicationRecoveryNotFoundError('Linked-publication recovery plan was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryPublicationRecoveryForbiddenError('Linked-publication recovery plan belongs to another principal');
		const execution = this.#executions.get(row.source_execution_id, principal);
		const authorization = this.#executions.authorizationFor(execution.id, principal);
		let parsed: v.InferOutput<typeof MultiRepositoryPublicationRecoveryResultSchema>;
		try { parsed = v.parse(MultiRepositoryPublicationRecoveryResultSchema, JSON.parse(row.result_json)); }
		catch { throw new MultiRepositoryPublicationRecoveryConflictError('Stored recovery result is malformed'); }
		if (row.authorization_id !== execution.authorizationId || row.change_set_id !== execution.changeSetId
			|| row.source_execution_sha256 !== executionDigest(execution) || parsed.sourceExecutionSha256 !== row.source_execution_sha256
			|| digest(parsed) !== row.result_sha256 || digest(parsed) !== digest(this.#deriveResult(
				execution, authorization, principal,
				parsed.members.map((member) => ({
					id: member.publicationId, ownerId: row.owner_id, repositoryId: member.repositoryId,
					status: member.currentStatus, attemptCount: member.attemptCount,
					pullNumber: member.pullNumber, pullUrl: member.pullUrl,
				})),
			))
			|| digest({ sourceExecutionId: row.source_execution_id, reason: row.reason }) !== row.request_sha256) {
			throw new MultiRepositoryPublicationRecoveryConflictError('Stored recovery plan failed immutable parent or digest verification');
		}
		return v.parse(MultiRepositoryPublicationRecoveryPlanSchema, {
			id: row.id, sourceExecutionId: row.source_execution_id, authorizationId: row.authorization_id,
			changeSetId: row.change_set_id, ownerId: row.owner_id, reason: row.reason, result: parsed, createdAt: row.created_at,
		});
	}

	list(principal: Principal): MultiRepositoryPublicationRecoveryPlan[] {
		return (this.#db.prepare('SELECT id FROM multi_repository_publication_recovery_plans WHERE owner_id=? ORDER BY created_at DESC').all(principal.id) as Array<{ id: string }>).map(({ id }) => this.get(id, principal));
	}

	#deriveResult(
		execution: MultiRepositoryPublicationExecution,
		authorization: MultiRepositoryPublicationAuthorization,
		principal: Principal,
		publicationSnapshots?: readonly MultiRepositoryPublicationRecoveryPublication[],
	): v.InferOutput<typeof MultiRepositoryPublicationRecoveryResultSchema> {
		if (!execution.manifest || !execution.result) throw new MultiRepositoryPublicationRecoveryConflictError('Recovery source lacks terminal publication evidence');
		const rollbackLayer = new Map(authorization.rollbackLayers.flatMap((layer, index) => layer.map((repositoryId) => [repositoryId, index] as const)));
		const current = new Map((publicationSnapshots ?? execution.manifest.members.map((member) => this.#publication(member.publicationId, principal))).map((publication) => [publication.repositoryId, publication]));
		const violations: string[] = [];
		const members = execution.result.members.map((member) => {
			const publication = current.get(member.repositoryId);
			if (!publication || publication.repositoryId !== member.repositoryId) throw new MultiRepositoryPublicationRecoveryConflictError(`Publication identity drifted for ${member.repositoryId}`);
			let disposition: v.InferOutput<typeof MultiRepositoryPublicationRecoveryMemberSchema>['disposition'];
			if (draftStatuses.has(publication.status)) disposition = 'retained_draft';
			else if (publication.status === 'failed' || publication.status === 'blocked') disposition = 'retry_candidate';
			else if (publication.status === 'pending') disposition = 'pending_descendant';
			else if (publication.status === 'running') { disposition = 'ambiguous'; violations.push(`${member.repositoryId} has an in-flight or ambiguous publication`); }
			else { disposition = 'external_progress'; violations.push(`${member.repositoryId} is already ${publication.status}; retry requires an operator decision`); }
			const expectedRollbackLayer = rollbackLayer.get(member.repositoryId);
			if (expectedRollbackLayer === undefined) throw new MultiRepositoryPublicationRecoveryConflictError(`Recovery member is absent from rollback order: ${member.repositoryId}`);
			return {
				repositoryId: member.repositoryId, publicationId: member.publicationId,
				sourceStatus: member.status, currentStatus: publication.status, attemptCount: publication.attemptCount,
				disposition, rolloutLayer: member.rolloutLayer, rollbackLayer: expectedRollbackLayer,
				pullNumber: publication.pullNumber, pullUrl: publication.pullUrl,
			};
		});
		const byRepository = new Map(members.map((member) => [member.repositoryId, member]));
		const retryOrder = members.filter(({ disposition }) => disposition === 'retry_candidate' || disposition === 'pending_descendant').map(({ repositoryId }) => repositoryId);
		if (retryOrder.length === 0) violations.push('No linked publication is eligible for a bounded retry');
		const rollbackOrder = authorization.rollbackLayers.flat().flatMap((repositoryId) => {
			const member = byRepository.get(repositoryId);
			if (!member || !['retained_draft', 'external_progress'].includes(member.disposition)
				|| member.currentStatus === 'closed' || member.pullNumber === undefined || member.pullUrl === undefined) return [];
			return [{ repositoryId, publicationId: member.publicationId, pullNumber: member.pullNumber, pullUrl: member.pullUrl, action: 'human_close_or_revert' as const }];
		});
		return v.parse(MultiRepositoryPublicationRecoveryResultSchema, {
			version: 1, sourceExecutionSha256: executionDigest(execution),
			status: violations.length === 0 ? 'retryable' : 'operator_decision_required', members, retryOrder, rollbackOrder, violations,
			supersessionRequirement: 'new_change_set', retryExecutionAuthorized: false,
			rollbackExecutionAuthorized: false, supersessionExecutionAuthorized: false, mergeAuthorized: false,
		});
	}

	#publication(id: string, principal: Principal): MultiRepositoryPublicationRecoveryPublication {
		if (this.#publicationLookup) return this.#publicationLookup(id, principal);
		const row = this.#db.prepare('SELECT id,owner_id,repository_id,status,attempt_count,pull_number,pull_url FROM draft_publications WHERE id=?').get(id) as PublicationRow | undefined;
		if (!row) throw new MultiRepositoryPublicationRecoveryConflictError('Linked draft-publication evidence was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryPublicationRecoveryForbiddenError('Linked draft publication belongs to another principal');
		return {
			id: row.id, ownerId: row.owner_id, repositoryId: row.repository_id,
			status: v.parse(PublicationStatusSchema, row.status), attemptCount: row.attempt_count,
			pullNumber: row.pull_number ?? undefined, pullUrl: row.pull_url ?? undefined,
		};
	}

	#findReplay(ownerId: string, idempotencyKey: string): RecoveryRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_publication_recovery_plans WHERE owner_id=? AND idempotency_key=?').get(ownerId, idempotencyKey) as RecoveryRow | undefined;
	}
}
