import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IntakeBriefSnapshotConflictError, IntakeBriefSnapshotForbiddenError, IntakeBriefSnapshotStore } from '../src/control-plane/intake-brief-snapshot-store.ts';
import { IntakeConversationRevisionStore } from '../src/control-plane/intake-conversation-revision-store.ts';
import { IntakeConversationConflictError, IntakeConversationStore } from '../src/control-plane/intake-conversation-store.ts';
import { repositories } from '../src/control-plane/repositories.ts';

const principal={id:'operator:brief-snapshot'},other={id:'operator:other'},now=()=>new Date('2026-09-03T22:00:00.000Z');
const seed={source:'manual' as const,key:'manual:snapshot',title:'Finalize a website brief',body:'Keep the public site concise.',labels:[]};
const brief={version:1 as const,repositoryId:'frostyard/frostyard-org',objective:'Clarify the public website.',context:['Preserve the visual structure.'],acceptanceCriteria:['Prospective users understand the product.'],constraints:['No deployment changes.'],nonGoals:['No redesign.'],assumptions:[],unresolvedQuestions:[]};
const repository=(id:string)=>repositories.find((candidate)=>candidate.id===id);

test('finalizes one immutable brief with exact source-turn provenance and zero downstream authority',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-brief-snapshot-')),path=join(root,'bobsled.db'),conversations=new IntakeConversationStore(path,now,repository),snapshots=new IntakeBriefSnapshotStore(path,now,conversations);
	try{
		const created=conversations.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation');
		const evolved=conversations.append(created.id,{expectedVersion:1,role:'operator',text:'The brief is complete and ready to freeze.',brief},principal,'turn-1');
		const input={conversationId:created.id,expectedVersion:evolved.version,reason:'Operator confirmed this exact brief for independent triage.'};
		const snapshot=snapshots.finalize(input,principal,'snapshot-1');
		assert.equal(snapshot.sourceVersion,2);assert.equal(snapshot.sourceTurnCount,1);assert.equal(snapshot.sourceTurns.length,1);assert.equal(snapshot.sourceTurns[0]?.id,evolved.turns[0]?.id);assert.deepEqual(snapshot.brief,brief);assert.equal(snapshot.modelCallAuthorized,false);assert.equal(snapshot.triageAuthorized,false);assert.equal(snapshot.runAdmissionAuthorized,false);assert.equal(snapshot.githubMutationAuthorized,false);
		const terminal=conversations.get(created.id,principal);assert.equal(terminal.status,'finalized');assert.equal(terminal.version,3);assert.equal(terminal.terminalReason,undefined);
		assert.equal(snapshots.finalize(input,principal,'snapshot-1').id,snapshot.id);assert.equal(snapshots.getForConversation(created.id,principal).id,snapshot.id);
		assert.throws(()=>snapshots.finalize({...input,reason:'A changed reason must not reuse the finalization key.'},principal,'snapshot-1'),IntakeBriefSnapshotConflictError);
		assert.throws(()=>conversations.append(created.id,{expectedVersion:3,role:'operator',text:'Rewrite history.',brief},principal,'late-turn'),IntakeConversationConflictError);
		assert.throws(()=>snapshots.finalize(input,principal,'competing-snapshot'),IntakeBriefSnapshotConflictError);
		assert.throws(()=>snapshots.get(snapshot.id,other),IntakeBriefSnapshotForbiddenError);
		const db=new Database(path);try{assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=43').get() as {count:number}).count,1);db.prepare("UPDATE intake_conversation_turns SET text='tampered source turn' WHERE id=?").run(snapshot.sourceTurns[0]!.id);}finally{db.close();}
		assert.throws(()=>snapshots.get(snapshot.id,principal),IntakeBriefSnapshotConflictError);
	} finally {snapshots.close();conversations.close();rmSync(root,{recursive:true,force:true});}
});

