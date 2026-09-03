import { init } from '@flue/runtime';
import * as v from 'valibot';
import { IntakeSnapshotTriageAgent } from '../agents/intake-snapshot-triage.ts';
import { TriageDecisionSchema } from './contracts.ts';
import { IntakeSnapshotTriageCandidateSchema, IntakeSnapshotTriageInitialDataSchema, IntakeSnapshotTriageStore, type IntakeSnapshotTriage, type IntakeSnapshotTriageCandidate, type IntakeSnapshotTriageInitialData } from './intake-snapshot-triage-store.ts';
import type { Principal } from './ledger.ts';

export type IntakeSnapshotTriageRunner=(input:IntakeSnapshotTriageInitialData,triageId:string,timeoutMs:number)=>Promise<IntakeSnapshotTriageCandidate>;
export const runIntakeSnapshotTriage:IntakeSnapshotTriageRunner=async(input,triageId,timeoutMs)=>{const agentConversationId=`intake-triage-${triageId}`,agent=init(IntakeSnapshotTriageAgent,{id:agentConversationId,uid:null}),receipt=await agent.dispatch({message:'Independently triage this immutable finalized brief and submit one structured decision.',initialData:input}),reply=await agent.read(receipt,{signal:AbortSignal.timeout(timeoutMs)}),decision=reply.data.snapshotTriageDecision?.at(-1);if(decision===undefined)throw new Error('Snapshot triage completed without a structured decision');return v.parse(IntakeSnapshotTriageCandidateSchema,{decision:v.parse(TriageDecisionSchema,decision),text:reply.text,agentConversationId,agentSubmissionId:reply.submissionId});};

export class IntakeSnapshotTriageService {
	readonly #store:IntakeSnapshotTriageStore;readonly #runner:IntakeSnapshotTriageRunner;readonly #timeoutMs:number;
	constructor(store=new IntakeSnapshotTriageStore(),runner=runIntakeSnapshotTriage,timeoutMs=125_000){this.#store=store;this.#runner=runner;this.#timeoutMs=timeoutMs;}
	async run(id:string,principal:Principal):Promise<IntakeSnapshotTriage>{const current=this.#store.get(id,principal);if(current.status!=='reserved')return current;const context=this.#store.contextFor(id,principal),input=v.parse(IntakeSnapshotTriageInitialDataSchema,{snapshotId:context.snapshot.id,briefSha256:context.snapshot.briefSha256,brief:context.snapshot.brief,repository:context.repository}),claim=this.#store.claim(id,principal);if(!claim.newlyClaimed)return claim.triage;let candidate:IntakeSnapshotTriageCandidate;try{candidate=v.parse(IntakeSnapshotTriageCandidateSchema,await this.#runner(input,id,this.#timeoutMs));}catch{return this.#store.settleFailure(id,'Independent snapshot triage failed after its one model call was claimed',principal);}return this.#store.settleSuccess(id,candidate,principal);}
}
