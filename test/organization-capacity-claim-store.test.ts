import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
	claimOrganizationCapacity,
	ensureOrganizationCapacityClaimSchema,
	getOrganizationCapacityClaim,
	OrganizationCapacityDispatchInventory,
	recoverExpiredOrganizationCapacityClaims,
	releaseOrganizationCapacity,
} from '../src/control-plane/organization-capacity-claim-store.ts';
import { OrganizationCapacityPolicyStore } from '../src/control-plane/organization-capacity-policy-store.ts';

test('records observe-only provider capacity claims and immutable release evidence', () => {
	const root = mkdtempSync(join(tmpdir(),'bobsled-capacity-claims-')), path = join(root,'bobsled.db');
	const policyStore = new OrganizationCapacityPolicyStore(path, () => new Date('2026-09-04T20:00:00.000Z'));
	policyStore.record({ policy: { maxActiveWorkflows: 1, providerConcurrentCalls: { openaiCodex: 1, githubCopilot: 1 } }, expectedVersion: 0, reason: 'Test observe-only capacity.' }, { id: 'operator' }, 'policy');
	policyStore.close();
	const db = new Database(path); ensureOrganizationCapacityClaimSchema(db);
	const request = { sourceKind: 'execution_attempt', sourceId: 'attempt-1', ownerId: 'operator', repositoryId: 'frostyard/bobsled', slots: { openaiCodex: 1, githubCopilot: 0 } };
	const first = claimOrganizationCapacity(db, request, new Date('2026-09-04T20:01:00.000Z'));
	assert.equal(first.newlyClaimed, true);
	assert.equal(first.claim.status, 'active');
	assert.equal(first.claim.wouldExceedPolicy, false);
	const replay = claimOrganizationCapacity(db, request, new Date('2026-09-04T20:02:00.000Z'));
	assert.equal(replay.newlyClaimed, false);
	const second = claimOrganizationCapacity(db, { ...request, sourceId: 'attempt-2' }, new Date('2026-09-04T20:03:00.000Z'));
	assert.equal(second.claim.wouldExceedPolicy, true);
	const released = releaseOrganizationCapacity(db, 'execution_attempt', 'attempt-1', 'execution.succeeded', new Date('2026-09-04T20:04:00.000Z'));
	assert.equal(released.status, 'released');
	assert.equal(getOrganizationCapacityClaim(db, 'execution_attempt', 'attempt-1')?.releaseReason, 'execution.succeeded');
	assert.throws(() => db.transaction(() => {
		claimOrganizationCapacity(db, { ...request, sourceId: 'rolled-back' });
		throw new Error('source transition failed');
	}).immediate(), /source transition failed/);
	assert.equal(getOrganizationCapacityClaim(db, 'execution_attempt', 'rolled-back'), undefined);
	db.prepare("UPDATE organization_capacity_claims SET owner_id='attacker' WHERE source_id='attempt-1'").run();
	assert.throws(() => getOrganizationCapacityClaim(db, 'execution_attempt', 'attempt-1'), /integrity verification/);
	db.close(); rmSync(root,{recursive:true,force:true});
});

test('reconciles only expired claims as immutable ambiguity and never permits source reuse', () => {
	const root = mkdtempSync(join(tmpdir(),'bobsled-capacity-recovery-')), path = join(root,'bobsled.db');
	const db = new Database(path); ensureOrganizationCapacityClaimSchema(db);
	const request = { sourceKind: 'execution_attempt', sourceId: 'expired-attempt', ownerId: 'operator', repositoryId: 'frostyard/bobsled', slots: { openaiCodex: 1, githubCopilot: 0 } };
	claimOrganizationCapacity(db,request,new Date('2026-09-04T20:00:00.000Z'));
	claimOrganizationCapacity(db,{...request,sourceId:'live-attempt'},new Date('2026-09-04T22:30:00.000Z'));
	const recover = () => db.transaction(() => recoverExpiredOrganizationCapacityClaims(db,{reason:'Provider claim exceeded the bounded lease.'},'operator','recovery-1',new Date('2026-09-04T22:30:01.000Z'))).immediate();
	const first = recover();
	assert.deepEqual(first.recoveredSlots,{openaiCodex:1,githubCopilot:0});
	assert.equal(first.recoveredClaims,1);
	assert.equal(recover().id,first.id);
	const expired = getOrganizationCapacityClaim(db,'execution_attempt','expired-attempt')!;
	assert.equal(expired.status,'ambiguous');
	assert.equal(getOrganizationCapacityClaim(db,'execution_attempt','live-attempt')?.status,'active');
	assert.equal(claimOrganizationCapacity(db,request,new Date('2026-09-04T23:00:00.000Z')).newlyClaimed,false);
	assert.throws(() => releaseOrganizationCapacity(db,'execution_attempt','expired-attempt','late success'),/cannot be released or retried/);
	assert.throws(() => recoverExpiredOrganizationCapacityClaims(db,{reason:'different'},'operator','recovery-1',new Date('2026-09-04T23:00:00.000Z')),/different input/);
	db.prepare("UPDATE organization_capacity_recovery_batches SET result_json='{}' WHERE id=?").run(first.id);
	assert.throws(recover,/malformed|integrity verification/);
	db.close(); rmSync(root,{recursive:true,force:true});
});

