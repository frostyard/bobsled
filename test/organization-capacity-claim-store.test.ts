import assert from 'node:assert/strict';
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
