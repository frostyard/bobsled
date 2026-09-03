import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, WorkItemSchema, type RepositoryContract, type WorkItem } from './contracts.ts';
import {
	IntegrationConflictResolutionResultSchema,
	type IntegrationConflictResolutionResult,
} from './integration-conflict-resolution-contracts.ts';
import {
	IntegrationConflictAgentPreflightResultSchema,
	type IntegrationConflictAgentPreflightResult,
} from './integration-conflict-agent-preflight-contracts.ts';
import {
	IntegrationConflictAgentRunEvidenceSchema,
	type IntegrationConflictAgentOutcome,
} from './integration-conflict-agent-contracts.ts';
import { ensureMultiWorkerParentSchema } from './multi-worker-parent-store.ts';
import { MultiWorkerPlanV2Schema, WorkPlanTaskIdSchema, type MultiWorkerPlanV2 } from './work-plan-contracts.ts';

const ReservationSchema = v.object({
	agentAttemptId: v.pipe(v.string(), v.uuid()),
	sourceResolutionId: v.pipe(v.string(), v.uuid()),
});

export const IntegrationConflictAgentInvocationSchema = v.pipe(v.object({
	...ReservationSchema.entries,
	sourceAssemblyId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	taskId: WorkPlanTaskIdSchema,
	status: v.picklist(['reserved', 'preparing', 'running', 'resolved', 'blocked', 'failed']),
	modelCalls: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1)),
	maxModelCalls: v.literal(1),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	detail: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(10_000))),
	preflight: v.optional(v.object({
		result: v.optional(IntegrationConflictAgentPreflightResultSchema),
		claimedAt: v.string(),
		createdAt: v.optional(v.string()),
	})),
	workerRun: v.optional(v.object({
		evidence: IntegrationConflictAgentRunEvidenceSchema,
		createdAt: v.string(),
	})),
	resolution: v.optional(IntegrationConflictResolutionResultSchema),
}), v.check(
	(lease) => lease.status === 'running' ? lease.modelCalls === 1 : true,
	'A running conflict-agent invocation must retain its sole model claim',
), v.check(
	(lease) => lease.status === 'resolved' || lease.status === 'failed' ? lease.modelCalls === 1 : true,
	'A resolved or failed conflict-agent invocation must retain its sole model claim',
), v.check(
	(lease) => lease.modelCalls === 0 ? lease.startedAt === undefined : true,
	'An unclaimed conflict-agent invocation cannot have a model start time',
), v.check(
	(lease) => lease.modelCalls === 1 ? lease.startedAt !== undefined : true,
	'A model-bearing conflict-agent invocation must retain its start time',
), v.check(
	(lease) => ['resolved', 'blocked', 'failed'].includes(lease.status) ? lease.finishedAt !== undefined : true,
	'A terminal conflict-agent invocation must retain its finish time',
), v.check(
	(lease) => ['blocked', 'failed'].includes(lease.status) ? lease.detail !== undefined : true,
	'A blocked or failed conflict-agent invocation must retain a bounded detail',
), v.check(
	(lease) => lease.status !== 'preparing' || (lease.preflight !== undefined && lease.preflight.result === undefined),
	'A preparing conflict-agent invocation must retain its unsettled preflight claim',
), v.check(
	(lease) => lease.modelCalls !== 1 || lease.preflight?.result?.status === 'passed',
	'A conflict-agent model call requires passing durable preflight evidence',
));

export type IntegrationConflictAgentInvocation = v.InferOutput<typeof IntegrationConflictAgentInvocationSchema>;

export interface IntegrationConflictAgentContext {
	sourceWorkspacePath: string;
	conflictPaths: string[];
	sourceResolution: Extract<IntegrationConflictResolutionResult, { status: 'blocked' }>;
	baseCommit: string;
	plan: MultiWorkerPlanV2;
	repository: RepositoryContract;
	workItem: WorkItem;
}