test('enumerates every production Flue dispatch module and its durable claim source', () => {
	const controlPlane = resolve(process.cwd(),'src/control-plane');
	const dispatchModules = readdirSync(controlPlane).filter((name) => name.endsWith('.ts') && readFileSync(resolve(controlPlane,name),'utf8').includes('.dispatch(')).sort();
	assert.deepEqual(dispatchModules, OrganizationCapacityDispatchInventory.map(({ dispatchModule }) => dispatchModule).sort());
	for (const entry of OrganizationCapacityDispatchInventory) {
		for (const [index,claimModule] of entry.claimModules.entries()) {
			const source = readFileSync(resolve(controlPlane,claimModule),'utf8');
			assert.match(source,new RegExp(`sourceKind:\\s*['\"]${entry.sourceKinds[index]}['\"]`),`${entry.dispatchModule} must retain its ${entry.sourceKinds[index]} capacity claim`);
		}
	}
});

test('migrates valid migration-50 claims but refuses to bless tampered legacy evidence', () => {
	const root = mkdtempSync(join(tmpdir(),'bobsled-capacity-migration-'));
	const createLegacy = (path: string, ownerId = 'operator') => {
		const db = new Database(path);
		db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
			CREATE TABLE organization_capacity_claims (id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,owner_id TEXT NOT NULL,repository_id TEXT,status TEXT NOT NULL,openai_codex_slots INTEGER NOT NULL,github_copilot_slots INTEGER NOT NULL,policy_version INTEGER,policy_sha256 TEXT,observed_active_workflows INTEGER NOT NULL,observed_openai_codex_slots INTEGER NOT NULL,observed_github_copilot_slots INTEGER NOT NULL,would_exceed_policy INTEGER NOT NULL,request_sha256 TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,claimed_at TEXT NOT NULL,released_at TEXT,release_reason TEXT,UNIQUE(source_kind,source_id));`);
		const request = { sourceKind:'execution_attempt',sourceId:'legacy',ownerId:'operator',repositoryId:'frostyard/bobsled',slots:{openaiCodex:1,githubCopilot:0} };
		const requestSha256 = createHash('sha256').update(JSON.stringify({ownerId:'operator',repositoryId:'frostyard/bobsled',slots:{githubCopilot:0,openaiCodex:1},sourceId:'legacy',sourceKind:'execution_attempt'})).digest('hex');
		const evidence = { id:'claim',sourceKind:'execution_attempt',sourceId:'legacy',ownerId:'operator',repositoryId:'frostyard/bobsled',status:'active',openaiCodexSlots:1,githubCopilotSlots:0,policyVersion:null,policySha256:null,observedActiveWorkflows:0,observedOpenaiCodexSlots:0,observedGithubCopilotSlots:0,wouldExceedPolicy:0,requestSha256,claimedAt:'2026-09-04T20:00:00.000Z',releasedAt:null,releaseReason:null };
		const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])) : input;
		const evidenceSha256 = createHash('sha256').update(JSON.stringify(canonical(evidence))).digest('hex');
		db.prepare('INSERT INTO organization_capacity_claims VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('claim','execution_attempt','legacy',ownerId,'frostyard/bobsled','active',1,0,null,null,0,0,0,0,requestSha256,evidenceSha256,'2026-09-04T20:00:00.000Z',null,null);
		db.close();
	};
	const validPath=join(root,'valid.db'); createLegacy(validPath); const valid=new Database(validPath); ensureOrganizationCapacityClaimSchema(valid);
	assert.equal(getOrganizationCapacityClaim(valid,'execution_attempt','legacy')?.expiresAt,'2026-09-04T22:00:00.000Z'); valid.close();
	const tamperedPath=join(root,'tampered.db'); createLegacy(tamperedPath,'intruder'); const tampered=new Database(tamperedPath);
	assert.throws(() => ensureOrganizationCapacityClaimSchema(tampered),/Legacy organization capacity claim failed integrity verification/); tampered.close();
	rmSync(root,{recursive:true,force:true});
});
