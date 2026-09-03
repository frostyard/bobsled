import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { IntegrationWorkspaceResultSchema } from './integration-workspace-service.ts';
import { IntegrationConflictResolutionResultSchema } from './integration-conflict-resolution-contracts.ts';
import { MultiWorkerPlanV2Schema, WorkPlanTaskIdSchema } from './work-plan-contracts.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

export const MultiWorkerPlanParentSchema = v.object({
	planId: v.pipe(v.string(), v.uuid()),
	jobId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	planSha256: Sha256Schema,
	baseCommit: GitObjectIdSchema,
	plan: MultiWorkerPlanV2Schema,
	createdAt: v.string(),
});

export const IntegrationAssemblyParentSchema = v.object({
	assemblyId: v.pipe(v.string(), v.uuid()),
	planId: v.pipe(v.string(), v.uuid()),
	taskId: WorkPlanTaskIdSchema,
	status: v.picklist(['assembled', 'blocked']),
	result: IntegrationWorkspaceResultSchema,
	createdAt: v.string(),
});

export const IntegrationConflictResolutionParentSchema = v.object({
	resolutionId: v.pipe(v.string(), v.uuid()),
	sourceAssemblyId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	strategy: v.literal('git_three_way'),
	status: v.picklist(['resolved', 'blocked']),
	result: IntegrationConflictResolutionResultSchema,
	createdAt: v.string(),
});

export type MultiWorkerPlanParent = v.InferOutput<typeof MultiWorkerPlanParentSchema>;
export type IntegrationAssemblyParent = v.InferOutput<typeof IntegrationAssemblyParentSchema>;
export type IntegrationConflictResolutionParent = v.InferOutput<typeof IntegrationConflictResolutionParentSchema>;

export class MultiWorkerParentConflictError extends Error {}
export class MultiWorkerParentForbiddenError extends Error {}
export class MultiWorkerParentNotFoundError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

