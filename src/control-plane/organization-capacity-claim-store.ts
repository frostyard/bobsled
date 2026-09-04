import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { ensureOrganizationCapacityPolicySchema, readCurrentOrganizationCapacityPolicy } from './organization-capacity-policy-store.ts';

const ProviderSlotsSchema = v.pipe(v.object({
	openaiCodex: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1)),
	githubCopilot: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1)),
}), v.check((slots) => slots.openaiCodex + slots.githubCopilot > 0, 'At least one provider slot is required'));

const ClaimRequestSchema = v.object({
	sourceKind: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	sourceId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	repositoryId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
	slots: ProviderSlotsSchema,
});

export type OrganizationCapacityClaimRequest = v.InferOutput<typeof ClaimRequestSchema>;

interface ClaimRow {
	id: string; source_kind: string; source_id: string; owner_id: string; repository_id: string | null;
	status: string; openai_codex_slots: number; github_copilot_slots: number; policy_version: number | null;
	policy_sha256: string | null; observed_active_workflows: number; observed_openai_codex_slots: number;
	observed_github_copilot_slots: number; would_exceed_policy: number; request_sha256: string;
	evidence_sha256: string; claimed_at: string; released_at: string | null; release_reason: string | null;
	expires_at: string; recovered_at: string | null; recovery_reason: string | null; recovered_by: string | null;
}

export interface OrganizationCapacityClaim {
	id: string;
	sourceKind: string;
	sourceId: string;
	ownerId: string;
	repositoryId?: string;
	status: 'active' | 'released' | 'ambiguous';
	slots: v.InferOutput<typeof ProviderSlotsSchema>;
	policyVersion?: number;
	policySha256?: string;
	observed: { activeWorkflows: number; openaiCodexSlots: number; githubCopilotSlots: number };
	wouldExceedPolicy: boolean;
	claimedAt: string;
	releasedAt?: string;
	releaseReason?: string;
	expiresAt: string;
	recoveredAt?: string;
	recoveryReason?: string;
}

export const ORGANIZATION_CAPACITY_CLAIM_LEASE_MS = 2 * 60 * 60_000;

export class OrganizationCapacityClaimConflictError extends Error {}
export class OrganizationCapacityClaimIntegrityError extends Error {}

export const OrganizationCapacityDispatchInventory = Object.freeze([
	{ dispatchModule: 'implementation-worker-service.ts', claimModules: ['ledger.ts'], sourceKinds: ['execution_attempt'] },
	{ dispatchModule: 'intake-conversation-revision-service.ts', claimModules: ['intake-conversation-revision-store.ts'], sourceKinds: ['intake_revision'] },
	{ dispatchModule: 'intake-snapshot-triage-service.ts', claimModules: ['intake-snapshot-triage-store.ts'], sourceKinds: ['intake_snapshot_triage'] },
	{ dispatchModule: 'integration-conflict-agent-service.ts', claimModules: ['integration-conflict-agent-invocation-store.ts'], sourceKinds: ['integration_conflict_agent'] },
	{ dispatchModule: 'integration-worker-service.ts', claimModules: ['integration-invocation-store.ts'], sourceKinds: ['integration_invocation'] },
	{ dispatchModule: 'review-worker-service.ts', claimModules: ['ledger.ts','publication-rebase-review-service.ts'], sourceKinds: ['review','publication_rebase_review'] },
	{ dispatchModule: 'triage-service.ts', claimModules: ['triage-service.ts'], sourceKinds: ['legacy_triage'] },
]);

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

function legacyEvidence(row: ClaimRow): string {
	return digest({
		id: row.id, sourceKind: row.source_kind, sourceId: row.source_id, ownerId: row.owner_id,
		repositoryId: row.repository_id, status: row.status, openaiCodexSlots: row.openai_codex_slots,
		githubCopilotSlots: row.github_copilot_slots, policyVersion: row.policy_version, policySha256: row.policy_sha256,
		observedActiveWorkflows: row.observed_active_workflows, observedOpenaiCodexSlots: row.observed_openai_codex_slots,
		observedGithubCopilotSlots: row.observed_github_copilot_slots, wouldExceedPolicy: row.would_exceed_policy,
		requestSha256: row.request_sha256, claimedAt: row.claimed_at, releasedAt: row.released_at, releaseReason: row.release_reason,
	});
}

