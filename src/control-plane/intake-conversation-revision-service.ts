import { init } from '@flue/runtime';
import * as v from 'valibot';
import { IntakeBriefRevisionAgent } from '../agents/intake-brief-revision.ts';
import { IntakeBriefRevisionInitialDataSchema, IntakeBriefRevisionOutputSchema, type IntakeBriefRevisionInitialData } from './intake-conversation-contracts.ts';
import { IntakeBriefRevisionCandidateSchema, IntakeConversationRevisionStore, type IntakeBriefRevisionCandidate, type IntakeConversationRevision } from './intake-conversation-revision-store.ts';
import type { Principal } from './ledger.ts';

export type IntakeBriefRevisionRunner=(input:IntakeBriefRevisionInitialData,revisionId:string,timeoutMs:number)=>Promise<IntakeBriefRevisionCandidate>;

export const runIntakeBriefRevision:IntakeBriefRevisionRunner=async(input,revisionId,timeoutMs)=>{
	const agentConversationId=`intake-revision-${revisionId}`;
	const agent=init(IntakeBriefRevisionAgent,{id:agentConversationId,uid:null});
	const receipt=await agent.dispatch({message:'Revise the durable intake brief from this conversation and submit one structured result.',initialData:input});
	const reply=await agent.read(receipt,{signal:AbortSignal.timeout(timeoutMs)});
	const output=reply.data.briefRevision?.at(-1);
	if(output===undefined)throw new Error('Intake brief revision completed without structured output');
	return v.parse(IntakeBriefRevisionCandidateSchema,{...v.parse(IntakeBriefRevisionOutputSchema,output),agentConversationId,agentSubmissionId:reply.submissionId});
};

export class IntakeConversationRevisionService{
	readonly #store:IntakeConversationRevisionStore;
	readonly #runner:IntakeBriefRevisionRunner;
	readonly #timeoutMs:number;
	constructor(store=new IntakeConversationRevisionStore(),runner=runIntakeBriefRevision,timeoutMs=125_000){this.#store=store;this.#runner=runner;this.#timeoutMs=timeoutMs;}
	async run(id:string,principal:Principal):Promise<IntakeConversationRevision>{
		const current=this.#store.get(id,principal);if(current.status!=='reserved')return current;
		const conversation=this.#store.contextFor(id,principal);
		const input=v.parse(IntakeBriefRevisionInitialDataSchema,{conversationId:conversation.id,repositoryId:conversation.repositoryId,seed:conversation.seed,currentBrief:conversation.currentBrief,turns:conversation.turns.map(({role,text,brief})=>({role,text,brief}))});
		const claim=this.#store.claim(id,principal);if(!claim.newlyClaimed)return claim.revision;
		let candidate:IntakeBriefRevisionCandidate;try{candidate=v.parse(IntakeBriefRevisionCandidateSchema,await this.#runner(input,id,this.#timeoutMs));if(candidate.brief.repositoryId!==input.repositoryId)throw new Error('Intake model changed repository selection');}catch{return this.#store.settleFailure(id,'Intake brief revision failed after its one model call was claimed',principal);}
		return this.#store.settleSuccess(id,candidate,principal);
	}
}
