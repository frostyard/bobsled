import * as v from 'valibot';
import { RunRecordSchema, type RunRecord } from './ledger-contracts.ts';
import { DraftPublicationRecordSchema, type DraftPublicationRecord } from './publication-contracts.ts';
import { MultiWorkerOperatorEvidenceSchema, type MultiWorkerOperatorEvidence } from './multi-worker-operator-view.ts';
import { PublicationRebaseRecordSchema, type PublicationRebaseRecord } from './publication-rebase-contracts.ts';
import { PublicationRebaseReviewRecordSchema, type PublicationRebaseReviewRecord } from './publication-rebase-review-contracts.ts';
import { getRepository } from './repositories.ts';

export const OperatorBoardLaneSchema = v.picklist(['ready', 'working', 'review', 'delivery', 'attention', 'history']);
export const OperatorBoardActionKindSchema = v.picklist([
	'go_fix', 'human_override', 'cancel', 'supersede', 'manual_review', 'revise_task',
	'prepare_publication', 'publish_publication', 'refresh_checks', 'open_pull_request',
	'replay_publication', 'review_publication_replay', 'promote_publication_replay',
]);

export const PublicationRecoveryOperatorEvidenceSchema = v.object({
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	rebase: v.optional(PublicationRebaseRecordSchema),
	review: v.optional(PublicationRebaseReviewRecordSchema),
	promotedPublicationId: v.optional(v.pipe(v.string(), v.uuid())),
});

export type PublicationRecoveryOperatorEvidence = v.InferOutput<typeof PublicationRecoveryOperatorEvidenceSchema>;

export const OperatorBoardActionSchema = v.object({
	kind: OperatorBoardActionKindSchema,
	label: v.string(),
	emphasis: v.picklist(['primary', 'secondary', 'danger']),
	url: v.optional(v.string()),
});

export const OperatorBoardCardSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	repositoryId: v.string(),
	workItemKey: v.string(),
	title: v.string(),
	lane: OperatorBoardLaneSchema,
	phase: v.string(),
	attention: v.optional(v.string()),
	summary: v.string(),
	updatedAt: v.string(),
	metrics: v.object({
		filesChanged: v.optional(v.number()),
		diffLines: v.optional(v.number()),
		gatesPassed: v.optional(v.number()),
		gatesTotal: v.optional(v.number()),
		findings: v.optional(v.number()),
		blockingFindings: v.optional(v.number()),
		checksPassed: v.optional(v.number()),
		checksTotal: v.optional(v.number()),
		activeWorkers: v.optional(v.number()),
		workerTasksSucceeded: v.optional(v.number()),
		workerTasksTotal: v.optional(v.number()),
	}),
	actions: v.array(OperatorBoardActionSchema),
	run: RunRecordSchema,
	publication: v.optional(DraftPublicationRecordSchema),
	publicationRecovery: v.optional(PublicationRecoveryOperatorEvidenceSchema),
	multiWorker: v.optional(MultiWorkerOperatorEvidenceSchema),
});

export const OperatorBoardViewSchema = v.object({
	generatedAt: v.string(),
	cards: v.array(OperatorBoardCardSchema),
});

export type OperatorBoardLane = v.InferOutput<typeof OperatorBoardLaneSchema>;
export type OperatorBoardAction = v.InferOutput<typeof OperatorBoardActionSchema>;
export type OperatorBoardCard = v.InferOutput<typeof OperatorBoardCardSchema>;
export type OperatorBoardView = v.InferOutput<typeof OperatorBoardViewSchema>;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function evidence(run: RunRecord): Record<string, unknown> | undefined {
	const outcome = record(run.jobs[0]?.attempts.at(-1)?.outcome);
	return record(outcome?.evidence);
}

function disposition(run: RunRecord): string | undefined {
	const outcome = record(run.jobs[0]?.attempts.at(-1)?.outcome);
	return typeof record(record(outcome?.worker)?.result)?.disposition === 'string'
		? String(record(record(outcome?.worker)?.result)?.disposition)
		: undefined;
}

function action(kind: OperatorBoardAction['kind'], label: string, emphasis: OperatorBoardAction['emphasis'] = 'secondary', url?: string): OperatorBoardAction {
	return { kind, label, emphasis, ...(url ? { url } : {}) };
}

function staleBaseBlocked(publication: DraftPublicationRecord): boolean {
	const repository = getRepository(publication.repositoryId);
	if (!repository || repository.readOnly || !repository.executionPolicy.enabled || !repository.reviewPolicy.enabled
		|| !repository.publicationPolicy.enabled || !repository.capabilities.writeCode || !repository.capabilities.writeGitHub) return false;
	return publication.status === 'blocked'
		&& publication.blockedReason === `Remote ${repository.defaultBranch} moved beyond the approved base commit`
		&& publication.commitSha === undefined && publication.pullNumber === undefined;
}