export class IntegrationConflictAgentInvocationConflictError extends Error {}
export class IntegrationConflictAgentInvocationForbiddenError extends Error {}
export class IntegrationConflictAgentInvocationNotFoundError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function hash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function ensureIntegrationConflictAgentInvocationSchema(db: Database.Database): void {
	ensureMultiWorkerParentSchema(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS integration_conflict_agent_invocations (
			id TEXT PRIMARY KEY, source_resolution_id TEXT NOT NULL, source_assembly_id TEXT NOT NULL,
			owner_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
			model_calls INTEGER NOT NULL DEFAULT 0, max_model_calls INTEGER NOT NULL DEFAULT 1,
			idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, detail TEXT,
			created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
			UNIQUE(owner_id, idempotency_key),
			FOREIGN KEY(source_resolution_id) REFERENCES integration_conflict_resolutions(id),
			FOREIGN KEY(source_assembly_id) REFERENCES integration_assemblies(id)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS one_model_bearing_conflict_agent_invocation
			ON integration_conflict_agent_invocations(source_resolution_id) WHERE model_calls = 1;
		CREATE TABLE IF NOT EXISTS integration_conflict_agent_preflights (
			invocation_id TEXT PRIMARY KEY, result_json TEXT, claimed_at TEXT NOT NULL, created_at TEXT,
			FOREIGN KEY(invocation_id) REFERENCES integration_conflict_agent_invocations(id)
		);
		CREATE TABLE IF NOT EXISTS integration_conflict_agent_runs (
			invocation_id TEXT PRIMARY KEY, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
			FOREIGN KEY(invocation_id) REFERENCES integration_conflict_agent_invocations(id)
		);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (17, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (18, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (19, datetime('now'));
	`);
}

export class IntegrationConflictAgentInvocationStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureIntegrationConflictAgentInvocationSchema(this.#db);
		this.#now = now;
	}

	close(): void { this.#db.close(); }

	reserve(input: unknown, ownerId: string, idempotencyKey: string): IntegrationConflictAgentInvocation {
		const request = v.parse(ReservationSchema, input);
		if (!ownerId || ownerId.length > 500) throw new Error('A bounded owner identity is required');
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded idempotency key is required');
		const requestHash = hash(request);
		return this.#db.transaction(() => {
			const replay = this.#db.prepare(`SELECT id, request_hash FROM integration_conflict_agent_invocations
				WHERE owner_id = ? AND idempotency_key = ?`).get(ownerId, idempotencyKey) as { id: string; request_hash: string } | undefined;
			if (replay) {
				if (replay.request_hash !== requestHash) throw new IntegrationConflictAgentInvocationConflictError('Idempotency key was used for different conflict-agent input');
				return this.get(replay.id, ownerId);
			}
			const parent = this.#eligibleParent(request.sourceResolutionId);
			if (!parent) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent resolution requires durable unresolved Git three-way evidence');
			if (parent.owner_id !== ownerId) throw new IntegrationConflictAgentInvocationForbiddenError('Conflict resolution belongs to another principal');
			if (this.#db.prepare(`SELECT id FROM integration_conflict_agent_invocations
				WHERE source_resolution_id = ? AND model_calls = 1`).get(request.sourceResolutionId)) {
				throw new IntegrationConflictAgentInvocationConflictError('Conflict resolution already consumed its sole model call');
			}
			const timestamp = this.#now().toISOString();
			try {
				this.#db.prepare(`INSERT INTO integration_conflict_agent_invocations
					(id, source_resolution_id, source_assembly_id, owner_id, task_id, status, model_calls,
					 max_model_calls, idempotency_key, request_hash, created_at)
					VALUES (?, ?, ?, ?, ?, 'reserved', 0, 1, ?, ?, ?)`).run(
					request.agentAttemptId, request.sourceResolutionId, parent.source_assembly_id, ownerId,
					parent.task_id, idempotencyKey, requestHash, timestamp,
				);
			} catch (error) {
				throw new IntegrationConflictAgentInvocationConflictError(`Conflict-agent reservation conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			return this.get(request.agentAttemptId, ownerId);
		})();
	}

	claim(agentAttemptId: string, ownerId: string): { lease: IntegrationConflictAgentInvocation; newlyClaimed: boolean } {
		return this.#db.transaction(() => {
			const lease = this.get(agentAttemptId, ownerId);
			if (lease.status === 'running') return { lease, newlyClaimed: false };
			if (lease.status !== 'reserved' || lease.modelCalls !== 0 || lease.preflight?.result?.status !== 'passed') {
				throw new IntegrationConflictAgentInvocationConflictError('Only a reserved conflict-agent invocation can claim a model call');
			}
			if (this.#db.prepare(`SELECT id FROM integration_conflict_agent_invocations
				WHERE source_resolution_id = ? AND model_calls = 1`).get(lease.sourceResolutionId)) {
				throw new IntegrationConflictAgentInvocationConflictError('Conflict resolution already consumed its sole model call');
			}
			const timestamp = this.#now().toISOString();
			try {
				const changed = this.#db.prepare(`UPDATE integration_conflict_agent_invocations
					SET status = 'running', model_calls = 1, started_at = ?
					WHERE id = ? AND owner_id = ? AND status = 'reserved' AND model_calls = 0`)
					.run(timestamp, agentAttemptId, ownerId);
				if (changed.changes !== 1) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent model call was claimed concurrently');
			} catch (error) {
				if (error instanceof IntegrationConflictAgentInvocationConflictError) throw error;
				throw new IntegrationConflictAgentInvocationConflictError(`Conflict-agent model claim conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			return { lease: this.get(agentAttemptId, ownerId), newlyClaimed: true };
		})();
	}

