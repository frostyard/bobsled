import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import { GateResultSchema } from './execution-contracts.ts';
import type { Principal } from './ledger.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import {
	MultiRepositoryVerificationAuthorizationStore,
	type MultiRepositoryVerificationAuthorization,
} from './multi-repository-verification-authorization-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const MultiRepositoryCompatibilityMemberSchema = v.object({
	repositoryId: RepositoryIdSchema,
	baseCommit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
	patchSha256: Sha256Schema,
	workspacePath: v.pipe(v.string(), v.minLength(1)),
});

export const MultiRepositoryCompatibilityManifestSchema = v.object({
	version: v.literal(1),
	executionId: v.pipe(v.string(), v.uuid()),
	members: v.pipe(v.array(MultiRepositoryCompatibilityMemberSchema), v.minLength(2), v.maxLength(16)),
	workspaceMutationAuthorized: v.literal(false),
	networkAccessAuthorized: v.literal(false),
});

export const MultiRepositoryCompatibilityGateResultSchema = v.object({
	repositoryId: RepositoryIdSchema,
	dependencyRepositoryId: RepositoryIdSchema,
	gateId: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	result: GateResultSchema,
});

export const MultiRepositoryCompatibilityExecutionResultSchema = v.object({
	manifestSha256: Sha256Schema,
	gates: v.pipe(v.array(MultiRepositoryCompatibilityGateResultSchema), v.minLength(1), v.maxLength(120)),
	status: v.picklist(['succeeded', 'blocked', 'failed']),
	violations: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
	workspaceMutationAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	rolloutAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
});

export const MultiRepositoryCompatibilityExecutionSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	authorizationId: v.pipe(v.string(), v.uuid()),
	verificationPlanId: v.pipe(v.string(), v.uuid()),
	scheduleId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['reserved', 'prepared', 'running', 'succeeded', 'blocked', 'failed']),
	commandsStarted: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(120)),
	authorizationSha256: Sha256Schema,
	gateSetSha256: Sha256Schema,
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
	createdAt: v.string(),
	startedAt: v.optional(v.string()),
	finishedAt: v.optional(v.string()),
	manifest: v.optional(MultiRepositoryCompatibilityManifestSchema),
	manifestSha256: v.optional(Sha256Schema),
	result: v.optional(MultiRepositoryCompatibilityExecutionResultSchema),
	compatibilityExecutionAuthorized: v.boolean(),
	workspaceMutationAuthorized: v.literal(false),
	modelDispatchAuthorized: v.literal(false),
	publicationAuthorized: v.literal(false),
	rolloutAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
});

const ReserveSchema = v.object({
	authorizationId: v.pipe(v.string(), v.uuid()),
	reason: v.pipe(v.string(), v.minLength(10), v.maxLength(2_000)),
});

export type MultiRepositoryCompatibilityManifest = v.InferOutput<typeof MultiRepositoryCompatibilityManifestSchema>;
export type MultiRepositoryCompatibilityExecutionResult = v.InferOutput<typeof MultiRepositoryCompatibilityExecutionResultSchema>;
export type MultiRepositoryCompatibilityExecution = v.InferOutput<typeof MultiRepositoryCompatibilityExecutionSchema>;
export interface MultiRepositoryCompatibilityExecutionClaim { execution: MultiRepositoryCompatibilityExecution; newlyClaimed: boolean }
export class MultiRepositoryCompatibilityExecutionConflictError extends Error {}
export class MultiRepositoryCompatibilityExecutionForbiddenError extends Error {}
export class MultiRepositoryCompatibilityExecutionNotFoundError extends Error {}

interface ExecutionRow {
	id: string; authorization_id: string; verification_plan_id: string; schedule_id: string; change_set_id: string;
	owner_id: string; idempotency_key: string; request_sha256: string; authorization_sha256: string;
	gate_set_sha256: string; reason: string; status: string; commands_started: number; created_at: string;
	started_at: string | null; finished_at: string | null; result_sha256: string | null; result_json: string | null;
}
interface PreflightRow { manifest_sha256: string; manifest_json: string; created_at: string }

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function authorizationDigest(value: MultiRepositoryVerificationAuthorization): string {
	return digest({ id: value.id, verificationPlanId: value.verificationPlanId, scheduleId: value.scheduleId, changeSetId: value.changeSetId, ownerId: value.ownerId, verificationPlanSha256: value.verificationPlanSha256, gateSetSha256: value.gateSetSha256, gates: value.gates });
}

