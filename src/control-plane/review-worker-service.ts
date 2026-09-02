import { init } from '@flue/runtime';
import * as v from 'valibot';
import { AdversarialReviewer } from '../agents/adversarial-reviewer.ts';
import { RemediationWorker } from '../agents/remediation-worker.ts';
import {
	RemediationOutcomeSchema,
	RemediationResultSchema,
	ReviewOutcomeSchema,
	ReviewReportSchema,
	type RemediationInitialData,
	type RemediationOutcome,
	type ReviewInitialData,
	type ReviewOutcome,
} from './execution-contracts.ts';

export type ReviewWorkerRunner = (input: ReviewInitialData, timeoutMs: number) => Promise<ReviewOutcome>;
export type RemediationWorkerRunner = (input: RemediationInitialData, timeoutMs: number) => Promise<RemediationOutcome>;

export const runReviewWorker: ReviewWorkerRunner = async (input, timeoutMs) => {
	const conversationId = `review-${input.reviewId}-${input.round}-${crypto.randomUUID()}`;
	const agent = init(AdversarialReviewer, { id: conversationId, uid: null });
	const receipt = await agent.dispatch({
		message: `Perform the ${input.round} fresh-context adversarial review and submit one structured report.`,
		initialData: input,
	});
	const reply = await agent.read(receipt, { signal: AbortSignal.timeout(timeoutMs) });
	const report = reply.data.reviewReport?.at(-1);
	if (report === undefined) throw new Error('Adversarial reviewer completed without a structured report');
	return v.parse(ReviewOutcomeSchema, {
		conversationId,
		submissionId: reply.submissionId,
		report: v.parse(ReviewReportSchema, report),
		text: reply.text,
	});
};

export const runRemediationWorker: RemediationWorkerRunner = async (input, timeoutMs) => {
	const conversationId = `remediation-${input.reviewId}-${crypto.randomUUID()}`;
	const agent = init(RemediationWorker, { id: conversationId, uid: null });
	const receipt = await agent.dispatch({
		message: 'Address the bounded independent-review findings in this disposable worktree, then submit the structured result.',
		initialData: input,
	});
	const reply = await agent.read(receipt, { signal: AbortSignal.timeout(timeoutMs) });
	const result = reply.data.remediationResult?.at(-1);
	if (result === undefined) throw new Error('Remediation worker completed without a structured result');
	return v.parse(RemediationOutcomeSchema, {
		conversationId,
		submissionId: reply.submissionId,
		result: v.parse(RemediationResultSchema, result),
		text: reply.text,
	});
};
