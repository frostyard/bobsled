import * as v from 'valibot';
import { RunRecordSchema, type RunRecord } from './ledger-contracts.ts';
import { DraftPublicationRecordSchema, type DraftPublicationRecord } from './publication-contracts.ts';
import { MultiWorkerOperatorEvidenceSchema, type MultiWorkerOperatorEvidence } from './multi-worker-operator-view.ts';
import { PublicationRebaseRecordSchema, type PublicationRebaseRecord } from './publication-rebase-contracts.ts';
import { PublicationRebaseReviewRecordSchema, type PublicationRebaseReviewRecord } from './publication-rebase-review-contracts.ts';
import { PublicationRecoveryResolutionRecordSchema, type PublicationRecoveryResolutionRecord } from './publication-recovery-resolution-contracts.ts';
import { getRepository } from './repositories.ts';

export const OperatorBoardLaneSchema = v.picklist(['ready', 'working', 'review', 'delivery', 'attention', 'history']);
export const OperatorBoardActionKindSchema = v.picklist([
	'go_fix', 'human_override', 'cancel', 'supersede', 'manual_review', 'revise_task',
	'prepare_publication', 'publish_publication', 'refresh_checks', 'open_pull_request',
	'replay_publication', 'review_publication_replay', 'promote_publication_replay',
	'resolve_publication_supersession',
]);

export const PublicationRecoveryOperatorEvidenceSchema = v.object({
	sourcePublicationId: v.pipe(v.string(), v.uuid()),
	rebase: v.optional(PublicationRebaseRecordSchema),
	review: v.optional(PublicationRebaseReviewRecordSchema),
	promotedPublicationId: v.optional(v.pipe(v.string(), v.uuid())),
	resolution: v.optional(PublicationRecoveryResolutionRecordSchema),
	supersedingCandidate: v.optional(v.object({
		publicationId: v.pipe(v.string(), v.uuid()), pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)), pullUrl: v.string(),
	})),
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

