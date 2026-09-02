import type { RunRecord } from './ledger-contracts.ts';
import type { Principal } from './ledger.ts';
import { executionService } from './execution-service.ts';
import { reviewService } from './review-service.ts';

export interface ExecutionRunner {
	execute(runId: string, input: unknown, principal: Principal): Promise<RunRecord>;
}

export interface AutomaticReviewRunner {
	reviewAutomatically(runId: string, expectedVersion: number, principal: Principal): Promise<RunRecord>;
}

export function isAutomaticReviewEligible(run: RunRecord): boolean {
	const job = run.jobs[0];
	const attempt = job?.attempts.at(-1);
	const outcome = attempt?.outcome as { evidence?: { filesChanged?: number } } | undefined;
	return run.status === 'succeeded' &&
		job?.status === 'succeeded' &&
		job.policySnapshot.reviewPolicy?.enabled === true &&
		(job.reviews.length === 0) &&
		(outcome?.evidence?.filesChanged ?? 0) > 0;
}

export class RunOrchestrationService {
	constructor(
		private readonly execution: ExecutionRunner = executionService,
		private readonly review: AutomaticReviewRunner = reviewService,
	) {}

	async execute(runId: string, input: unknown, principal: Principal): Promise<RunRecord> {
		const completed = await this.execution.execute(runId, input, principal);
		if (!isAutomaticReviewEligible(completed)) return completed;
		return this.review.reviewAutomatically(completed.id, completed.version, principal);
	}
}

export const runOrchestrationService = new RunOrchestrationService();