test('blocks finalization during model work and detects source or snapshot tampering',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-brief-snapshot-tamper-')),path=join(root,'bobsled.db'),conversations=new IntakeConversationStore(path,now,repository),snapshots=new IntakeBriefSnapshotStore(path,now,conversations),revisions=new IntakeConversationRevisionStore(path,now,conversations);
	try{
		const created=conversations.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation');
		const revision=revisions.reserve({conversationId:created.id,expectedVersion:1,message:'Confirm the acceptance criterion.',reason:'Operator requested one bounded clarification before finalization.'},principal,'revision');
		assert.throws(()=>snapshots.finalize({conversationId:created.id,expectedVersion:2,reason:'Operator attempted finalization during active model work.'},principal,'blocked'),IntakeBriefSnapshotConflictError);
		revisions.claim(revision.id,principal);revisions.settleFailure(revision.id,'The one claimed revision failed.',principal);
		const snapshot=snapshots.finalize({conversationId:created.id,expectedVersion:2,reason:'Operator accepted the retained brief after the failed revision.'},principal,'final');
		const db=new Database(path);try{db.prepare("UPDATE intake_brief_snapshots SET source_turns_sha256=? WHERE id=?").run('0'.repeat(64),snapshot.id);}finally{db.close();}
		assert.throws(()=>snapshots.get(snapshot.id,principal),IntakeBriefSnapshotConflictError);
	} finally {revisions.close();snapshots.close();conversations.close();rmSync(root,{recursive:true,force:true});}
});

test('serializes concurrent finalization across database connections',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-brief-snapshot-race-')),path=join(root,'bobsled.db'),conversations=new IntakeConversationStore(path,now,repository),first=new IntakeBriefSnapshotStore(path,now),second=new IntakeBriefSnapshotStore(path,now);
	try{
		const created=conversations.create({repositoryId:brief.repositoryId,seed,brief},principal,'conversation'),input={conversationId:created.id,expectedVersion:1,reason:'Operator confirmed this brief for immutable finalization.'};
		const snapshot=first.finalize(input,principal,'same');assert.equal(second.finalize(input,principal,'same').id,snapshot.id);assert.throws(()=>second.finalize(input,principal,'different'),IntakeBriefSnapshotConflictError);
	} finally {second.close();first.close();conversations.close();rmSync(root,{recursive:true,force:true});}
});

test('creates a new correction conversation without rewriting its source snapshot',()=>{
	const root=mkdtempSync(join(tmpdir(),'bobsled-brief-correction-')),path=join(root,'bobsled.db'),conversations=new IntakeConversationStore(path,now,repository),observer=new IntakeConversationStore(path,now,repository),snapshots=new IntakeBriefSnapshotStore(path,now,conversations);
	try{
		const source=conversations.create({repositoryId:brief.repositoryId,seed,brief},principal,'source-conversation');
		const snapshot=snapshots.finalize({conversationId:source.id,expectedVersion:1,reason:'Operator froze the source brief before requesting a correction.'},principal,'source-snapshot');
		const reason='Operator identified a correction that belongs in a new immutable snapshot.';
		const corrected=conversations.correct(source.id,{reason},principal,'correction');
		assert.equal(corrected.status,'active');assert.equal(corrected.version,1);assert.deepEqual(corrected.seed,seed);assert.deepEqual(corrected.currentBrief,brief);assert.deepEqual(corrected.turns,[]);assert.equal(corrected.supersession?.sourceConversationId,source.id);assert.equal(corrected.supersession?.sourceSnapshotId,snapshot.id);assert.equal(corrected.supersession?.reason,reason);assert.equal(corrected.intakeModelCallAuthorized,false);assert.equal(corrected.runAdmissionAuthorized,false);assert.equal(corrected.githubMutationAuthorized,false);
		assert.equal(observer.correct(source.id,{reason},principal,'correction').id,corrected.id);
		assert.throws(()=>observer.correct(source.id,{reason:'Changed input cannot reuse the correction key.'},principal,'correction'),IntakeConversationConflictError);
		assert.throws(()=>observer.correct(source.id,{reason:'A parallel correction branch must not be created.'},principal,'parallel-correction'),IntakeConversationConflictError);
		assert.deepEqual(snapshots.get(snapshot.id,principal).brief,brief);
		const cancelled=conversations.cancel(corrected.id,{expectedVersion:1,reason:'Operator abandoned this correction attempt without changing its source.'},principal);assert.equal(cancelled.status,'cancelled');
		const retry=observer.correct(source.id,{reason:'Operator explicitly started a replacement after cancelling the prior attempt.'},principal,'correction-retry');assert.equal(retry.status,'active');assert.equal(retry.supersession?.sourceSnapshotId,snapshot.id);
		const db=new Database(path);try{assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=46').get() as {count:number}).count,1);db.prepare("UPDATE intake_conversation_supersessions SET source_brief_sha256=? WHERE conversation_id=?").run('0'.repeat(64),retry.id);}finally{db.close();}
		assert.throws(()=>observer.get(retry.id,principal),IntakeConversationConflictError);
	} finally {snapshots.close();observer.close();conversations.close();rmSync(root,{recursive:true,force:true});}
});
