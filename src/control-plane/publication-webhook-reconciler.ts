import * as v from 'valibot';
import type { GitHubEventStore, RecordedWebhook } from './github-events.ts';
import type { DraftPublicationRecord } from './publication-contracts.ts';
import type { DraftPublicationService, PublicationWebhookSignal } from './publication-service.ts';

const ShaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const RepositorySchema = v.object({ full_name: v.string() });
const PullRequestPayloadSchema = v.looseObject({
	repository: RepositorySchema,
	pull_request: v.object({
		number: v.pipe(v.number(), v.integer(), v.minValue(1)),
		head: v.object({ sha: ShaSchema }),
	}),
});
const CheckRunPayloadSchema = v.looseObject({
	repository: RepositorySchema,
	check_run: v.looseObject({ head_sha: ShaSchema }),
});

export class PublicationWebhookReconciliationError extends Error {}

export interface PublicationWebhookTarget {
	refreshMatchingWebhook(signal: PublicationWebhookSignal): Promise<DraftPublicationRecord[]>;
}

export class PublicationWebhookReconciler {
	readonly #events: GitHubEventStore;
	readonly #publications: PublicationWebhookTarget;

	constructor(events: GitHubEventStore, publications: PublicationWebhookTarget | DraftPublicationService) {
		this.#events = events;
		this.#publications = publications;
	}

	async reconcile(delivery: RecordedWebhook): Promise<number> {
		if (delivery.status !== 'accepted' || !['pull_request', 'check_run'].includes(delivery.eventName)) return 0;
		const bytes = this.#events.readExactPayload(delivery.deliveryId);
		if (!bytes) throw new PublicationWebhookReconciliationError('Verified webhook payload is unavailable for publication reconciliation');
		let payload: unknown;
		try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
		catch { throw new PublicationWebhookReconciliationError('Verified webhook payload is not valid JSON'); }
		let signal: PublicationWebhookSignal;
		try {
			if (delivery.eventName === 'pull_request') {
				const parsed = v.parse(PullRequestPayloadSchema, payload);
				signal = { repositoryId: parsed.repository.full_name, commitSha: parsed.pull_request.head.sha, pullNumber: parsed.pull_request.number };
			} else {
				const parsed = v.parse(CheckRunPayloadSchema, payload);
				signal = { repositoryId: parsed.repository.full_name, commitSha: parsed.check_run.head_sha };
			}
		} catch {
			throw new PublicationWebhookReconciliationError('Verified webhook payload lacks bounded publication lifecycle evidence');
		}
		if (delivery.repositoryFullName?.toLowerCase() !== signal.repositoryId.toLowerCase()) {
			throw new PublicationWebhookReconciliationError('Verified webhook repository evidence is inconsistent');
		}
		return (await this.#publications.refreshMatchingWebhook(signal)).length;
	}
}
