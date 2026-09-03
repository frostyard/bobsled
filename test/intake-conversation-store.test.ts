import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { repositories } from '../src/control-plane/repositories.ts';
import { IntakeConversationConflictError, IntakeConversationForbiddenError, IntakeConversationStore } from '../src/control-plane/intake-conversation-store.ts';

const principal={id:'operator:intake-test'};const now=()=>new Date('2026-09-03T20:00:00.000Z');
const seed={source:'manual' as const,key:'manual:brief',title:'Clarify the website task',body:'Improve the public explanation without changing deployment.',labels:[]};
const brief={version:1 as const,repositoryId:'frostyard/frostyard-org',objective:'Clarify the public explanation.',context:['Keep the current visual structure.'],acceptanceCriteria:['Copy is understandable.'],constraints:['No deployment changes.'],nonGoals:['No redesign.'],assumptions:[],unresolvedQuestions:['Which audience is primary?']};

test('persists a bounded principal-owned intake conversation without downstream authority',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-intake-'));const path=join(root,'bobsled.db');const first=new IntakeConversationStore(path,now,(id)=>repositories.find((repository)=>repository.id===id));const second=new IntakeConversationStore(path,now,(id)=>repositories.find((repository)=>repository.id===id));
	try{
		const created=first.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation');
		assert.equal(created.status,'active');assert.equal(created.version,1);assert.equal(created.intakeModelCallAuthorized,false);assert.equal(created.runAdmissionAuthorized,false);assert.equal(created.githubMutationAuthorized,false);
		assert.equal(second.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation').id,created.id);
		const revised={...brief,acceptanceCriteria:[...brief.acceptanceCriteria,'Existing quality gates pass.'],unresolvedQuestions:[]};
		const appended=first.append(created.id,{expectedVersion:1,role:'operator',text:'The primary audience is prospective users.',brief:revised},principal,'turn-1');
		assert.equal(appended.version,2);assert.equal(appended.turns.length,1);assert.deepEqual(appended.currentBrief,revised);
		assert.equal(second.append(created.id,{expectedVersion:1,role:'operator',text:'The primary audience is prospective users.',brief:revised},principal,'turn-1').version,2);
		assert.throws(()=>second.append(created.id,{expectedVersion:1,role:'operator',text:'A stale concurrent turn.',brief:revised},principal,'turn-2'),IntakeConversationConflictError);
		assert.throws(()=>second.get(created.id,{id:'operator:other'}),IntakeConversationForbiddenError);
		const cancelled=first.cancel(created.id,{expectedVersion:2,reason:'Operator chose to stop refining this brief.'},principal);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.version,3);assert.match(cancelled.terminalReason??'',/stop refining/);
		assert.throws(()=>first.append(created.id,{expectedVersion:3,role:'operator',text:'Cannot append after cancellation.',brief:revised},principal,'turn-3'),IntakeConversationConflictError);
		const db=new Database(path);try{assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=41').get() as {count:number}).count,1);db.prepare("UPDATE intake_conversation_turns SET brief_json='{}' WHERE conversation_id=?").run(created.id);}finally{db.close();}
		assert.throws(()=>first.get(created.id,principal),/malformed|integrity/);
	}finally{second.close();first.close();rmSync(root,{recursive:true,force:true});}
});