export function multiWorkerPlanDigest(plan: v.InferOutput<typeof MultiWorkerPlanV2Schema>): string {
	return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

export function ensureMultiWorkerParentSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS multi_worker_plans (
			id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			plan_sha256 TEXT NOT NULL, base_commit TEXT NOT NULL, plan_json TEXT NOT NULL,
			idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(owner_id, idempotency_key), UNIQUE(job_id, plan_sha256),
			FOREIGN KEY(job_id) REFERENCES jobs(id)
		);
		CREATE TABLE IF NOT EXISTS integration_assemblies (
			id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
			result_json TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(plan_id, task_id), FOREIGN KEY(plan_id) REFERENCES multi_worker_plans(id)
		);
		CREATE TABLE IF NOT EXISTS integration_conflict_resolutions (
			id TEXT PRIMARY KEY, source_assembly_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			strategy TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(source_assembly_id, strategy),
			FOREIGN KEY(source_assembly_id) REFERENCES integration_assemblies(id)
		);
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (15, datetime('now'));
	`);
}

export class MultiWorkerParentStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiWorkerParentSchema(this.#db);
		this.#now = now;
	}

	close(): void { this.#db.close(); }

	recordPlan(input: unknown, ownerId: string, idempotencyKey: string): MultiWorkerPlanParent {
		const request = v.parse(v.object({
			planId: v.pipe(v.string(), v.uuid()), jobId: v.pipe(v.string(), v.uuid()),
			baseCommit: GitObjectIdSchema, plan: MultiWorkerPlanV2Schema,
		}), input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('A bounded idempotency key is required');
		const planSha256 = multiWorkerPlanDigest(request.plan);
		const requestHash = createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
		return this.#db.transaction(() => {
			const job = this.#db.prepare(`SELECT runs.owner_id FROM jobs JOIN runs ON runs.id = jobs.run_id WHERE jobs.id = ?`)
				.get(request.jobId) as { owner_id: string } | undefined;
			if (!job) throw new MultiWorkerParentNotFoundError('Parent job does not exist');
			if (job.owner_id !== ownerId) throw new MultiWorkerParentForbiddenError('Parent job belongs to another principal');
			const replay = this.#db.prepare('SELECT id, request_hash FROM multi_worker_plans WHERE owner_id = ? AND idempotency_key = ?')
				.get(ownerId, idempotencyKey) as { id: string; request_hash: string } | undefined;
			if (replay) {
				if (replay.request_hash !== requestHash) throw new MultiWorkerParentConflictError('Idempotency key was used for different plan input');
				return this.getPlan(replay.id, ownerId);
			}
			const timestamp = this.#now().toISOString();
			try {
				this.#db.prepare(`INSERT INTO multi_worker_plans
					(id, job_id, owner_id, plan_sha256, base_commit, plan_json, idempotency_key, request_hash, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					request.planId, request.jobId, ownerId, planSha256, request.baseCommit,
					JSON.stringify(request.plan), idempotencyKey, requestHash, timestamp,
				);
			} catch (error) {
				throw new MultiWorkerParentConflictError(`Plan parent conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			return this.getPlan(request.planId, ownerId);
		})();
	}

	recordAssembly(input: unknown, ownerId: string): IntegrationAssemblyParent {
		const request = v.parse(v.object({
			assemblyId: v.pipe(v.string(), v.uuid()), planId: v.pipe(v.string(), v.uuid()),
			taskId: WorkPlanTaskIdSchema, result: IntegrationWorkspaceResultSchema,
		}), input);
		return this.#db.transaction(() => {
			const plan = this.getPlan(request.planId, ownerId);
			const task = plan.plan.tasks.find(({ id, dependsOn }) => id === request.taskId && dependsOn.length > 0);
			if (!task) throw new MultiWorkerParentConflictError('Assembly requires a dependency-bearing task in its parent plan');
			if (request.result.assemblyId !== request.assemblyId || request.result.taskId !== request.taskId || request.result.baseCommit !== plan.baseCommit) {
				throw new MultiWorkerParentConflictError('Assembly result does not match its plan, task, or base commit');
			}
			const replay = this.#db.prepare('SELECT plan_id, task_id, result_json FROM integration_assemblies WHERE id = ?')
				.get(request.assemblyId) as { plan_id: string; task_id: string; result_json: string } | undefined;
			if (replay) {
				if (replay.plan_id !== request.planId || replay.task_id !== request.taskId || JSON.stringify(canonical(JSON.parse(replay.result_json))) !== JSON.stringify(canonical(request.result))) {
					throw new MultiWorkerParentConflictError('Assembly ID was used for different evidence');
				}
				return this.getAssembly(request.assemblyId, ownerId);
			}
			const timestamp = this.#now().toISOString();
			try {
				this.#db.prepare(`INSERT INTO integration_assemblies (id, plan_id, task_id, status, result_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?)`).run(
					request.assemblyId, request.planId, request.taskId, request.result.status,
					JSON.stringify(request.result), timestamp,
				);
			} catch (error) {
				throw new MultiWorkerParentConflictError(`Assembly parent conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			return this.getAssembly(request.assemblyId, ownerId);
		})();
	}

	recordConflictResolution(input: unknown, ownerId: string): IntegrationConflictResolutionParent {
		const request = v.parse(v.object({
			resolutionId: v.pipe(v.string(), v.uuid()),
			sourceAssemblyId: v.pipe(v.string(), v.uuid()),
			result: IntegrationConflictResolutionResultSchema,
		}), input);
		return this.#db.transaction(() => {
			const source = this.getAssembly(request.sourceAssemblyId, ownerId);
			if (source.result.status !== 'blocked' || source.result.reason !== 'patch_rejected' || !source.result.failedTaskId) {
				throw new MultiWorkerParentConflictError('Conflict resolution requires a patch-rejected assembly parent');
			}
			if (
				request.result.resolutionId !== request.resolutionId
				|| request.result.sourceAssemblyId !== request.sourceAssemblyId
				|| request.result.taskId !== source.taskId
				|| request.result.baseCommit !== source.result.baseCommit
			) throw new MultiWorkerParentConflictError('Conflict resolution result does not match its durable assembly parent');
			if (request.result.workspacePath === source.result.workspacePath) {
				throw new MultiWorkerParentConflictError('Conflict resolution must preserve the rejected workspace and use a separate destination');
			}
			const replay = this.#db.prepare('SELECT source_assembly_id, owner_id, result_json FROM integration_conflict_resolutions WHERE id = ?')
				.get(request.resolutionId) as { source_assembly_id: string; owner_id: string; result_json: string } | undefined;
			if (replay) {
				if (
					replay.source_assembly_id !== request.sourceAssemblyId || replay.owner_id !== ownerId
					|| JSON.stringify(canonical(JSON.parse(replay.result_json))) !== JSON.stringify(canonical(request.result))
				) throw new MultiWorkerParentConflictError('Resolution ID was used for different evidence');
				return this.getConflictResolution(request.resolutionId, ownerId);
			}
			const timestamp = this.#now().toISOString();
			try {
				this.#db.prepare(`INSERT INTO integration_conflict_resolutions
					(id, source_assembly_id, owner_id, strategy, status, result_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
					request.resolutionId, request.sourceAssemblyId, ownerId, request.result.strategy,
					request.result.status, JSON.stringify(request.result), timestamp,
				);
			} catch (error) {
				throw new MultiWorkerParentConflictError(`Conflict resolution conflicts with existing evidence: ${error instanceof Error ? error.message : 'database constraint'}`);
			}
			return this.getConflictResolution(request.resolutionId, ownerId);
		})();
	}

	getPlan(planId: string, ownerId: string): MultiWorkerPlanParent {
		const row = this.#db.prepare('SELECT * FROM multi_worker_plans WHERE id = ?').get(planId) as Record<string, unknown> | undefined;
		if (!row) throw new MultiWorkerParentNotFoundError('Multi-worker plan does not exist');
		if (row.owner_id !== ownerId) throw new MultiWorkerParentForbiddenError('Multi-worker plan belongs to another principal');
		return v.parse(MultiWorkerPlanParentSchema, {
			planId: row.id, jobId: row.job_id, ownerId: row.owner_id, planSha256: row.plan_sha256,
			baseCommit: row.base_commit, plan: JSON.parse(row.plan_json as string), createdAt: row.created_at,
		});
	}

	getAssembly(assemblyId: string, ownerId: string): IntegrationAssemblyParent {
		const row = this.#db.prepare(`SELECT integration_assemblies.*, multi_worker_plans.owner_id
			FROM integration_assemblies JOIN multi_worker_plans ON multi_worker_plans.id = integration_assemblies.plan_id
			WHERE integration_assemblies.id = ?`).get(assemblyId) as Record<string, unknown> | undefined;
		if (!row) throw new MultiWorkerParentNotFoundError('Integration assembly does not exist');
		if (row.owner_id !== ownerId) throw new MultiWorkerParentForbiddenError('Integration assembly belongs to another principal');
		return v.parse(IntegrationAssemblyParentSchema, {
			assemblyId: row.id, planId: row.plan_id, taskId: row.task_id, status: row.status,
			result: JSON.parse(row.result_json as string), createdAt: row.created_at,
		});
	}

	getConflictResolution(resolutionId: string, ownerId: string): IntegrationConflictResolutionParent {
		const row = this.#db.prepare('SELECT * FROM integration_conflict_resolutions WHERE id = ?')
			.get(resolutionId) as Record<string, unknown> | undefined;
		if (!row) throw new MultiWorkerParentNotFoundError('Integration conflict resolution does not exist');
		if (row.owner_id !== ownerId) throw new MultiWorkerParentForbiddenError('Integration conflict resolution belongs to another principal');
		return v.parse(IntegrationConflictResolutionParentSchema, {
			resolutionId: row.id, sourceAssemblyId: row.source_assembly_id, ownerId: row.owner_id,
			strategy: row.strategy, status: row.status, result: JSON.parse(row.result_json as string), createdAt: row.created_at,
		});
	}
}