export function ensureOrganizationCapacityClaimSchema(db: Database.Database): void {
	ensureOrganizationCapacityPolicySchema(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS organization_capacity_claims (
			id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, owner_id TEXT NOT NULL,
			repository_id TEXT, status TEXT NOT NULL, openai_codex_slots INTEGER NOT NULL,
			github_copilot_slots INTEGER NOT NULL, policy_version INTEGER, policy_sha256 TEXT,
			observed_active_workflows INTEGER NOT NULL, observed_openai_codex_slots INTEGER NOT NULL,
			observed_github_copilot_slots INTEGER NOT NULL, would_exceed_policy INTEGER NOT NULL,
			request_sha256 TEXT NOT NULL, evidence_sha256 TEXT NOT NULL, claimed_at TEXT NOT NULL,
			released_at TEXT, release_reason TEXT, expires_at TEXT NOT NULL,
			recovered_at TEXT, recovery_reason TEXT, recovered_by TEXT, UNIQUE(source_kind,source_id)
		);
		CREATE INDEX IF NOT EXISTS organization_capacity_claims_active_idx
			ON organization_capacity_claims(status,claimed_at) WHERE status='active';
	`);
	const columns = new Set((db.prepare('PRAGMA table_info(organization_capacity_claims)').all() as Array<{ name: string }>).map(({ name }) => name));
	const legacyRows = !columns.has('expires_at') ? db.prepare('SELECT * FROM organization_capacity_claims').all() as ClaimRow[] : [];
	for (const row of legacyRows) if (row.evidence_sha256 !== legacyEvidence(row)) throw new OrganizationCapacityClaimIntegrityError('Legacy organization capacity claim failed integrity verification');
	if (!columns.has('expires_at')) db.exec('ALTER TABLE organization_capacity_claims ADD COLUMN expires_at TEXT');
	if (!columns.has('recovered_at')) db.exec('ALTER TABLE organization_capacity_claims ADD COLUMN recovered_at TEXT');
	if (!columns.has('recovery_reason')) db.exec('ALTER TABLE organization_capacity_claims ADD COLUMN recovery_reason TEXT');
	if (!columns.has('recovered_by')) db.exec('ALTER TABLE organization_capacity_claims ADD COLUMN recovered_by TEXT');
	db.prepare(`UPDATE organization_capacity_claims SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at,'+2 hours') WHERE expires_at IS NULL`).run();
	if (legacyRows.length) {
		for (const row of db.prepare('SELECT * FROM organization_capacity_claims').all() as ClaimRow[]) db.prepare('UPDATE organization_capacity_claims SET evidence_sha256=? WHERE id=?').run(evidence(row),row.id);
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS organization_capacity_recovery_batches (
			id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
			reason TEXT NOT NULL, request_sha256 TEXT NOT NULL, cutoff_at TEXT NOT NULL,
			result_json TEXT NOT NULL, result_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(actor_id,idempotency_key)
		);
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (50,datetime('now'));
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (51,datetime('now'));
	`);
}

function evidence(row: Omit<ClaimRow, 'evidence_sha256'>): string {
	return digest({
		id: row.id, sourceKind: row.source_kind, sourceId: row.source_id, ownerId: row.owner_id,
		repositoryId: row.repository_id, status: row.status, openaiCodexSlots: row.openai_codex_slots,
		githubCopilotSlots: row.github_copilot_slots, policyVersion: row.policy_version, policySha256: row.policy_sha256,
		observedActiveWorkflows: row.observed_active_workflows, observedOpenaiCodexSlots: row.observed_openai_codex_slots,
		observedGithubCopilotSlots: row.observed_github_copilot_slots, wouldExceedPolicy: row.would_exceed_policy,
		requestSha256: row.request_sha256, claimedAt: row.claimed_at, releasedAt: row.released_at, releaseReason: row.release_reason,
		expiresAt: row.expires_at, recoveredAt: row.recovered_at, recoveryReason: row.recovery_reason, recoveredBy: row.recovered_by,
	});
}

