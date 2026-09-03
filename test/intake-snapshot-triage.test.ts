import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IntakeBriefSnapshotStore } from '../src/control-plane/intake-brief-snapshot-store.ts';
import { IntakeConversationStore } from '../src/control-plane/intake-conversation-store.ts';
import { IntakeSnapshotTriageService } from '../src/control-plane/intake-snapshot-triage-service.ts';
import { IntakeSnapshotTriageConflictError, IntakeSnapshotTriageForbiddenError, IntakeSnapshotTriageStore } from '../src/control-plane/intake-snapshot-triage-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal={id:'operator:snapshot-triage'},other={id:'operator:other'},now=()=>new Date('2026-09-03T23:00:00.000Z'),repository=(id:string)=>repositories.find((candidate)=>candidate.id===id);
const seed={source:'manual' as const,key:'manual:triage',title:'Independently triage a final brief',body:'Use only immutable snapshot evidence.',labels:[]};
const brief={version:1 as const,repositoryId:'frostyard/frostyard-org',objective:'Add a concise product capability statement.',context:['The audience is prospective users.'],acceptanceCriteria:['The capability is described in one plain-language sentence.'],constraints:['Preserve the existing layout.'],nonGoals:['No redesign.'],assumptions:[],unresolvedQuestions:[]};
const decision={route:'ready_for_agent' as const,risk:'low' as const,confidence:0.92,summary:'The bounded copy change is ready.',rationale:'The brief has a measurable outcome and no unresolved product decision.',acceptanceCriteria:brief.acceptanceCriteria,missingInformation:[],suggestedLabels:['bobsled:ready' as const],eligibleForOneClick:true};
function createSnapshot(path:string){const conversations=new IntakeConversationStore(path,now,repository),snapshots=new IntakeBriefSnapshotStore(path,now,conversations);try{const conversation=conversations.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation');return snapshots.finalize({conversationId:conversation.id,expectedVersion:1,reason:'Operator confirmed this exact brief for independent triage.'},principal,'snapshot');}finally{snapshots.close();conversations.close();}}

test('runs one fresh-context triage bound to the immutable snapshot digest',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-snapshot-triage-')),path=join(root,'bobsled.db'),snapshot=createSnapshot(path),store=new IntakeSnapshotTriageStore(path,now),calls:{count:number}={count:0};
	try{
		const reserved=store.reserve({snapshotId:snapshot.id,reason:'Operator explicitly requested independent final-brief triage.'},principal,'triage');assert.equal(reserved.status,'reserved');assert.equal(reserved.modelCallAuthorized,true);
		const service=new IntakeSnapshotTriageService(store,async(input,id,timeout)=>{calls.count++;assert.equal(input.snapshotId,snapshot.id);assert.equal(input.briefSha256,snapshot.briefSha256);assert.deepEqual(input.brief,brief);assert.equal(input.repository.id,brief.repositoryId);assert.equal('turns' in input,false);assert.equal(id,reserved.id);assert.equal(timeout,125_000);return{decision,text:'Independent triage completed.',agentConversationId:`intake-triage-${id}`,agentSubmissionId:'submission-1'};});
		const succeeded=await service.run(reserved.id,principal);assert.equal(succeeded.status,'succeeded');assert.equal(succeeded.modelCalls,1);assert.equal(succeeded.modelCallAuthorized,false);assert.equal(succeeded.result?.snapshotId,snapshot.id);assert.equal(succeeded.result?.briefSha256,snapshot.briefSha256);assert.deepEqual(succeeded.result?.decision,decision);assert.equal(succeeded.runAdmissionAuthorized,false);assert.equal(succeeded.githubMutationAuthorized,false);assert.equal((await service.run(reserved.id,principal)).id,reserved.id);assert.equal(calls.count,1);
		assert.throws(()=>store.reserve({snapshotId:snapshot.id,reason:'A competing triage must not spend another model call.'},principal,'competing'),IntakeSnapshotTriageConflictError);
		const db=new Database(path);try{assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=44').get() as {count:number}).count,1);}finally{db.close();}
	}finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('claims once across processes and never retries model-bearing failure',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-snapshot-triage-claim-')),path=join(root,'bobsled.db'),snapshot=createSnapshot(path),first=new IntakeSnapshotTriageStore(path,now),second=new IntakeSnapshotTriageStore(path,now);let calls=0;
	try{
		const reserved=first.reserve({snapshotId:snapshot.id,reason:'Operator requested one independent triage call.'},principal,'triage');assert.equal(first.claim(reserved.id,principal).newlyClaimed,true);assert.equal(second.claim(reserved.id,principal).newlyClaimed,false);const failed=first.settleFailure(reserved.id,'The claimed independent triage failed.',principal);assert.equal(failed.status,'failed');assert.equal(failed.modelCalls,1);const service=new IntakeSnapshotTriageService(second,async()=>{calls++;throw new Error('must not run');});assert.equal((await service.run(reserved.id,principal)).status,'failed');assert.equal(calls,0);assert.throws(()=>second.get(reserved.id,other),IntakeSnapshotTriageForbiddenError);
	}finally{second.close();first.close();rmSync(root,{recursive:true,force:true});}
});

test('blocks policy denial before reservation and detects retained evidence tampering',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-snapshot-triage-tamper-')),path=join(root,'bobsled.db'),snapshot=createSnapshot(path),denied=new IntakeSnapshotTriageStore(path,now,undefined,()=>undefined);
	try{assert.throws(()=>denied.reserve({snapshotId:snapshot.id,reason:'This policy-denied call must not be reserved.'},principal,'denied'),IntakeSnapshotTriageConflictError);}finally{denied.close();}
	const store=new IntakeSnapshotTriageStore(path,now);try{const triage=store.reserve({snapshotId:snapshot.id,reason:'Operator requested a digest-bound triage.'},principal,'triage');const db=new Database(path);try{db.prepare("UPDATE intake_snapshot_triages SET repository_sha256=? WHERE id=?").run('0'.repeat(64),triage.id);}finally{db.close();}assert.throws(()=>store.get(triage.id,principal),IntakeSnapshotTriageConflictError);}finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('revalidates repository policy at claim and permits explicit zero-call recovery',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-snapshot-triage-policy-')),path=join(root,'bobsled.db'),snapshot=createSnapshot(path);let enabled=true;const store=new IntakeSnapshotTriageStore(path,now,undefined,(id)=>enabled?repository(id):undefined);let calls=0;
	try{const triage=store.reserve({snapshotId:snapshot.id,reason:'Operator requested policy-bound independent triage.'},principal,'triage');enabled=false;const deniedService=new IntakeSnapshotTriageService(store,async()=>{calls++;throw new Error('must not run');});const blocked=await deniedService.run(triage.id,principal);assert.equal(blocked.status,'blocked');assert.equal(blocked.modelCalls,0);assert.equal(blocked.modelCallAuthorized,false);assert.match(blocked.error??'',/policy changed/);assert.equal(calls,0);enabled=true;const retry=store.reserve({snapshotId:snapshot.id,reason:'Operator retried after triage policy was restored.'},principal,'retry');assert.equal(retry.supersedesTriageId,triage.id);const service=new IntakeSnapshotTriageService(store,async()=>{calls++;return{decision,text:'Recovered triage.',agentConversationId:'triage-retry',agentSubmissionId:'submission-retry'};});assert.equal((await service.run(retry.id,principal)).status,'succeeded');assert.equal(calls,1);assert.throws(()=>store.reserve({snapshotId:snapshot.id,reason:'A model-bearing result forbids another attempt.'},principal,'third'),IntakeSnapshotTriageConflictError);const db=new Database(path);try{db.prepare('UPDATE intake_snapshot_triages SET supersedes_triage_id=id WHERE id=?').run(retry.id);}finally{db.close();}assert.throws(()=>store.get(retry.id,principal),IntakeSnapshotTriageConflictError);}finally{store.close();rmSync(root,{recursive:true,force:true});}
});
