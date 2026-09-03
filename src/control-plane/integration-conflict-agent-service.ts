import { init } from '@flue/runtime';
import * as v from 'valibot';
import { IntegrationConflictWorker } from '../agents/integration-conflict-worker.ts';
import {
	IntegrationConflictAgentOutcomeSchema,
	IntegrationConflictAgentResultSchema,
	type IntegrationConflictAgentInitialData,
	type IntegrationConflictAgentOutcome,
} from './integration-conflict-agent-contracts.ts';

export type IntegrationConflictAgentRunner = (
	input: IntegrationConflictAgentInitialData,
	timeoutMs: number,
) => Promise<IntegrationConflictAgentOutcome>;

export const runIntegrationConflictAgent: IntegrationConflictAgentRunner = async (input, timeoutMs) => {
	const conversationId = `integration-conflict-${input.agentAttemptId}`;
	const agent = init(IntegrationConflictWorker, { id: conversationId, uid: null });
	const receipt = await agent.dispatch({
		message: 'Resolve only the authenticated conflict paths, stage those resolutions, and submit one structured result.',
		initialData: input,
	});
	const reply = await agent.read(receipt, { signal: AbortSignal.timeout(timeoutMs) });
	const result = reply.data.conflictResult?.at(-1);
	if (result === undefined) throw new Error('Conflict resolver completed without a structured result');
	return v.parse(IntegrationConflictAgentOutcomeSchema, {
		conversationId, submissionId: reply.submissionId,
		result: v.parse(IntegrationConflictAgentResultSchema, result), text: reply.text,
	});
};