export function projectRunForBoard(run: RunRecord, publication?: DraftPublicationRecord, multiWorker?: MultiWorkerOperatorEvidence, publicationRecovery?: PublicationRecoveryOperatorEvidence): OperatorBoardCard {
	const job = run.jobs[0];
	if (!job) throw new Error(`Run ${run.id} has no job to project`);
	const attempt = job.attempts.at(-1);
	const review = job.reviews.at(-1);
	const reviewView = review?.operatorView;
	const patch = evidence(run);
	const filesChanged = typeof patch?.filesChanged === 'number' ? patch.filesChanged : reviewView?.evidence?.filesChanged;
	const diffLines = typeof patch?.diffLines === 'number' ? patch.diffLines : reviewView?.evidence?.diffLines;
	const gates = reviewView?.evidence?.gates ?? (Array.isArray(patch?.gates) ? patch.gates.map(record).filter((item): item is Record<string, unknown> => item !== undefined) : []);
	const report = reviewView?.primaryReport;
	const checksPassed = publication?.checks.filter(({ status, conclusion }) => status === 'completed' && conclusion === 'success').length;
	const metrics = {
		filesChanged, diffLines,
		...(gates.length ? { gatesPassed: gates.filter((gate) => gate.status === 'passed').length, gatesTotal: gates.length } : {}),
		...(report ? { findings: report.findings.length, blockingFindings: report.findings.filter(({ blocking }) => blocking).length } : {}),
		...(publication?.checks.length ? { checksPassed, checksTotal: publication.checks.length } : {}),
		...(multiWorker ? { activeWorkers: multiWorker.activeWorkers, workerTasksSucceeded: multiWorker.tasksSucceeded, workerTasksTotal: multiWorker.tasksTotal } : {}),
	};

	let lane: OperatorBoardLane = 'attention';
	let phase: string = run.status;
	let summary = 'Inspect this run before taking another action.';
	let attention: string | undefined;
	let actions: OperatorBoardAction[] = [];

	if (run.status === 'cancelled') {
		lane = 'history'; phase = 'cancelled'; summary = 'Cancelled without publication.';
		actions = [action('supersede', 'Start revised run')];
	} else if (run.status === 'failed') {
		lane = 'attention'; phase = 'execution failed'; attention = 'Implementation did not complete successfully.';
		summary = 'Inspect retained evidence, then start a revised run if appropriate.'; actions = [action('supersede', 'Start revised run', 'primary')];
	} else if (publication && staleBaseBlocked(publication) && !publicationRecovery?.promotedPublicationId) {
		const rebase = publicationRecovery?.rebase;
		const replayReview = publicationRecovery?.review;
		if (!rebase) {
			lane = 'attention'; phase = 'stale base'; attention = publication.blockedReason;
			summary = 'The approved patch must be replayed and revalidated against the current default branch.';
			actions = [action('replay_publication', 'Replay on current base', 'primary')];
		} else if (rebase.status === 'pending' || rebase.status === 'running') {
			lane = 'working'; phase = rebase.status === 'pending' ? 'replay pending' : 'replaying approved patch';
			summary = 'Bobsled is replaying the exact approved patch and rerunning trusted gates without a model call.';
			actions = rebase.status === 'pending' ? [action('replay_publication', 'Resume replay', 'primary')] : [];
		} else if (rebase.status === 'blocked') {
			lane = 'attention'; phase = 'replay blocked'; attention = rebase.detail ?? rebase.blockReason;
			summary = 'The zero-model stale-base replay could not produce publishable evidence.';
			actions = [action('replay_publication', 'Retry zero-model replay', 'primary'), action('supersede', 'Start revised run')];
		} else if (!replayReview) {
			lane = 'review'; phase = 'fresh review required';
			summary = 'The replay passed current gates and requires one fresh adversarial review before promotion.';
			actions = [action('review_publication_replay', 'Run fresh review', 'primary')];
		} else if (replayReview.status === 'pending' || replayReview.status === 'preparing' || replayReview.status === 'running') {
			lane = 'review'; phase = replayReview.status === 'running' ? 'fresh adversarial review' : 'fresh review pending';
			summary = 'One fresh read-only adversarial review is settling against the replayed patch.';
			actions = replayReview.status === 'pending' ? [action('review_publication_replay', 'Resume fresh review', 'primary')] : [];
		} else if (replayReview.status === 'approved') {
			lane = 'delivery'; phase = 'replay approved';
			summary = 'The replayed patch passed current gates and fresh adversarial review; create a new immutable draft publication attempt.';
			actions = [action('promote_publication_replay', 'Prepare recovered draft PR', 'primary')];
		} else {
			lane = 'attention'; phase = `fresh review ${replayReview.status}`;
			attention = replayReview.report?.summary ?? replayReview.detail ?? replayReview.blockReason;
			summary = 'Fresh review did not authorize promotion; start a revised implementation run.';
			actions = replayReview.modelCalls === 0
				? [action('review_publication_replay', 'Retry fresh review', 'primary'), action('supersede', 'Start revised run')]
				: [action('supersede', 'Start revised run', 'primary')];
		}
	} else if (publication) {
		if (publication.status === 'merged') {
			lane = 'history'; phase = 'merged'; summary = 'The draft pull request was merged by a human.';
			actions = publication.pullUrl ? [action('open_pull_request', 'Open pull request', 'secondary', publication.pullUrl)] : [];
		} else if (publication.status === 'closed') {
			lane = 'history'; phase = 'closed without merge'; summary = 'The draft pull request was closed without merge.';
			actions = [action('refresh_checks', 'Refresh status', 'primary'), ...(publication.pullUrl ? [action('open_pull_request', 'Open pull request', 'secondary', publication.pullUrl)] : [])];
		} else if (publication.status === 'ready_for_human') {
			lane = 'delivery'; phase = 'ready for human'; summary = 'Draft pull request and required checks are ready for human review.';
			actions = [action('open_pull_request', 'Open draft PR', 'primary', publication.pullUrl), action('refresh_checks', 'Refresh status')];
		} else if (publication.status === 'checks_pending' || publication.status === 'published') {
			lane = 'delivery'; phase = 'checks pending'; summary = 'Draft pull request exists; required checks are still running.';
			actions = [action('refresh_checks', 'Refresh status', 'primary'), ...(publication.pullUrl ? [action('open_pull_request', 'Open draft PR', 'secondary', publication.pullUrl)] : [])];
		} else if (publication.status === 'running' || publication.status === 'pending') {
			lane = 'delivery'; phase = publication.status === 'running' ? 'publishing' : 'ready to publish'; summary = 'The reviewed patch is admitted to the policy-gated draft publication flow.';
			actions = publication.status === 'pending' ? [action('publish_publication', 'Publish draft PR', 'primary')] : [];
		} else {
			lane = 'attention'; phase = `publication ${publication.status}`; attention = publication.blockedReason ?? publication.error ?? 'Draft publication requires operator attention.';
			summary = attention;
			actions = publication.status === 'checks_failed'
				? [action('refresh_checks', 'Refresh status', 'primary'), ...(publication.pullUrl ? [action('open_pull_request', 'Open draft PR', 'secondary', publication.pullUrl)] : [])]
				: publication.status === 'failed' ? [action('publish_publication', 'Retry publication', 'primary')] : [];
		}
	} else if (review?.status === 'queued' || review?.status === 'running') {
		lane = 'review'; phase = review.status === 'queued' ? 'review queued' : 'adversarial review'; summary = 'Independent review and trusted verification are running automatically.';
		actions = [];
	} else if (review?.status === 'approved') {
		lane = 'delivery'; phase = 'approved'; summary = 'The exact patch passed adversarial review and is ready for policy-gated delivery.';
		actions = [action('prepare_publication', 'Prepare draft PR', 'primary')];
	} else if (review?.status === 'blocked' || review?.status === 'failed') {
		lane = 'attention'; phase = `review ${review.status}`; attention = reviewView?.primaryReport?.summary ?? reviewView?.error ?? 'Review requires a revised task.';
		summary = attention; actions = review.status === 'blocked' ? [action('revise_task', 'Revise task', 'primary')] : [action('supersede', 'Start revised run', 'primary')];
	} else if (run.status === 'active' || attempt?.status === 'queued' || attempt?.status === 'running') {
		lane = 'working'; phase = attempt?.status === 'queued' ? 'implementation queued' : 'implementing'; summary = 'The bounded worker and trusted quality gates are running.';
		actions = [action('cancel', 'Cancel', 'danger')];
	} else if (run.status === 'pending') {
		lane = 'ready'; phase = 'ready to start'; summary = 'One bounded implementation plus automatic adversarial review is ready for authorization.';
		actions = [action('go_fix', 'Go fix this', 'primary'), action('cancel', 'Cancel', 'danger')];
	} else if (run.status === 'blocked' && job.attempts.length === 0) {
		lane = 'attention'; phase = 'awaiting human approval'; attention = job.triageDecision?.rationale ?? 'Triage requires human approval before implementation.';
		summary = attention; actions = [action('human_override', 'Approve for agent', 'primary'), action('cancel', 'Cancel', 'danger')];
	} else if (run.status === 'succeeded' && (disposition(run) === 'no_change' || filesChanged === 0)) {
		lane = 'history'; phase = 'no change required'; summary = 'Trusted gates confirmed the requested state already exists.';
	} else if (run.status === 'succeeded' && (filesChanged ?? 0) > 0 && !review) {
		lane = 'attention'; phase = 'review recovery'; attention = 'A successful historical patch has no review record.';
		summary = 'Start the mandatory review recovery path; new runs enter review automatically.'; actions = [action('manual_review', 'Start review', 'primary')];
	} else if (run.status === 'blocked') {
		lane = 'attention'; phase = 'implementation blocked'; attention = disposition(run) === 'blocked' ? 'The worker reported a blocker.' : 'Trusted implementation policy blocked the draft.';
		summary = attention; actions = [action('supersede', 'Start revised run', 'primary')];
	}

	const multiWorkerMayControl = multiWorker && !publication && !review && run.status !== 'cancelled' && run.status !== 'failed';
	if (multiWorkerMayControl && multiWorker.status === 'active') {
		lane = 'working'; phase = 'multi-worker fan-out'; summary = multiWorker.summary; attention = undefined; actions = [];
	} else if (multiWorkerMayControl && (multiWorker.status === 'not_started' || multiWorker.status === 'waiting')) {
		lane = 'working'; phase = multiWorker.status === 'not_started' ? 'fan-out planned' : 'fan-out waiting';
		summary = multiWorker.summary; attention = undefined; actions = [];
	} else if (multiWorkerMayControl && (multiWorker.status === 'blocked' || multiWorker.status === 'expired')) {
		lane = 'attention'; phase = multiWorker.status === 'expired' ? 'fan-out budget expired' : 'fan-out blocked';
		attention = multiWorker.reasons[0] ?? multiWorker.summary; summary = multiWorker.summary; actions = [];
	} else if (multiWorkerMayControl && multiWorker.status === 'complete') {
		lane = 'working'; phase = 'fan-out complete'; summary = `${multiWorker.summary} Integration is the next internal stage.`; attention = undefined; actions = [];
	}

	return v.parse(OperatorBoardCardSchema, {
		id: run.id, repositoryId: job.repositoryId, workItemKey: job.workItemSnapshot.key,
		title: job.workItemSnapshot.title, lane, phase, attention, summary,
		updatedAt: [run.updatedAt, publication?.updatedAt, multiWorker?.updatedAt, publicationRecovery?.rebase?.updatedAt, publicationRecovery?.review?.updatedAt]
			.filter((value): value is string => value !== undefined).sort().at(-1)!,
		metrics, actions, run, publication, publicationRecovery, multiWorker,
	});
}