function read(row: ClaimRow): OrganizationCapacityClaim {
	const request = { sourceKind: row.source_kind, sourceId: row.source_id, ownerId: row.owner_id, repositoryId: row.repository_id ?? undefined, slots: { openaiCodex: row.openai_codex_slots, githubCopilot: row.github_copilot_slots } };
	const active = row.status === 'active' && row.released_at === null && row.release_reason === null && row.recovered_at === null && row.recovery_reason === null && row.recovered_by === null;
	const released = row.status === 'released' && Boolean(row.released_at) && Boolean(row.release_reason) && row.recovered_at === null && row.recovery_reason === null && row.recovered_by === null;
	const ambiguous = row.status === 'ambiguous' && row.released_at === null && row.release_reason === null && Boolean(row.recovered_at) && Boolean(row.recovery_reason) && Boolean(row.recovered_by);
	const validLifecycle = active || released || ambiguous;
	const validObservation = [row.observed_active_workflows,row.observed_openai_codex_slots,row.observed_github_copilot_slots].every((count) => Number.isInteger(count) && count >= 0)
		&& (row.would_exceed_policy === 0 || row.would_exceed_policy === 1)
		&& (row.policy_version === null) === (row.policy_sha256 === null)
		&& Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.parse(row.claimed_at);
	if (!v.safeParse(ClaimRequestSchema,request).success || !validLifecycle || !validObservation || row.request_sha256 !== digest(request) || row.evidence_sha256 !== evidence(row)) throw new OrganizationCapacityClaimIntegrityError('Stored organization capacity claim failed integrity verification');
	return {
		id: row.id, sourceKind: row.source_kind, sourceId: row.source_id, ownerId: row.owner_id,
		repositoryId: row.repository_id ?? undefined, status: row.status as 'active' | 'released' | 'ambiguous',
		slots: { openaiCodex: row.openai_codex_slots, githubCopilot: row.github_copilot_slots },
		policyVersion: row.policy_version ?? undefined, policySha256: row.policy_sha256 ?? undefined,
		observed: { activeWorkflows: row.observed_active_workflows, openaiCodexSlots: row.observed_openai_codex_slots, githubCopilotSlots: row.observed_github_copilot_slots },
		wouldExceedPolicy: row.would_exceed_policy === 1, claimedAt: row.claimed_at,
		releasedAt: row.released_at ?? undefined, releaseReason: row.release_reason ?? undefined,
		expiresAt: row.expires_at, recoveredAt: row.recovered_at ?? undefined, recoveryReason: row.recovery_reason ?? undefined,
	};
}

