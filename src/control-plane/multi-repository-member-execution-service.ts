import { resolve } from 'node:path';
import type { RunRecord } from './ledger-contracts.ts';
import { jobLedger, LedgerConflictError, type JobLedger, type Principal } from './ledger.ts';
import { executionService, type ExecutionService } from './execution-service.ts';
import { reviewService, type ReviewService } from './review-service.ts';
import { isAutomaticReviewEligible } from './run-orchestration-service.ts';
import { MultiRepositoryMemberExecutionPreflightService } from './multi-repository-member-execution-preflight-service.ts';
import { MultiRepositoryMemberExecutionReservationStore } from './multi-repository-member-execution-reservation-store.ts';

export interface ClaimedMemberExecutionRunner {
	executeClaimed: ExecutionService['executeClaimed'];
}

export interface MemberAutomaticReviewRunner {
	reviewAutomatically: ReviewService['reviewAutomatically'];
}

export interface MultiRepositoryMemberExecutionServiceOptions {
	store?: MultiRepositoryMemberExecutionReservationStore;
	preflight?: MultiRepositoryMemberExecutionPreflightService;
	execution?: ClaimedMemberExecutionRunner;
	review?: MemberAutomaticReviewRunner;
	ledger?: JobLedger;
	workspaceRoot?: string;
}

export class MultiRepositoryMemberExecutionService {
	readonly #store: MultiRepositoryMemberExecutionReservationStore;
	readonly #preflight: MultiRepositoryMemberExecutionPreflightService;
	readonly #execution: ClaimedMemberExecutionRunner;
	readonly #review: MemberAutomaticReviewRunner;
	readonly #ledger: JobLedger;
	readonly #workspaceRoot: string;

	constructor(options: MultiRepositoryMemberExecutionServiceOptions = {}) {
		this.#store = options.store ?? new MultiRepositoryMemberExecutionReservationStore();
		this.#preflight = options.preflight ?? new MultiRepositoryMemberExecutionPreflightService(this.#store);
		this.#execution = options.execution ?? executionService;
		this.#review = options.review ?? reviewService;
		this.#ledger = options.ledger ?? jobLedger;
		this.#workspaceRoot = resolve(options.workspaceRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces');
	}

	async run(reservationId: string, ownerId: string): Promise<RunRecord> {
		const principal: Principal = { id: ownerId };
		const claim = await this.#preflight.run(reservationId, ownerId);
		let run: RunRecord;
		if (claim.newlyClaimed) {
			const context = this.#store.claimedExecution(reservationId, principal, this.#workspaceRoot);
			run = await this.#execution.executeClaimed(
				context.execution, context.paths, context.baseCommit, context.preparation, principal,
			);
			this.#store.settle(reservationId, principal);
		} else {
			run = this.#ledger.get(claim.reservation.runId, principal);
			if (claim.reservation.status === 'running' && ['succeeded', 'blocked', 'failed'].includes(run.status)) {
				this.#store.settle(reservationId, principal);
			}
		}

		if (!isAutomaticReviewEligible(run)) return run;
		try {
			return await this.#review.reviewAutomatically(run.id, run.version, principal);
		} catch (error) {
			if (!(error instanceof LedgerConflictError)) throw error;
			return this.#ledger.get(run.id, principal);
		}
	}
}