export function projectOperatorBoard(runs: RunRecord[], publications: DraftPublicationRecord[], now = new Date(), multiWorker: MultiWorkerOperatorEvidence[] = [], rebases: PublicationRebaseRecord[] = [], rebaseReviews: PublicationRebaseReviewRecord[] = []): OperatorBoardView {
	const byRun = new Map<string, DraftPublicationRecord>();
	for (const publication of publications) if (!byRun.has(publication.runId)) byRun.set(publication.runId, publication);
	const byJob = new Map(multiWorker.map((evidence) => [evidence.jobId, evidence]));
	const publicationById = new Map(publications.map((publication) => [publication.id, publication]));
	const reviewByRebase = new Map<string, PublicationRebaseReviewRecord>();
	for (const review of rebaseReviews) if (!reviewByRebase.has(review.rebaseId)) reviewByRebase.set(review.rebaseId, review);
	const promotedByReview = new Map(publications.filter(({ sourceRebaseReviewId }) => sourceRebaseReviewId).map((publication) => [publication.sourceRebaseReviewId!, publication.id]));
	const recoveryByRun = new Map<string, PublicationRecoveryOperatorEvidence>();
	for (const rebase of rebases) {
		const source = publicationById.get(rebase.sourcePublicationId); if (!source || recoveryByRun.has(source.runId)) continue;
		const review = reviewByRebase.get(rebase.id);
		recoveryByRun.set(source.runId, { sourcePublicationId: source.id, rebase, review, ...(review && promotedByReview.has(review.id) ? { promotedPublicationId: promotedByReview.get(review.id) } : {}) });
	}
	return v.parse(OperatorBoardViewSchema, {
		generatedAt: now.toISOString(),
		cards: runs.map((run) => projectRunForBoard(run, byRun.get(run.id), run.jobs[0] ? byJob.get(run.jobs[0].id) : undefined, recoveryByRun.get(run.id))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	});
}
