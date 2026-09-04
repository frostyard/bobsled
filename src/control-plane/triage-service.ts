import { init } from '@flue/runtime';
import * as v from 'valibot';
import { Triage } from '../agents/triage.ts';
import {
	TriageApiRequestSchema,
	TriageDecisionSchema,
	type TriageApiRequest,
	type TriageDecision,
} from './contracts.ts';
import { getRepository } from './repositories.ts';
import { organizationCapacityClaims } from './organization-capacity-claim-store.ts';

export interface TriageResult {
	conversationId: string;
	submissionId: string;
	decision: TriageDecision;
	text: string;
}

export async function triageWorkItem(input: unknown, ownerId = 'system:legacy-triage'): Promise<TriageResult> {
	const request: TriageApiRequest = v.parse(TriageApiRequestSchema, input);
	const repository = getRepository(request.repositoryId);
	if (!repository || !repository.capabilities.triage) {
		throw new Error(`Repository is not enrolled for triage: ${request.repositoryId}`);
	}

	const conversationId = `triage-${crypto.randomUUID()}`;
	organizationCapacityClaims.claim({ sourceKind: 'legacy_triage', sourceId: conversationId, ownerId, repositoryId: repository.id, slots: { openaiCodex: 1, githubCopilot: 0 } });
	let releaseReason = 'legacy_triage.failed';
	try {
		const agent = init(Triage, { id: conversationId, uid: null });
		const receipt = await agent.dispatch({
			message: 'Produce a final structured triage decision for this work item.',
			initialData: { repository, workItem: request.workItem },
		});
		const reply = await agent.read(receipt, { signal: AbortSignal.timeout(125_000) });
		const writes = reply.data.triageDecision ?? [];
		const candidate = writes.at(-1);
		if (candidate === undefined) throw new Error('Triage agent completed without a structured decision');
		releaseReason = 'legacy_triage.succeeded';
		return { conversationId, submissionId: reply.submissionId, decision: v.parse(TriageDecisionSchema, candidate), text: reply.text };
	} finally {
		organizationCapacityClaims.release('legacy_triage',conversationId,releaseReason);
	}
}