function staleBaseBlocked(publication: DraftPublicationRecord, requireRecoveryPolicy = true): boolean {
	const repository = getRepository(publication.repositoryId);
	if (!repository) return false;
	if (requireRecoveryPolicy && (repository.readOnly || !repository.executionPolicy.enabled || !repository.reviewPolicy.enabled
		|| !repository.publicationPolicy.enabled || !repository.capabilities.writeCode || !repository.capabilities.writeGitHub)) return false;
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
	let summary = 'Have a look before doing anything else with this one.';
	let attention: string | undefined;
	let actions: OperatorBoardAction[] = [];

	if (run.status === 'cancelled') {
		lane = 'history'; phase = 'dropped'; summary = 'You dropped this before anything shipped.';
		actions = [action('supersede', 'Try again with changes')];
	} else if (run.status === 'failed') {
		lane = 'attention'; phase = 'something broke'; attention = 'This stopped partway through and did not finish.';
		summary = 'Look at what it left behind, then start over with a clearer task if it is still worth doing.'; actions = [action('supersede', 'Try again with changes', 'primary')];
	} else if (publication && publicationRecovery?.resolution && staleBaseBlocked(publication, false)) {
		lane = 'history'; phase = 'shipped another way';
		summary = 'A pull request you merged later covered this. The old attempt is kept as-is.';
		actions = publicationRecovery.supersedingCandidate ? [action('open_pull_request', 'Open the merged PR', 'secondary', publicationRecovery.supersedingCandidate.pullUrl)] : [];
	} else if (publication && staleBaseBlocked(publication) && !publicationRecovery?.promotedPublicationId) {
		const rebase = publicationRecovery?.rebase;
		const replayReview = publicationRecovery?.review;
		if (!rebase) {
			lane = 'attention'; phase = 'main moved on'; attention = 'main has moved since this patch was written, so it no longer applies cleanly.';
			summary = 'The same change has to be rebuilt against the current main and re-checked. That costs no model calls.';
			actions = [action('replay_publication', 'Rebuild on latest main', 'primary')];
		} else if (rebase.status === 'pending' || rebase.status === 'running') {
			lane = 'working'; phase = rebase.status === 'pending' ? 'rebuild waiting' : 'rebuilding on latest main';
			summary = 'Replaying the exact same change on the current main and rerunning your tests. No model is involved.';
			actions = rebase.status === 'pending' ? [action('replay_publication', 'Resume the rebuild', 'primary')] : [];
		} else if (rebase.status === 'blocked') {
			lane = 'attention'; phase = 'rebuild stopped'; attention = rebase.detail ?? rebase.blockReason;
			summary = 'The change could not be replayed cleanly on the current main.';
			actions = [
				...(publicationRecovery?.supersedingCandidate ? [action('resolve_publication_supersession', 'Already shipped another way', 'primary')] : [action('replay_publication', 'Try rebuilding again', 'primary')]),
				action('supersede', 'Try again with changes'),
		];
		} else if (!replayReview) {
			lane = 'review'; phase = 'needs another look';
			summary = 'The rebuild passed your tests. It needs one more review before it can go out.';
			actions = [action('review_publication_replay', 'Review it again', 'primary')];
		} else if (replayReview.status === 'pending' || replayReview.status === 'preparing' || replayReview.status === 'running') {
			lane = 'review'; phase = replayReview.status === 'running' ? 'second opinion' : 'review starting';
			summary = 'A second model is reading the rebuilt change. Nothing for you to do.';
			actions = replayReview.status === 'pending' ? [action('review_publication_replay', 'Resume the review', 'primary')] : [];
		} else if (replayReview.status === 'approved') {
			lane = 'delivery'; phase = 'rebuild passed review';
			summary = 'The rebuilt change passed your tests and a fresh review. Ready for a draft PR whenever you want one.';
			actions = [action('promote_publication_replay', 'Prepare draft PR', 'primary')];
		} else {
			lane = 'attention'; phase = replayReview.status === 'blocked' ? 'review said no' : 'review broke';
			attention = replayReview.report?.summary ?? replayReview.detail ?? replayReview.blockReason;
			summary = 'The review would not clear the rebuilt change. Starting over is the way forward.';
			actions = replayReview.modelCalls === 0
				? [action('review_publication_replay', 'Try reviewing again', 'primary'), action('supersede', 'Try again with changes')]
				: [action('supersede', 'Try again with changes', 'primary')];
		}
	} else if (publication) {
		if (publication.status === 'merged') {
			lane = 'history'; phase = 'merged'; summary = 'You merged the pull request. This one is done.';
			actions = publication.pullUrl ? [action('open_pull_request', 'Open the PR', 'secondary', publication.pullUrl)] : [];
		} else if (publication.status === 'closed') {
			lane = 'history'; phase = 'closed, not merged'; summary = 'The pull request was closed without merging. Reopening it on GitHub brings this back.';
			actions = [action('refresh_checks', 'Check again', 'primary'), ...(publication.pullUrl ? [action('open_pull_request', 'Open the PR', 'secondary', publication.pullUrl)] : [])];
		} else if (publication.status === 'ready_for_human') {
			lane = 'delivery'; phase = 'ready for you'; summary = 'The draft PR is open and its checks passed. Merging is yours.';
			actions = [action('open_pull_request', 'Open the draft PR', 'primary', publication.pullUrl), action('refresh_checks', 'Check again')];
		} else if (publication.status === 'checks_pending' || publication.status === 'published') {
			lane = 'delivery'; phase = 'waiting on CI'; summary = 'The draft PR is open and CI is still running.';
			actions = [action('refresh_checks', 'Check again', 'primary'), ...(publication.pullUrl ? [action('open_pull_request', 'Open the draft PR', 'secondary', publication.pullUrl)] : [])];
		} else if (publication.status === 'running' || publication.status === 'pending') {
			lane = 'delivery'; phase = publication.status === 'running' ? 'opening the PR' : 'ready to open';
			summary = publication.status === 'running' ? 'Pushing the branch and opening the draft PR now.' : 'Everything is ready. Opening it on GitHub is one more explicit step.';
			actions = publication.status === 'pending' ? [action('publish_publication', 'Open it on GitHub', 'primary')] : [];
		} else if (publication.status === 'checks_failed') {
			lane = 'attention'; phase = 'CI failed'; attention = publication.blockedReason ?? publication.error ?? 'Required checks did not pass on the draft PR.';
			summary = attention;
			actions = [action('refresh_checks', 'Check again', 'primary'), ...(publication.pullUrl ? [action('open_pull_request', 'Open the draft PR', 'secondary', publication.pullUrl)] : [])];
		} else if (publication.status === 'failed') {
			lane = 'attention'; phase = 'could not open the PR'; attention = publication.blockedReason ?? publication.error ?? 'Opening the draft pull request did not succeed.';
			summary = attention; actions = [action('publish_publication', 'Try publishing again', 'primary')];
		} else {
			lane = 'attention'; phase = 'publishing stopped'; attention = publication.blockedReason ?? publication.error ?? 'This needs a decision from you before it can go out.';
			summary = attention; actions = [];
		}
	} else if (review?.status === 'queued' || review?.status === 'running') {
		lane = 'review'; phase = review.status === 'queued' ? 'review starting' : 'second opinion';
		summary = 'A second model is reading the change with no idea what wrote it. That is the point, and it is automatic.';
		actions = [];
	} else if (review?.status === 'approved') {
		lane = 'delivery'; phase = 'passed review'; summary = 'Review found nothing blocking. Ready for a draft PR whenever you want one.';
		actions = [action('prepare_publication', 'Prepare draft PR', 'primary')];
	} else if (review?.status === 'blocked' || review?.status === 'failed') {
		lane = 'attention'; phase = review.status === 'blocked' ? 'review said no' : 'review broke';
		attention = reviewView?.primaryReport?.summary ?? reviewView?.error ?? 'The review would not clear this change.';
		summary = attention;
		actions = review.status === 'blocked' ? [action('revise_task', 'Rewrite the task', 'primary')] : [action('supersede', 'Try again with changes', 'primary')];
	} else if (run.status === 'active' || attempt?.status === 'queued' || attempt?.status === 'running') {
		lane = 'working'; phase = attempt?.status === 'queued' ? 'starting up' : 'writing code';
		summary = 'Writing the change, then it will run your tests. Nothing reaches GitHub.';
		actions = [action('cancel', 'Stop', 'danger')];
	} else if (run.status === 'pending') {
		lane = 'ready'; phase = 'waiting on you';
		summary = 'One attempt, then it gets reviewed automatically. Nothing reaches GitHub.';
		actions = [action('go_fix', 'Start work', 'primary'), action('cancel', 'Drop it', 'danger')];
	} else if (run.status === 'blocked' && job.attempts.length === 0) {
		lane = 'attention'; phase = 'needs your OK first';
		attention = job.triageDecision?.rationale ?? 'This was flagged for you to look at before any work starts.';
		summary = attention; actions = [action('human_override', 'Approve anyway', 'primary'), action('cancel', 'Drop it', 'danger')];
	} else if (run.status === 'succeeded' && (disposition(run) === 'no_change' || filesChanged === 0)) {
		lane = 'history'; phase = 'nothing needed changing'; summary = 'Your tests confirmed this was already true. There was nothing to change.';
	} else if (run.status === 'succeeded' && (filesChanged ?? 0) > 0 && !review) {
		lane = 'attention'; phase = 'never got reviewed'; attention = 'This one finished before reviews were automatic, so nothing has read it.';
		summary = 'Run the review it missed. New work gets reviewed on its own.'; actions = [action('manual_review', 'Run the review it missed', 'primary')];
	} else if (run.status === 'blocked') {
		lane = 'attention'; phase = 'stopped before finishing';
		attention = disposition(run) === 'blocked' ? 'The agent hit something it could not get past.' : 'This was stopped before it could produce a change.';
		summary = attention; actions = [action('supersede', 'Try again with changes', 'primary')];
	}

	const multiWorkerMayControl = multiWorker && !publication && !review && run.status !== 'cancelled' && run.status !== 'failed';
	if (multiWorkerMayControl && multiWorker.status === 'active') {
		lane = 'working'; phase = 'split across workers'; summary = multiWorker.summary; attention = undefined; actions = [];
	} else if (multiWorkerMayControl && (multiWorker.status === 'not_started' || multiWorker.status === 'waiting')) {
		lane = 'working'; phase = multiWorker.status === 'not_started' ? 'split planned' : 'split waiting';
		summary = multiWorker.summary; attention = undefined; actions = [];
	} else if (multiWorkerMayControl && (multiWorker.status === 'blocked' || multiWorker.status === 'expired')) {
		lane = 'attention'; phase = multiWorker.status === 'expired' ? 'ran out of budget' : 'split stopped';
		attention = multiWorker.reasons[0] ?? multiWorker.summary; summary = multiWorker.summary; actions = [];
	} else if (multiWorkerMayControl && multiWorker.status === 'complete') {
		lane = 'working'; phase = 'pieces done'; summary = `${multiWorker.summary} Putting them back together is next.`; attention = undefined; actions = [];
	}

	return v.parse(OperatorBoardCardSchema, {
		id: run.id, repositoryId: job.repositoryId, workItemKey: job.workItemSnapshot.key,
		title: job.workItemSnapshot.title, lane, phase, attention, summary,
		updatedAt: [run.updatedAt, publication?.updatedAt, multiWorker?.updatedAt, publicationRecovery?.rebase?.updatedAt, publicationRecovery?.review?.updatedAt, publicationRecovery?.resolution?.createdAt]
			.filter((value): value is string => value !== undefined).sort().at(-1)!,
		metrics, actions, run, publication, publicationRecovery, multiWorker,
	});
}