	claimPreflight(agentAttemptId: string, ownerId: string): { lease: IntegrationConflictAgentInvocation; newlyClaimed: boolean } {
		return this.#db.transaction(() => {
			const lease = this.get(agentAttemptId, ownerId);
			if (lease.preflight) return { lease, newlyClaimed: false };
			if (lease.status !== 'reserved' || lease.modelCalls !== 0) {
				throw new IntegrationConflictAgentInvocationConflictError('Only an unprepared conflict-agent reservation can claim preflight');
			}
			const timestamp = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO integration_conflict_agent_preflights
				(invocation_id, result_json, claimed_at, created_at) VALUES (?, NULL, ?, NULL)`)
				.run(agentAttemptId, timestamp);
			const changed = this.#db.prepare(`UPDATE integration_conflict_agent_invocations SET status = 'preparing'
				WHERE id = ? AND owner_id = ? AND status = 'reserved' AND model_calls = 0`)
				.run(agentAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent preflight was claimed concurrently');
			return { lease: this.get(agentAttemptId, ownerId), newlyClaimed: true };
		})();
	}

	completePreflight(agentAttemptId: string, ownerId: string, inputResult: IntegrationConflictAgentPreflightResult): IntegrationConflictAgentInvocation {
		const result = v.parse(IntegrationConflictAgentPreflightResultSchema, inputResult);
		if (result.agentAttemptId !== agentAttemptId) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent preflight does not match its invocation');
		return this.#db.transaction(() => {
			const lease = this.get(agentAttemptId, ownerId);
			if (lease.preflight?.result) {
				if (JSON.stringify(canonical(lease.preflight.result)) !== JSON.stringify(canonical(result))) {
					throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent preflight conflicts with existing evidence');
				}
				return lease;
			}
			if (lease.status !== 'preparing' || lease.modelCalls !== 0 || !lease.preflight) {
				throw new IntegrationConflictAgentInvocationConflictError('Only a claimed conflict-agent preflight can record evidence');
			}
			const context = this.getContext(agentAttemptId, ownerId);
			if (result.sourceResolutionId !== lease.sourceResolutionId || result.baseCommit !== context.baseCommit) {
				throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent preflight does not match its durable parent');
			}
			if (result.status === 'passed' && (
				context.sourceResolution.replayManifest === undefined
				|| result.workspacePath === context.sourceWorkspacePath
				|| result.headCommit !== context.baseCommit
				|| result.failedTaskId !== context.sourceResolution.failedTaskId
				|| result.appliedTaskIds.join('\0') !== context.sourceResolution.appliedTaskIds.join('\0')
				|| [...result.conflictPaths].sort().join('\0') !== [...context.conflictPaths].sort().join('\0')
			)) throw new IntegrationConflictAgentInvocationConflictError('Passing conflict-agent preflight does not reproduce its trusted source evidence');
			const timestamp = this.#now().toISOString();
			this.#db.prepare(`UPDATE integration_conflict_agent_preflights SET result_json = ?, created_at = ?
				WHERE invocation_id = ? AND result_json IS NULL`).run(JSON.stringify(result), timestamp, agentAttemptId);
			const status = result.status === 'passed' ? 'reserved' : 'blocked';
			const changed = this.#db.prepare(`UPDATE integration_conflict_agent_invocations
				SET status = ?, detail = ?, finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'preparing' AND model_calls = 0`)
				.run(status, result.status === 'blocked' ? result.detail : null,
					result.status === 'blocked' ? timestamp : null, agentAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent preflight was settled concurrently');
			return this.get(agentAttemptId, ownerId);
		})();
	}

	blockBeforeDispatch(agentAttemptId: string, ownerId: string, detail: string): IntegrationConflictAgentInvocation {
		return this.#settle(agentAttemptId, ownerId, 'blocked', 0, detail);
	}

	failClaimed(agentAttemptId: string, ownerId: string, detail: string): IntegrationConflictAgentInvocation {
		const evidence = v.parse(IntegrationConflictAgentRunEvidenceSchema, { status: 'failed', detail });
		return this.#db.transaction(() => {
			const lease = this.get(agentAttemptId, ownerId);
			if (lease.status !== 'running' || lease.modelCalls !== 1 || lease.workerRun) {
				throw new IntegrationConflictAgentInvocationConflictError('Only a running conflict-agent invocation can fail');
			}
			const timestamp = this.#now().toISOString();
			this.#db.prepare('INSERT INTO integration_conflict_agent_runs (invocation_id, evidence_json, created_at) VALUES (?, ?, ?)')
				.run(agentAttemptId, JSON.stringify(evidence), timestamp);
			const changed = this.#db.prepare(`UPDATE integration_conflict_agent_invocations
				SET status = 'failed', detail = ?, finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = 'running' AND model_calls = 1`)
				.run(detail, timestamp, agentAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent failure was settled concurrently');
			return this.get(agentAttemptId, ownerId);
		})();
	}

	complete(
		agentAttemptId: string,
		ownerId: string,
		workerOutcome: IntegrationConflictAgentOutcome,
		inputResolution: IntegrationConflictResolutionResult,
	): IntegrationConflictAgentInvocation {
		const evidence = v.parse(IntegrationConflictAgentRunEvidenceSchema, { status: 'completed', receipt: workerOutcome });
		const resolution = v.parse(IntegrationConflictResolutionResultSchema, inputResolution);
		return this.#db.transaction(() => {
			const lease = this.get(agentAttemptId, ownerId);
			if (lease.status !== 'running' || lease.modelCalls !== 1 || lease.workerRun || lease.resolution) {
				throw new IntegrationConflictAgentInvocationConflictError('Only a running conflict-agent invocation can complete');
			}
			if (
				resolution.resolutionId !== agentAttemptId
				|| resolution.sourceResolutionId !== lease.sourceResolutionId
				|| resolution.sourceAssemblyId !== lease.sourceAssemblyId
				|| resolution.taskId !== lease.taskId
				|| resolution.strategy !== 'codex_one_call'
				|| resolution.modelCalls !== 1
				|| resolution.workspacePath !== lease.preflight?.result?.workspacePath
			) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent result does not match its one-use durable lineage');
			if (resolution.status === 'resolved' && workerOutcome.result.disposition !== 'resolved') {
				throw new IntegrationConflictAgentInvocationConflictError('Resolved trusted evidence requires a resolved worker receipt');
			}
			if (resolution.status === 'resolved'
				&& !sameUniquePaths(workerOutcome.result.resolvedPaths, lease.preflight?.result?.conflictPaths ?? [])) {
				throw new IntegrationConflictAgentInvocationConflictError('Resolved worker receipt paths do not match trusted conflict paths');
			}
			const timestamp = this.#now().toISOString();
			try {
				this.#db.prepare(`INSERT INTO integration_conflict_resolutions
					(id, source_assembly_id, owner_id, strategy, status, result_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
					resolution.resolutionId, resolution.sourceAssemblyId, ownerId, resolution.strategy,
					resolution.status, JSON.stringify(resolution), timestamp,
				);
				this.#db.prepare('INSERT INTO integration_conflict_agent_runs (invocation_id, evidence_json, created_at) VALUES (?, ?, ?)')
					.run(agentAttemptId, JSON.stringify(evidence), timestamp);
			} catch (error) {
				throw new IntegrationConflictAgentInvocationConflictError(`Conflict-agent completion conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			const changed = this.#db.prepare(`UPDATE integration_conflict_agent_invocations
				SET status = ?, finished_at = ?, detail = ?
				WHERE id = ? AND owner_id = ? AND status = 'running' AND model_calls = 1`)
				.run(resolution.status, timestamp, resolution.status === 'blocked' ? resolution.detail : null, agentAttemptId, ownerId);
			if (changed.changes !== 1) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent completion was settled concurrently');
			return this.get(agentAttemptId, ownerId);
		})();
	}

	get(agentAttemptId: string, ownerId: string): IntegrationConflictAgentInvocation {
		const row = this.#db.prepare('SELECT * FROM integration_conflict_agent_invocations WHERE id = ?')
			.get(agentAttemptId) as Record<string, unknown> | undefined;
		if (!row) throw new IntegrationConflictAgentInvocationNotFoundError('Conflict-agent invocation does not exist');
		if (row.owner_id !== ownerId) throw new IntegrationConflictAgentInvocationForbiddenError('Conflict-agent invocation belongs to another principal');
		const preflightRow = this.#db.prepare(`SELECT result_json, claimed_at, created_at
			FROM integration_conflict_agent_preflights WHERE invocation_id = ?`).get(agentAttemptId) as {
				result_json: string | null; claimed_at: string; created_at: string | null;
			} | undefined;
		const workerRow = this.#db.prepare('SELECT evidence_json, created_at FROM integration_conflict_agent_runs WHERE invocation_id = ?')
			.get(agentAttemptId) as { evidence_json: string; created_at: string } | undefined;
		const resolutionRow = this.#db.prepare('SELECT result_json FROM integration_conflict_resolutions WHERE id = ?')
			.get(agentAttemptId) as { result_json: string } | undefined;
		return v.parse(IntegrationConflictAgentInvocationSchema, {
			agentAttemptId: row.id, sourceResolutionId: row.source_resolution_id,
			sourceAssemblyId: row.source_assembly_id, ownerId: row.owner_id, taskId: row.task_id,
			status: row.status, modelCalls: row.model_calls, maxModelCalls: row.max_model_calls,
			createdAt: row.created_at, startedAt: row.started_at ?? undefined,
			finishedAt: row.finished_at ?? undefined, detail: row.detail ?? undefined,
			preflight: preflightRow ? {
				result: preflightRow.result_json ? JSON.parse(preflightRow.result_json) : undefined,
				claimedAt: preflightRow.claimed_at, createdAt: preflightRow.created_at ?? undefined,
			} : undefined,
			workerRun: workerRow ? { evidence: JSON.parse(workerRow.evidence_json), createdAt: workerRow.created_at } : undefined,
			resolution: resolutionRow ? JSON.parse(resolutionRow.result_json) : undefined,
		});
	}

	getContext(agentAttemptId: string, ownerId: string): IntegrationConflictAgentContext {
		this.get(agentAttemptId, ownerId);
		const row = this.#db.prepare(`SELECT resolutions.result_json AS resolution_json,
			plans.base_commit, plans.plan_json, jobs.policy_snapshot_json, jobs.work_item_snapshot_json
			FROM integration_conflict_agent_invocations AS invocations
			JOIN integration_conflict_resolutions AS resolutions ON resolutions.id = invocations.source_resolution_id
			JOIN integration_assemblies AS assemblies ON assemblies.id = invocations.source_assembly_id
			JOIN multi_worker_plans AS plans ON plans.id = assemblies.plan_id
			JOIN jobs ON jobs.id = plans.job_id
			WHERE invocations.id = ?`).get(agentAttemptId) as {
				resolution_json: string; base_commit: string; plan_json: string;
				policy_snapshot_json: string; work_item_snapshot_json: string;
			} | undefined;
		if (!row) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent invocation has no complete durable parent chain');
		const resolution = v.parse(IntegrationConflictResolutionResultSchema, JSON.parse(row.resolution_json));
		if (resolution.status !== 'blocked' || resolution.reason !== 'unresolved_conflict') {
			throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent parent is no longer unresolved evidence');
		}
		if (resolution.baseCommit !== row.base_commit) throw new IntegrationConflictAgentInvocationConflictError('Conflict resolution base no longer matches its plan parent');
		return {
			sourceWorkspacePath: resolution.workspacePath,
			conflictPaths: resolution.conflictPaths,
			sourceResolution: resolution,
			baseCommit: row.base_commit,
			plan: v.parse(MultiWorkerPlanV2Schema, JSON.parse(row.plan_json)),
			repository: v.parse(RepositoryContractSchema, JSON.parse(row.policy_snapshot_json)),
			workItem: v.parse(WorkItemSchema, JSON.parse(row.work_item_snapshot_json)),
		};
	}

	#eligibleParent(resolutionId: string): { owner_id: string; source_assembly_id: string; task_id: string } | undefined {
		const row = this.#db.prepare(`SELECT resolutions.owner_id, resolutions.source_assembly_id,
			assemblies.task_id, resolutions.strategy, resolutions.status, resolutions.result_json
			FROM integration_conflict_resolutions AS resolutions
			JOIN integration_assemblies AS assemblies ON assemblies.id = resolutions.source_assembly_id
			WHERE resolutions.id = ?`).get(resolutionId) as Record<string, unknown> | undefined;
		if (!row || row.strategy !== 'git_three_way' || row.status !== 'blocked') return undefined;
		const result = v.parse(IntegrationConflictResolutionResultSchema, JSON.parse(row.result_json as string));
		if (result.status !== 'blocked' || result.reason !== 'unresolved_conflict'
			|| result.modelCalls !== 0 || result.workerAuthorized !== false || result.conflictPaths.length === 0) return undefined;
		return { owner_id: row.owner_id as string, source_assembly_id: row.source_assembly_id as string, task_id: row.task_id as string };
	}

	#settle(agentAttemptId: string, ownerId: string, status: 'blocked' | 'failed', expectedCalls: 0 | 1, detail: string): IntegrationConflictAgentInvocation {
		const boundedDetail = v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)), detail);
		return this.#db.transaction(() => {
			const lease = this.get(agentAttemptId, ownerId);
			const expectedStatus = expectedCalls === 0 ? 'reserved' : 'running';
			if (lease.status !== expectedStatus || lease.modelCalls !== expectedCalls) {
				throw new IntegrationConflictAgentInvocationConflictError(`Only a ${expectedStatus} conflict-agent invocation can settle ${status}`);
			}
			const timestamp = this.#now().toISOString();
			const changed = this.#db.prepare(`UPDATE integration_conflict_agent_invocations
				SET status = ?, detail = ?, finished_at = ?
				WHERE id = ? AND owner_id = ? AND status = ? AND model_calls = ?`)
				.run(status, boundedDetail, timestamp, agentAttemptId, ownerId, expectedStatus, expectedCalls);
			if (changed.changes !== 1) throw new IntegrationConflictAgentInvocationConflictError('Conflict-agent invocation was settled concurrently');
			return this.get(agentAttemptId, ownerId);
		})();
	}
}

function sameUniquePaths(left: readonly string[], right: readonly string[]): boolean {
	return left.length === new Set(left).size && right.length === new Set(right).size
		&& [...left].sort().join('\0') === [...right].sort().join('\0');
}
