import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { claimOrganizationCapacity, ensureOrganizationCapacityClaimSchema, getOrganizationCapacityClaim, OrganizationCapacityLimitExceededError, releaseOrganizationCapacity } from '../src/control-plane/organization-capacity-claim-store.ts';
import { OrganizationCapacityEnforcementIntegrityError, OrganizationCapacityEnforcementStore } from '../src/control-plane/organization-capacity-enforcement-store.ts';
import { OrganizationCapacityPolicyStore } from '../src/control-plane/organization-capacity-policy-store.ts';

const limits={maxActiveWorkflows:1,providerConcurrentCalls:{openaiCodex:1,githubCopilot:1}};
const request=(sourceId:string)=>({sourceKind:'execution_attempt',sourceId,ownerId:'operator',repositoryId:'frostyard/bobsled',slots:{openaiCodex:1,githubCopilot:0}});

test('enforces one exact policy version atomically and fails closed on drift',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-capacity-enforcement-')),path=join(root,'bobsled.db'),now=()=>new Date('2026-09-04T21:00:00.000Z');
	const policies=new OrganizationCapacityPolicyStore(path,now),enforcement=new OrganizationCapacityEnforcementStore(path,now),db=new Database(path);ensureOrganizationCapacityClaimSchema(db);
	try{
		const policy=policies.record({policy:limits,expectedVersion:0,reason:'Bound the live conformance limit.'},{id:'operator'},'policy-1');
		const enabled=enforcement.record({mode:'enabled',expectedVersion:0,expectedPolicyVersion:policy.version,reason:'Live dispatch conformance has been reviewed.'},{id:'operator'},'enable-1');
		assert.equal(enabled.mode,'enabled');assert.equal(enforcement.current().mode,'enabled');
		claimOrganizationCapacity(db,request('one'),now());
		assert.throws(()=>claimOrganizationCapacity(db,request('two'),now()),OrganizationCapacityLimitExceededError);
		assert.equal(getOrganizationCapacityClaim(db,'execution_attempt','two'),undefined);
		releaseOrganizationCapacity(db,'execution_attempt','one','execution.succeeded',now());
		assert.equal(claimOrganizationCapacity(db,request('two'),now()).claim.status,'active');
		policies.record({policy:{...limits,maxActiveWorkflows:2},expectedVersion:1,reason:'Revise the workflow limit.'},{id:'operator'},'policy-2');
		assert.equal(enforcement.current().mode,'blocked_policy_drift');
		assert.throws(()=>claimOrganizationCapacity(db,request('three'),now()),/explicitly reviewed/);
		assert.equal(getOrganizationCapacityClaim(db,'execution_attempt','three'),undefined);
		const rebound=enforcement.record({mode:'enabled',expectedVersion:1,expectedPolicyVersion:2,reason:'Review and bind the revised policy.'},{id:'operator'},'enable-2');
		assert.equal(rebound.version,2);assert.equal(enforcement.current().mode,'enabled');
		const disabled=enforcement.record({mode:'disabled',expectedVersion:2,expectedPolicyVersion:2,reason:'Return limits to observation.'},{id:'operator'},'disable');
		assert.equal(disabled.version,3);assert.equal(enforcement.current().mode,'disabled');
		assert.equal(claimOrganizationCapacity(db,request('three'),now()).claim.status,'active');
		assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=52').get() as {count:number}).count,1);
	}finally{db.close();enforcement.close();policies.close();rmSync(root,{recursive:true,force:true});}
});

test('rejects stale activation, expired occupancy, replay conflicts, and tampered events',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-capacity-enforcement-integrity-')),path=join(root,'bobsled.db');
	const policies=new OrganizationCapacityPolicyStore(path,()=>new Date('2026-09-04T20:00:00.000Z')),enforcement=new OrganizationCapacityEnforcementStore(path,()=>new Date('2026-09-04T23:00:01.000Z')),db=new Database(path);ensureOrganizationCapacityClaimSchema(db);
	try{
		policies.record({policy:limits,expectedVersion:0,reason:'Initial limits.'},{id:'operator'},'policy');
		assert.throws(()=>enforcement.record({mode:'enabled',expectedVersion:0,expectedPolicyVersion:2,reason:'Stale policy.'},{id:'operator'},'stale'),/policy changed/);
		claimOrganizationCapacity(db,request('expired'),new Date('2026-09-04T20:00:00.000Z'));
		assert.throws(()=>enforcement.record({mode:'enabled',expectedVersion:0,expectedPolicyVersion:1,reason:'Cannot hide ambiguity.'},{id:'operator'},'expired'),/reconciled/);
		releaseOrganizationCapacity(db,'execution_attempt','expired','execution.failed',new Date('2026-09-04T23:00:02.000Z'));
		const first=enforcement.record({mode:'enabled',expectedVersion:0,expectedPolicyVersion:1,reason:'Enable after settlement.'},{id:'operator'},'enable');
		assert.equal(enforcement.record({mode:'enabled',expectedVersion:0,expectedPolicyVersion:1,reason:'Enable after settlement.'},{id:'operator'},'enable').id,first.id);
		assert.throws(()=>enforcement.record({mode:'disabled',expectedVersion:1,expectedPolicyVersion:1,reason:'Changed replay.'},{id:'operator'},'enable'),/different enforcement input/);
		db.prepare("UPDATE organization_capacity_enforcement_events SET actor_id='intruder' WHERE id=?").run(first.id);
		assert.throws(()=>enforcement.current(),OrganizationCapacityEnforcementIntegrityError);
	}finally{db.close();enforcement.close();policies.close();rmSync(root,{recursive:true,force:true});}
});