export class MultiRepositoryCompatibilityExecutionStore {
	readonly #db: Database.Database;
	readonly #authorizations: MultiRepositoryVerificationAuthorizationStore;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date(), repositories: readonly RepositoryContract[] = enrolledRepositories) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000');
		this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#authorizations = new MultiRepositoryVerificationAuthorizationStore(path, now, repositories);
		this.#now = now;
	}

	close(): void { this.#authorizations.close(); this.#db.close(); }

	reserve(input: unknown, principal: Principal, idempotencyKey: string): MultiRepositoryCompatibilityExecution {
		const request = v.parse(ReserveSchema, input);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new MultiRepositoryCompatibilityExecutionConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		const replay = this.#findReplay(principal.id, idempotencyKey);
		if (replay) {
			if (replay.request_sha256 !== requestSha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Idempotency key was already used for different input');
			return this.get(replay.id, principal);
		}
		const authorization = this.#authorizations.get(request.authorizationId, principal);
		return this.#db.transaction(() => {
			const concurrent = this.#findReplay(principal.id, idempotencyKey);
			if (concurrent) {
				if (concurrent.request_sha256 !== requestSha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Idempotency key was already used for different input');
				return this.get(concurrent.id, principal);
			}
			if (this.#db.prepare('SELECT id FROM multi_repository_compatibility_executions WHERE authorization_id=?').get(authorization.id)) {
				throw new MultiRepositoryCompatibilityExecutionConflictError('This authorization already has an immutable compatibility execution');
			}
			const id = randomUUID(); const createdAt = this.#now().toISOString();
			this.#db.prepare(`INSERT INTO multi_repository_compatibility_executions
				(id, authorization_id, verification_plan_id, schedule_id, change_set_id, owner_id, idempotency_key,
				request_sha256, authorization_sha256, gate_set_sha256, reason, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(
				id, authorization.id, authorization.verificationPlanId, authorization.scheduleId, authorization.changeSetId,
				principal.id, idempotencyKey, requestSha256, authorizationDigest(authorization), authorization.gateSetSha256,
				request.reason, createdAt,
			);
			return this.get(id, principal);
		}).immediate();
	}

	get(id: string, principal: Principal): MultiRepositoryCompatibilityExecution {
		const row = this.#db.prepare('SELECT * FROM multi_repository_compatibility_executions WHERE id=?').get(id) as ExecutionRow | undefined;
		if (!row) throw new MultiRepositoryCompatibilityExecutionNotFoundError('Compatibility execution was not found');
		if (row.owner_id !== principal.id) throw new MultiRepositoryCompatibilityExecutionForbiddenError('Compatibility execution belongs to another principal');
		const authorization = this.#authorizations.get(row.authorization_id, principal);
		const preflight = this.#db.prepare('SELECT * FROM multi_repository_compatibility_preflights WHERE execution_id=?').get(id) as PreflightRow | undefined;
		let manifest: MultiRepositoryCompatibilityManifest | undefined;
		if (preflight) {
			try { manifest = v.parse(MultiRepositoryCompatibilityManifestSchema, JSON.parse(preflight.manifest_json)); }
			catch { throw new MultiRepositoryCompatibilityExecutionConflictError('Stored compatibility manifest is malformed'); }
			if (digest(manifest) !== preflight.manifest_sha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Stored compatibility manifest failed digest verification');
			this.#assertManifest(manifest, row, authorization);
		}
		let result: MultiRepositoryCompatibilityExecutionResult | undefined;
		if (row.result_json) {
			try { result = v.parse(MultiRepositoryCompatibilityExecutionResultSchema, JSON.parse(row.result_json)); }
			catch { throw new MultiRepositoryCompatibilityExecutionConflictError('Stored compatibility result is malformed'); }
			if (!row.result_sha256 || digest(result) !== row.result_sha256 || !manifest || result.manifestSha256 !== preflight?.manifest_sha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Stored compatibility result failed evidence verification');
			this.#assertResults(result, authorization, row.commands_started);
		}
		if (row.verification_plan_id !== authorization.verificationPlanId || row.schedule_id !== authorization.scheduleId
			|| row.change_set_id !== authorization.changeSetId || row.authorization_sha256 !== authorizationDigest(authorization)
			|| row.gate_set_sha256 !== authorization.gateSetSha256
			|| digest({ authorizationId: row.authorization_id, reason: row.reason }) !== row.request_sha256) {
			throw new MultiRepositoryCompatibilityExecutionConflictError('Stored compatibility execution failed parent integrity verification');
		}
		const terminal = ['succeeded', 'blocked', 'failed'].includes(row.status);
		if ((row.status === 'reserved') !== !manifest || (row.status === 'prepared' && !manifest)
			|| (['running', 'succeeded', 'blocked', 'failed'].includes(row.status) && !manifest)
			|| terminal !== Boolean(result) || (result && result.status !== row.status)
			|| (terminal && (!row.finished_at || row.commands_started < 1))
			|| (!terminal && (row.finished_at || result))) {
			throw new MultiRepositoryCompatibilityExecutionConflictError('Stored compatibility execution has an invalid lifecycle shape');
		}
		return v.parse(MultiRepositoryCompatibilityExecutionSchema, {
			id: row.id, authorizationId: row.authorization_id, verificationPlanId: row.verification_plan_id,
			scheduleId: row.schedule_id, changeSetId: row.change_set_id, ownerId: row.owner_id, status: row.status,
			commandsStarted: row.commands_started, authorizationSha256: row.authorization_sha256,
			gateSetSha256: row.gate_set_sha256, reason: row.reason, createdAt: row.created_at,
			startedAt: row.started_at ?? undefined, finishedAt: row.finished_at ?? undefined,
			manifest, manifestSha256: preflight?.manifest_sha256, result,
			compatibilityExecutionAuthorized: row.status === 'prepared', workspaceMutationAuthorized: false,
			modelDispatchAuthorized: false, publicationAuthorized: false, rolloutAuthorized: false, mergeAuthorized: false,
		});
	}

	recordPreflight(id: string, manifestInput: unknown, principal: Principal): MultiRepositoryCompatibilityExecution {
		const manifest = v.parse(MultiRepositoryCompatibilityManifestSchema, manifestInput);
		this.#db.transaction(() => {
			const execution = this.get(id, principal);
			const authorization = this.#authorizations.get(execution.authorizationId, principal);
			this.#assertManifest(manifest, this.#row(id), authorization);
			const manifestSha256 = digest(manifest);
			const prior = this.#db.prepare('SELECT * FROM multi_repository_compatibility_preflights WHERE execution_id=?').get(id) as PreflightRow | undefined;
			if (prior) {
				if (prior.manifest_sha256 !== manifestSha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility preflight is immutable');
				return;
			}
			if (execution.status !== 'reserved') throw new MultiRepositoryCompatibilityExecutionConflictError('Only a reserved execution may record compatibility preflight');
			this.#db.prepare('INSERT INTO multi_repository_compatibility_preflights (execution_id, manifest_sha256, manifest_json, created_at) VALUES (?, ?, ?, ?)')
				.run(id, manifestSha256, JSON.stringify(manifest), this.#now().toISOString());
			const changed = this.#db.prepare("UPDATE multi_repository_compatibility_executions SET status='prepared' WHERE id=? AND status='reserved'").run(id);
			if (changed.changes !== 1) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility preflight raced with another process');
		}).immediate();
		return this.get(id, principal);
	}

	claim(id: string, principal: Principal): MultiRepositoryCompatibilityExecutionClaim {
		let newlyClaimed = false;
		this.#db.transaction(() => {
			const execution = this.get(id, principal);
			if (execution.status === 'running' || ['succeeded', 'blocked', 'failed'].includes(execution.status)) return;
			if (execution.status !== 'prepared' || !execution.manifest) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility execution lacks passing preflight evidence');
			const changed = this.#db.prepare("UPDATE multi_repository_compatibility_executions SET status='running', started_at=? WHERE id=? AND status='prepared' AND commands_started=0")
				.run(this.#now().toISOString(), id);
			if (changed.changes !== 1) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility execution claim raced with another process');
			newlyClaimed = true;
		}).immediate();
		return { execution: this.get(id, principal), newlyClaimed };
	}

	recordCommandStart(id: string, principal: Principal, expectedIndex: number): MultiRepositoryCompatibilityExecution {
		this.#db.transaction(() => {
			const execution = this.get(id, principal);
			if (execution.status !== 'running' || execution.commandsStarted !== expectedIndex) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility gate start does not match the one-use execution sequence');
			const changed = this.#db.prepare("UPDATE multi_repository_compatibility_executions SET commands_started=commands_started+1 WHERE id=? AND status='running' AND commands_started=?")
				.run(id, expectedIndex);
			if (changed.changes !== 1) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility gate start raced with another process');
		}).immediate();
		return this.get(id, principal);
	}

	settle(id: string, resultInput: unknown, principal: Principal): MultiRepositoryCompatibilityExecution {
		const result = v.parse(MultiRepositoryCompatibilityExecutionResultSchema, resultInput);
		this.#db.transaction(() => {
			const execution = this.get(id, principal);
			if (['succeeded', 'blocked', 'failed'].includes(execution.status)) {
				if (digest(execution.result) !== digest(result)) throw new MultiRepositoryCompatibilityExecutionConflictError('Terminal compatibility evidence is immutable');
				return;
			}
			if (execution.status !== 'running' || !execution.manifestSha256 || result.manifestSha256 !== execution.manifestSha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Only a claimed compatibility execution may settle');
			const authorization = this.#authorizations.get(execution.authorizationId, principal);
			this.#assertResults(result, authorization, execution.commandsStarted);
			const changed = this.#db.prepare(`UPDATE multi_repository_compatibility_executions
				SET status=?, result_sha256=?, result_json=?, finished_at=? WHERE id=? AND status='running' AND commands_started=?`)
				.run(result.status, digest(result), JSON.stringify(result), this.#now().toISOString(), id, execution.commandsStarted);
			if (changed.changes !== 1) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility settlement raced with another process');
		}).immediate();
		return this.get(id, principal);
	}

	authorization(id: string, principal: Principal): MultiRepositoryVerificationAuthorization {
		const execution = this.get(id, principal);
		return this.#authorizations.get(execution.authorizationId, principal);
	}

	#assertManifest(manifest: MultiRepositoryCompatibilityManifest, row: ExecutionRow, authorization: MultiRepositoryVerificationAuthorization): void {
		if (manifest.executionId !== row.id) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility manifest belongs to another execution');
		const expected = new Map<string, string>();
		for (const gate of authorization.gates) {
			for (const [repositoryId, patchSha256] of [[gate.repositoryId, gate.repositoryPatchSha256], [gate.dependencyRepositoryId, gate.dependencyPatchSha256]] as const) {
				const prior = expected.get(repositoryId);
				if (prior && prior !== patchSha256) throw new MultiRepositoryCompatibilityExecutionConflictError('Authorization binds conflicting member patch digests');
				expected.set(repositoryId, patchSha256);
			}
		}
		const actual = new Map(manifest.members.map((member) => [member.repositoryId, member.patchSha256]));
		if (actual.size !== manifest.members.length || actual.size !== expected.size || [...expected].some(([key, value]) => actual.get(key) !== value)) {
			throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility manifest does not match the authorized repository patch set');
		}
	}

	#assertResults(result: MultiRepositoryCompatibilityExecutionResult, authorization: MultiRepositoryVerificationAuthorization, commandsStarted: number): void {
		if (result.gates.length !== commandsStarted || result.gates.length > authorization.gates.length) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility results do not match the durable command count');
		for (const [index, value] of result.gates.entries()) {
			const gate = authorization.gates[index];
			if (!gate || value.repositoryId !== gate.repositoryId || value.dependencyRepositoryId !== gate.dependencyRepositoryId
				|| value.gateId !== gate.gate.id || value.result.id !== gate.gate.id || value.result.name !== gate.gate.name
				|| value.result.command !== gate.gate.command) throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility result does not match the authorized gate order');
		}
		const allPassed = result.gates.length === authorization.gates.length && result.gates.every(({ result: gate }) => gate.status === 'passed');
		if ((result.status === 'succeeded') !== (allPassed && result.violations.length === 0)
			|| (result.status === 'blocked' && result.gates.every(({ result: gate }) => gate.status === 'passed') && result.violations.length === 0)) {
			throw new MultiRepositoryCompatibilityExecutionConflictError('Compatibility terminal status disagrees with gate evidence');
		}
	}

	#row(id: string): ExecutionRow {
		const row = this.#db.prepare('SELECT * FROM multi_repository_compatibility_executions WHERE id=?').get(id) as ExecutionRow | undefined;
		if (!row) throw new MultiRepositoryCompatibilityExecutionNotFoundError('Compatibility execution was not found');
		return row;
	}
	#findReplay(ownerId: string, key: string): ExecutionRow | undefined {
		return this.#db.prepare('SELECT * FROM multi_repository_compatibility_executions WHERE owner_id=? AND idempotency_key=?').get(ownerId, key) as ExecutionRow | undefined;
	}
}
