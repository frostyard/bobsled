import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IntakeConversationRevisionService } from '../src/control-plane/intake-conversation-revision-service.ts';
import { IntakeConversationRevisionConflictError, IntakeConversationRevisionForbiddenError, IntakeConversationRevisionStore } from '../src/control-plane/intake-conversation-revision-store.ts';
import { IntakeConversationConflictError, IntakeConversationStore } from '../src/control-plane/intake-conversation-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal={id:'operator:intake-revision'};const now=()=>new Date('2026-09-03T21:00:00.000Z');
const seed={source:'manual' as const,key:'manual:revision',title:'Refine the website brief',body:'Clarify the audience and acceptance criteria.',labels:[]};
const brief={version:1 as const,repositoryId:'frostyard/frostyard-org',objective:'Clarify the public website.',context:['Preserve the visual structure.'],acceptanceCriteria:['Copy is understandable.'],constraints:['No deployment changes.'],nonGoals:['No redesign.'],assumptions:[],unresolvedQuestions:['Which audience is primary?']};
function createConversation(path:string){const store=new IntakeConversationStore(path,now,(id)=>repositories.find((repository)=>repository.id===id));try{return store.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation');}finally{store.close();}}

test('runs one schema-only revision call and preserves immutable prior revision evidence',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-intake-revision-')),path=join(root,'bobsled.db');const conversation=createConversation(path);const store=new IntakeConversationRevisionStore(path,now);const conversations=new IntakeConversationStore(path,now,(id)=>repositories.find((repository)=>repository.id===id));let calls=0;
	try{
		const reserved=store.reserve({conversationId:conversation.id,expectedVersion:1,message:'The primary audience is prospective users.',reason:'Operator requested a bounded brief refinement.'},principal,'revision-1');assert.equal(reserved.status,'reserved');assert.equal(reserved.modelCallAuthorized,true);assert.equal(conversations.get(conversation.id,principal).version,2);
		assert.throws(()=>conversations.append(conversation.id,{expectedVersion:2,role:'operator',text:'Competing edit.',brief},principal,'competing'),IntakeConversationConflictError);assert.throws(()=>conversations.cancel(conversation.id,{expectedVersion:2,reason:'Competing cancellation is not allowed now.'},principal),IntakeConversationConflictError);
		const revised={...brief,acceptanceCriteria:['Prospective users understand the product.'],unresolvedQuestions:[]};const service=new IntakeConversationRevisionService(store,async(input,id,timeout)=>{calls++;assert.equal(input.turns.at(-1)?.text,'The primary audience is prospective users.');assert.equal(id,reserved.id);assert.equal(timeout,125_000);return{brief:revised,response:'The brief now names prospective users and a measurable outcome.',agentConversationId:`agent-${id}`,agentSubmissionId:'submission-1'};});
		const succeeded=await service.run(reserved.id,principal);assert.equal(succeeded.status,'succeeded');assert.equal(succeeded.modelCalls,1);assert.equal(succeeded.result?.conversationVersion,3);assert.deepEqual(succeeded.result?.brief,revised);assert.equal((await service.run(reserved.id,principal)).id,reserved.id);assert.equal(calls,1);
		const next=store.reserve({conversationId:conversation.id,expectedVersion:3,message:'Also name maintainers as a secondary audience.',reason:'Operator requested a second bounded refinement.'},principal,'revision-2');const twice={...revised,context:[...revised.context,'Maintainers are a secondary audience.']};const second=new IntakeConversationRevisionService(store,async()=>({brief:twice,response:'The secondary audience is now explicit.',agentConversationId:'agent-second',agentSubmissionId:'submission-2'}));assert.equal((await second.run(next.id,principal)).status,'succeeded');assert.deepEqual(store.get(reserved.id,principal).result?.brief,revised);
		const current=conversations.get(conversation.id,principal);assert.equal(current.version,5);assert.deepEqual(current.currentBrief,twice);assert.equal(current.turns.length,4);assert.equal(current.intakeModelCallAuthorized,false);assert.equal(succeeded.runAdmissionAuthorized,false);assert.equal(succeeded.githubMutationAuthorized,false);
		const db=new Database(path);try{assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=42').get() as {count:number}).count,1);}finally{db.close();}
	}finally{conversations.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('claims across processes once and never retries a failed or ambiguous model call',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-intake-claim-')),path=join(root,'bobsled.db');const conversation=createConversation(path);const first=new IntakeConversationRevisionStore(path,now),second=new IntakeConversationRevisionStore(path,now);let runnerCalls=0;
	try{
		const reserved=first.reserve({conversationId:conversation.id,expectedVersion:1,message:'Keep the question unresolved for now.',reason:'Operator requested explicit uncertainty preservation.'},principal,'failure');assert.equal(first.claim(reserved.id,principal).newlyClaimed,true);assert.equal(second.claim(reserved.id,principal).newlyClaimed,false);const failed=first.settleFailure(reserved.id,'The one claimed model call failed.',principal);assert.equal(failed.status,'failed');assert.equal(failed.modelCalls,1);assert.equal(failed.error,'The one claimed model call failed.');assert.match(failed.reason,/uncertainty/);
		const service=new IntakeConversationRevisionService(second,async()=>{runnerCalls++;throw new Error('must not run');});assert.equal((await service.run(reserved.id,principal)).status,'failed');assert.equal(runnerCalls,0);assert.throws(()=>second.get(reserved.id,{id:'operator:other'}),IntakeConversationRevisionForbiddenError);
		const retry=second.reserve({conversationId:conversation.id,expectedVersion:2,message:'Try a new explicit refinement.',reason:'Operator explicitly authorized a distinct new model call.'},principal,'retry');assert.equal(retry.status,'reserved');assert.equal(retry.modelCalls,0);
		assert.throws(()=>second.reserve({conversationId:conversation.id,expectedVersion:3,message:'Competing model work.',reason:'This should conflict with the active revision.'},principal,'competing'),IntakeConversationRevisionConflictError);
		const invalid=new IntakeConversationRevisionService(second,async()=>({brief:{...brief,repositoryId:'frostyard/clix'},response:'Invalid repository switch.',agentConversationId:'agent-invalid',agentSubmissionId:'submission-invalid'}));assert.equal((await invalid.run(retry.id,principal)).status,'failed');assert.equal((await invalid.run(retry.id,principal)).modelCalls,1);
	}finally{second.close();first.close();rmSync(root,{recursive:true,force:true});}
});

test('detects tampering in revision-linked conversation evidence',async()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-intake-tamper-')),path=join(root,'bobsled.db');const conversation=createConversation(path);const store=new IntakeConversationRevisionStore(path,now);
	try{
		const revision=store.reserve({conversationId:conversation.id,expectedVersion:1,message:'Use exact operator facts.',reason:'Operator requested a verifiable brief refinement.'},principal,'tamper');store.claim(revision.id,principal);store.settleFailure(revision.id,'Model call failed.',principal);const db=new Database(path);try{db.prepare("UPDATE intake_conversation_turns SET text='altered' WHERE id=?").run(revision.operatorTurnId);}finally{db.close();}assert.throws(()=>store.get(revision.id,principal),IntakeConversationRevisionConflictError);
	}finally{store.close();rmSync(root,{recursive:true,force:true});}
});
