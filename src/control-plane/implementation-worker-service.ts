import { init } from '@flue/runtime';
import * as v from 'valibot';
import { ImplementationWorker } from '../agents/implementation-worker.ts';
import {
	ImplementationPlanSchema,
	ImplementationResultSchema,
	WorkerOutcomeSchema,
	type WorkerInitialData,
	type WorkerOutcome,
} from './execution-contracts.ts';

export type ImplementationWorkerRunner = (input: WorkerInitialData, timeoutMs: number) => Promise<WorkerOutcome>;

export const runImplementationWorker: ImplementationWorkerRunner = async (input, timeoutMs) => {
	const conversationId = `implementation-${input.attemptId}`;
	const agent = init(ImplementationWorker, { id: conversationId, uid: null });
	const receipt = await agent.dispatch({
		message: 'Plan and implement this single bounded task in the supplied worktree, then submit the structured result.',
		initialData: input,
	});
	const reply = await agent.read(receipt, { signal: AbortSignal.timeout(timeoutMs) });
	const plan = reply.data.implementationPlan?.at(-1);
	const result = reply.data.implementationResult?.at(-1);
	if (plan === undefined) throw new Error('Implementation worker completed without a structured plan');
	if (result === undefined) throw new Error('Implementation worker completed without a structured result');
	return v.parse(WorkerOutcomeSchema, {
		conversationId,
		submissionId: reply.submissionId,
		plan: v.parse(ImplementationPlanSchema, plan),
		result: v.parse(ImplementationResultSchema, result),
		text: reply.text,
	});
};
