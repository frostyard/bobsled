import { init } from '@flue/runtime';
import * as v from 'valibot';
import { IntegrationWorker } from '../agents/integration-worker.ts';
import {
	IntegrationWorkerOutcomeSchema,
	IntegrationWorkerResultSchema,
	type IntegrationWorkerInitialData,
	type IntegrationWorkerOutcome,
} from './integration-worker-contracts.ts';

export type IntegrationWorkerRunner = (input: IntegrationWorkerInitialData, timeoutMs: number) => Promise<IntegrationWorkerOutcome>;

export const runIntegrationWorker: IntegrationWorkerRunner = async (input, timeoutMs) => {
	const conversationId = `integration-${input.integrationAttemptId}`;
	const agent = init(IntegrationWorker, { id: conversationId, uid: null });
	const receipt = await agent.dispatch({
		message: 'Complete the single bounded integration task against the staged prerequisite stack, then submit the structured result.',
		initialData: input,
	});
	const reply = await agent.read(receipt, { signal: AbortSignal.timeout(timeoutMs) });
	const result = reply.data.integrationResult?.at(-1);
	if (result === undefined) throw new Error('Integration worker completed without a structured result');
	return v.parse(IntegrationWorkerOutcomeSchema, {
		conversationId,
		submissionId: reply.submissionId,
		result: v.parse(IntegrationWorkerResultSchema, result),
		text: reply.text,
	});
};