export function claimOrganizationCapacity(db: Database.Database, input: unknown, now = new Date()): { claim: OrganizationCapacityClaim; newlyClaimed: boolean } {
	ensureOrganizationCapacityClaimSchema(db);
	const request = v.parse(ClaimRequestSchema, input), requestSha256 = digest(request);
	const existing = db.prepare('SELECT * FROM organization_capacity_claims WHERE source_kind=? AND source_id=?').get(request.sourceKind,request.sourceId) as ClaimRow | undefined;
	if (existing) {
		if (existing.request_sha256 !== requestSha256) throw new OrganizationCapacityClaimConflictError('Capacity source identity was already used for different input');
		return { claim: read(existing), newlyClaimed: false };
	}
	const observed = db.prepare(`SELECT COUNT(*) AS active_workflows,
		COALESCE(SUM(openai_codex_slots),0) AS openai_codex_slots,
		COALESCE(SUM(github_copilot_slots),0) AS github_copilot_slots
		FROM organization_capacity_claims WHERE status='active'`).get() as { active_workflows: number; openai_codex_slots: number; github_copilot_slots: number };
	const policyRecord = readCurrentOrganizationCapacityPolicy(db), policy = policyRecord?.policy;
	const wouldExceed = policy ? observed.active_workflows + 1 > policy.maxActiveWorkflows
		|| observed.openai_codex_slots + request.slots.openaiCodex > policy.providerConcurrentCalls.openaiCodex
		|| observed.github_copilot_slots + request.slots.githubCopilot > policy.providerConcurrentCalls.githubCopilot : false;
	const row: Omit<ClaimRow,'evidence_sha256'> = {
		id: randomUUID(), source_kind: request.sourceKind, source_id: request.sourceId, owner_id: request.ownerId,
		repository_id: request.repositoryId ?? null, status: 'active', openai_codex_slots: request.slots.openaiCodex,
		github_copilot_slots: request.slots.githubCopilot, policy_version: policyRecord?.version ?? null,
		policy_sha256: policyRecord?.policySha256 ?? null, observed_active_workflows: observed.active_workflows,
		observed_openai_codex_slots: observed.openai_codex_slots, observed_github_copilot_slots: observed.github_copilot_slots,
		would_exceed_policy: wouldExceed ? 1 : 0, request_sha256: requestSha256, claimed_at: now.toISOString(), released_at: null, release_reason: null,
		expires_at: new Date(now.getTime() + ORGANIZATION_CAPACITY_CLAIM_LEASE_MS).toISOString(), recovered_at: null, recovery_reason: null, recovered_by: null,
	};
	const evidenceSha256 = evidence(row);
	db.prepare(`INSERT INTO organization_capacity_claims
		(id,source_kind,source_id,owner_id,repository_id,status,openai_codex_slots,github_copilot_slots,policy_version,policy_sha256,
		 observed_active_workflows,observed_openai_codex_slots,observed_github_copilot_slots,would_exceed_policy,request_sha256,evidence_sha256,claimed_at,expires_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.source_kind,row.source_id,row.owner_id,row.repository_id,row.status,row.openai_codex_slots,row.github_copilot_slots,row.policy_version,row.policy_sha256,row.observed_active_workflows,row.observed_openai_codex_slots,row.observed_github_copilot_slots,row.would_exceed_policy,row.request_sha256,evidenceSha256,row.claimed_at,row.expires_at);
	return { claim: read({ ...row, evidence_sha256: evidenceSha256 }), newlyClaimed: true };
}

export function releaseOrganizationCapacity(db: Database.Database, sourceKind: string, sourceId: string, reason: string, now = new Date()): OrganizationCapacityClaim {
	if (!reason || reason.length > 1_000) throw new OrganizationCapacityClaimConflictError('A bounded capacity release reason is required');
	const row = db.prepare('SELECT * FROM organization_capacity_claims WHERE source_kind=? AND source_id=?').get(sourceKind,sourceId) as ClaimRow | undefined;
	if (!row) throw new OrganizationCapacityClaimConflictError('Organization capacity claim was not found');
	const current = read(row);
	if (current.status === 'released') {
		if (current.releaseReason !== reason) throw new OrganizationCapacityClaimConflictError('Capacity release evidence is immutable');
		return current;
	}
	if (current.status === 'ambiguous') throw new OrganizationCapacityClaimConflictError('An ambiguously recovered capacity claim cannot be released or retried');
	const updated: Omit<ClaimRow,'evidence_sha256'> = { ...row, status: 'released', released_at: now.toISOString(), release_reason: reason };
	const evidenceSha256 = evidence(updated);
	const changed = db.prepare("UPDATE organization_capacity_claims SET status='released',released_at=?,release_reason=?,evidence_sha256=? WHERE id=? AND status='active'").run(updated.released_at,reason,evidenceSha256,row.id);
	if (changed.changes !== 1) throw new OrganizationCapacityClaimConflictError('Capacity release raced with another process');
	return read({ ...updated, evidence_sha256: evidenceSha256 });
}

const RecoveryRequestSchema = v.object({ reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)) });
const RecoveryResultSchema = v.object({ id: v.pipe(v.string(),v.uuid()), recoveredClaims: v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(100)), recoveredSlots: v.object({ openaiCodex: v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(100)), githubCopilot: v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(100)) }), cutoffAt: v.string(), createdAt: v.string() });
export type OrganizationCapacityRecoveryBatch = v.InferOutput<typeof RecoveryResultSchema>;

interface RecoveryBatchRow { id: string; actor_id: string; idempotency_key: string; reason: string; request_sha256: string; cutoff_at: string; result_json: string; result_sha256: string; created_at: string; }
function readRecoveryBatch(row: RecoveryBatchRow): OrganizationCapacityRecoveryBatch {
	let result: OrganizationCapacityRecoveryBatch;
	try { result = v.parse(RecoveryResultSchema,JSON.parse(row.result_json)); } catch { throw new OrganizationCapacityClaimIntegrityError('Stored capacity recovery batch is malformed'); }
	const expected = digest({ id: row.id, actorId: row.actor_id, idempotencyKey: row.idempotency_key, reason: row.reason, requestSha256: row.request_sha256, cutoffAt: row.cutoff_at, result, createdAt: row.created_at });
	if (result.id !== row.id || result.cutoffAt !== row.cutoff_at || result.createdAt !== row.created_at || row.result_sha256 !== expected) throw new OrganizationCapacityClaimIntegrityError('Stored capacity recovery batch failed integrity verification');
	return result;
}

export function recoverExpiredOrganizationCapacityClaims(db: Database.Database, input: unknown, actorId: string, idempotencyKey: string, now = new Date()): OrganizationCapacityRecoveryBatch {
	ensureOrganizationCapacityClaimSchema(db);
	const request = v.parse(RecoveryRequestSchema,input);
	if (!actorId || actorId.length > 500 || !idempotencyKey || idempotencyKey.length > 200) throw new OrganizationCapacityClaimConflictError('Bounded actor and Idempotency-Key are required');
	const requestSha256 = digest(request);
	const replay = db.prepare('SELECT * FROM organization_capacity_recovery_batches WHERE actor_id=? AND idempotency_key=?').get(actorId,idempotencyKey) as RecoveryBatchRow | undefined;
	if (replay) {
		if (replay.request_sha256 !== requestSha256) throw new OrganizationCapacityClaimConflictError('Capacity recovery idempotency key was already used for different input');
		return readRecoveryBatch(replay);
	}
	const cutoffAt = now.toISOString();
	const rows = db.prepare("SELECT * FROM organization_capacity_claims WHERE status='active' AND expires_at<=? ORDER BY claimed_at,id LIMIT 100").all(cutoffAt) as ClaimRow[];
	let openaiCodex = 0, githubCopilot = 0;
	for (const row of rows) {
		read(row);
		const updated: Omit<ClaimRow,'evidence_sha256'> = { ...row, status: 'ambiguous', recovered_at: cutoffAt, recovery_reason: request.reason, recovered_by: actorId };
		const evidenceSha256 = evidence(updated);
		const changed = db.prepare("UPDATE organization_capacity_claims SET status='ambiguous',recovered_at=?,recovery_reason=?,recovered_by=?,evidence_sha256=? WHERE id=? AND status='active' AND expires_at<=?").run(cutoffAt,request.reason,actorId,evidenceSha256,row.id,cutoffAt);
		if (changed.changes !== 1) throw new OrganizationCapacityClaimConflictError('Capacity recovery raced with another process');
		openaiCodex += row.openai_codex_slots; githubCopilot += row.github_copilot_slots;
	}
	const result: OrganizationCapacityRecoveryBatch = { id: randomUUID(), recoveredClaims: rows.length, recoveredSlots: { openaiCodex, githubCopilot }, cutoffAt, createdAt: cutoffAt };
	const resultJson = JSON.stringify(result), resultSha256 = digest({ id: result.id, actorId, idempotencyKey, reason: request.reason, requestSha256, cutoffAt, result, createdAt: cutoffAt });
	db.prepare('INSERT INTO organization_capacity_recovery_batches (id,actor_id,idempotency_key,reason,request_sha256,cutoff_at,result_json,result_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(result.id,actorId,idempotencyKey,request.reason,requestSha256,cutoffAt,resultJson,resultSha256,cutoffAt);
	return result;
}

export function getOrganizationCapacityClaim(db: Database.Database, sourceKind: string, sourceId: string): OrganizationCapacityClaim | undefined {
	ensureOrganizationCapacityClaimSchema(db);
	const row = db.prepare('SELECT * FROM organization_capacity_claims WHERE source_kind=? AND source_id=?').get(sourceKind,sourceId) as ClaimRow | undefined;
	return row && read(row);
}

export class OrganizationCapacityClaimStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;
	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000'); this.#now = now;
		ensureOrganizationCapacityClaimSchema(this.#db);
	}
	claim(input: unknown): { claim: OrganizationCapacityClaim; newlyClaimed: boolean } {
		return this.#db.transaction(() => claimOrganizationCapacity(this.#db,input,this.#now())).immediate();
	}
	release(sourceKind: string, sourceId: string, reason: string): OrganizationCapacityClaim {
		return this.#db.transaction(() => releaseOrganizationCapacity(this.#db,sourceKind,sourceId,reason,this.#now())).immediate();
	}
	recoverExpired(input: unknown, actorId: string, idempotencyKey: string): OrganizationCapacityRecoveryBatch {
		return this.#db.transaction(() => recoverExpiredOrganizationCapacityClaims(this.#db,input,actorId,idempotencyKey,this.#now())).immediate();
	}
	get(sourceKind: string, sourceId: string): OrganizationCapacityClaim | undefined { return getOrganizationCapacityClaim(this.#db,sourceKind,sourceId); }
	close(): void { this.#db.close(); }
}

export const organizationCapacityClaims = new OrganizationCapacityClaimStore();