export function projectOperatorBoard(runs: RunRecord[], publications: DraftPublicationRecord[], now = new Date(), multiWorker: MultiWorkerOperatorEvidence[] = [], rebases: PublicationRebaseRecord[] = [], rebaseReviews: PublicationRebaseReviewRecord[] = [], resolutions: PublicationRecoveryResolutionRecord[] = []): OperatorBoardView {
	const byRun = new Map<string, DraftPublicationRecord>();
	for (const publication of publications) if (!byRun.has(publication.runId)) byRun.set(publication.runId, publication);
	const byJob = new Map(multiWorker.map((evidence) => [evidence.jobId, evidence]));
	const publicationById = new Map(publications.map((publication) => [publication.id, publication]));
	const reviewByRebase = new Map<string, PublicationRebaseReviewRecord>();
	for (const review of rebaseReviews) if (!reviewByRebase.has(review.rebaseId)) reviewByRebase.set(review.rebaseId, review);
	const promotedByReview = new Map(publications.filter(({ sourceRebaseReviewId }) => sourceRebaseReviewId).map((publication) => [publication.sourceRebaseReviewId!, publication.id]));
	const resolutionBySource = new Map(resolutions.map((resolution) => [resolution.sourcePublicationId, resolution]));
	const recoveryByRun = new Map<string, PublicationRecoveryOperatorEvidence>();
	for (const rebase of rebases) {
		const source = publicationById.get(rebase.sourcePublicationId); if (!source || recoveryByRun.has(source.runId)) continue;
		const review = reviewByRebase.get(rebase.id);
		const resolution = resolutionBySource.get(source.id);
		const superseding = resolution
			? publicationById.get(resolution.supersedingPublicationId)
			: publications.find((candidate) => candidate.id !== source.id && candidate.ownerId === source.ownerId && candidate.repositoryId === source.repositoryId && candidate.title === source.title && candidate.status === 'merged' && candidate.pullNumber && candidate.pullUrl && candidate.createdAt > source.createdAt);
		recoveryByRun.set(source.runId, {
			sourcePublicationId: source.id, rebase, review, resolution,
			...(review && promotedByReview.has(review.id) ? { promotedPublicationId: promotedByReview.get(review.id) } : {}),
			...(superseding?.pullNumber && superseding.pullUrl ? { supersedingCandidate: { publicationId: superseding.id, pullNumber: superseding.pullNumber, pullUrl: superseding.pullUrl } } : {}),
		});
	}
	return v.parse(OperatorBoardViewSchema, {
		generatedAt: now.toISOString(),
		cards: runs.map((run) => projectRunForBoard(run, byRun.get(run.id), run.jobs[0] ? byJob.get(run.jobs[0].id) : undefined, recoveryByRun.get(run.id))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	});
}
