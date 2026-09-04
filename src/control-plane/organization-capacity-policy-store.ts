import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';

const BoundedCountSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32));
export const OrganizationCapacityPolicySchema = v.pipe(v.object({
	maxActiveWorkflows: BoundedCountSchema,
	providerConcurrentCalls: v.object({ openaiCodex: BoundedCountSchema, githubCopilot: BoundedCountSchema }),
}), v.check((policy) => policy.providerConcurrentCalls.openaiCodex <= policy.maxActiveWorkflows && policy.providerConcurrentCalls.githubCopilot <= policy.maxActiveWorkflows, 'Provider limits cannot exceed the organization workflow limit'));
export type OrganizationCapacityPolicy = v.InferOutput<typeof OrganizationCapacityPolicySchema>;

const PrincipalSchema = v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) });
const RecordRequestSchema = v.object({
	policy: OrganizationCapacityPolicySchema,
	expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(0)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

interface PolicyRow {
	id: string; version: number; policy_sha256: string; policy_json: string; actor_id: string;
	idempotency_key: string; request_sha256: string; event_sha256: string; reason: string; created_at: string;
}

export interface OrganizationCapacityPolicyRecord {
	policy: OrganizationCapacityPolicy;
	version: number;
	policySha256: string;
	actorId: string;
	reason: string;
	createdAt: string;
}

export class OrganizationCapacityPolicyConflictError extends Error {}
export class OrganizationCapacityPolicyIntegrityError extends Error {}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function ensureOrganizationCapacityPolicySchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS organization_capacity_policy_events (
			id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, policy_sha256 TEXT NOT NULL, policy_json TEXT NOT NULL,
			actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, event_sha256 TEXT NOT NULL,
			reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_id,idempotency_key)
		);
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (49,datetime('now'));
	`);
}

export class OrganizationCapacityPolicyStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;
	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000'); this.#now = now;
		ensureOrganizationCapacityPolicySchema(this.#db);
	}
	close(): void { this.#db.close(); }

	current(): OrganizationCapacityPolicyRecord | undefined {
		const row = this.#db.prepare('SELECT * FROM organization_capacity_policy_events ORDER BY version DESC LIMIT 1').get() as PolicyRow | undefined;
		return row && this.#read(row);
	}

	history(): OrganizationCapacityPolicyRecord[] {
		return (this.#db.prepare('SELECT * FROM organization_capacity_policy_events ORDER BY version').all() as PolicyRow[]).map((row) => this.#read(row));
	}

	record(input: unknown, principal: { id: string }, idempotencyKey: string): OrganizationCapacityPolicyRecord {
		const request = v.parse(RecordRequestSchema, input), actor = v.parse(PrincipalSchema, principal);
		if (!idempotencyKey || idempotencyKey.length > 200) throw new OrganizationCapacityPolicyConflictError('A bounded Idempotency-Key is required');
		const requestSha256 = digest(request);
		return this.#db.transaction(() => {
			const replay = this.#db.prepare('SELECT * FROM organization_capacity_policy_events WHERE actor_id=? AND idempotency_key=?').get(actor.id,idempotencyKey) as PolicyRow | undefined;
			if (replay) {
				if (replay.request_sha256 !== requestSha256) throw new OrganizationCapacityPolicyConflictError('Idempotency key was already used for different capacity policy input');
				return this.#read(replay);
			}
			const current = this.#db.prepare('SELECT version FROM organization_capacity_policy_events ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
			if ((current?.version ?? 0) !== request.expectedVersion) throw new OrganizationCapacityPolicyConflictError('Organization capacity policy changed; reload before updating it');
			const version = (current?.version ?? 0) + 1, timestamp = this.#now().toISOString(), policyJson = JSON.stringify(request.policy), policySha256 = digest(request.policy), id = randomUUID();
			const eventSha256 = digest({ id, version, policySha256, actorId: actor.id, idempotencyKey, requestSha256, reason: request.reason, createdAt: timestamp });
			this.#db.prepare('INSERT INTO organization_capacity_policy_events (id,version,policy_sha256,policy_json,actor_id,idempotency_key,request_sha256,event_sha256,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,version,policySha256,policyJson,actor.id,idempotencyKey,requestSha256,eventSha256,request.reason,timestamp);
			return this.#read(this.#db.prepare('SELECT * FROM organization_capacity_policy_events WHERE id=?').get(id) as PolicyRow);
		}).immediate();
	}

	#read(row: PolicyRow): OrganizationCapacityPolicyRecord {
		let policy: OrganizationCapacityPolicy;
		try { policy = v.parse(OrganizationCapacityPolicySchema, JSON.parse(row.policy_json)); }
		catch { throw new OrganizationCapacityPolicyIntegrityError('Stored organization capacity policy is malformed'); }
		const eventSha256 = digest({ id: row.id, version: row.version, policySha256: row.policy_sha256, actorId: row.actor_id, idempotencyKey: row.idempotency_key, requestSha256: row.request_sha256, reason: row.reason, createdAt: row.created_at });
		if (digest(policy) !== row.policy_sha256 || digest({ policy, expectedVersion: row.version - 1, reason: row.reason }) !== row.request_sha256 || eventSha256 !== row.event_sha256) throw new OrganizationCapacityPolicyIntegrityError('Stored organization capacity policy failed integrity verification');
		return { policy, version: row.version, policySha256: row.policy_sha256, actorId: row.actor_id, reason: row.reason, createdAt: row.created_at };
	}
}

export const organizationCapacityPolicyStore = new OrganizationCapacityPolicyStore();
