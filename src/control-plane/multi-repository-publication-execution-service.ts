import { JobLedger, type Principal } from './ledger.ts';
import {
	MultiRepositoryPublicationExecutionStore,
	type MultiRepositoryPublicationExecution,
	type MultiRepositoryPublicationExecutionMember,
} from './multi-repository-publication-execution-store.ts';
import {
	DraftPublicationService,
	PublicationPolicyBlockedError,
} from './publication-service.ts';
import type { DraftPublicationRecord } from './publication-contracts.ts';
import { dataPath } from '../paths.ts';

interface PublicationAdapter {
	admit(input: unknown, principal: Principal, idempotencyKey: string): Promise<DraftPublicationRecord>;
	execute(id: string, principal: Principal): Promise<DraftPublicationRecord>;
	get(id: string, principal: Principal): DraftPublicationRecord;
	close?(): void;
}

export interface MultiRepositoryPublicationExecutionServiceOptions {
	path?: string;
	store?: MultiRepositoryPublicationExecutionStore;
	publications?: PublicationAdapter;
}

const publishedStatuses = new Set<DraftPublicationRecord['status']>(['published', 'checks_pending', 'checks_failed', 'ready_for_human', 'merged']);

export class MultiRepositoryPublicationExecutionService {
	readonly #store: MultiRepositoryPublicationExecutionStore;
	readonly #publications: PublicationAdapter;
	readonly #ledger?: JobLedger;
	readonly #ownsStore: boolean;
	readonly #ownsPublications: boolean;

	constructor(options: MultiRepositoryPublicationExecutionServiceOptions = {}) {
		const path = options.path ?? dataPath('bobsled.db');
		this.#store = options.store ?? new MultiRepositoryPublicationExecutionStore(path);
		this.#ownsStore = !options.store;
		if (options.publications) {
			this.#publications = options.publications;
			this.#ownsPublications = false;
		} else {
			this.#ledger = new JobLedger(path);
			this.#publications = new DraftPublicationService({ path, ledger: this.#ledger });
			this.#ownsPublications = true;
		}
	}

	close(): void {
		if (this.#ownsPublications) this.#publications.close?.();
		this.#ledger?.close();
		if (this.#ownsStore) this.#store.close();
	}

	async run(executionId: string, principalId: string): Promise<MultiRepositoryPublicationExecution> {
		const principal = { id: principalId };
		let execution = this.#store.get(executionId, principal);
		if (['succeeded', 'partial', 'blocked', 'failed'].includes(execution.status) || execution.status === 'running') return execution;
		const authorization = this.#store.authorizationFor(executionId, principal);
		if (execution.status === 'reserved') {
			const byRepository = new Map(authorization.members.map((member) => [member.repositoryId, member]));
			const members: MultiRepositoryPublicationExecutionMember[] = [];
			for (const repositoryId of authorization.rolloutLayers.flat()) {
				const member = byRepository.get(repositoryId);
				if (!member) throw new Error(`Linked publication rollout references a missing member: ${repositoryId}`);
				const run = this.#ledger?.get(member.runId, principal);
				const expectedVersion = run?.version ?? 1;
				const publication = await this.#publications.admit({
					runId: member.runId,
					expectedVersion,
					reason: `Create the linked draft for change set ${authorization.changeSetId}; human merge remains required.`,
				}, principal, `change-set:${execution.id}:${repositoryId}`);
				if (publication.repositoryId !== repositoryId || publication.runId !== member.runId
					|| publication.reviewId !== member.reviewId || publication.approvedPatchSha256 !== member.patchSha256
					|| publication.baseCommit !== member.baseCommit) throw new Error(`Draft-publication intent does not match linked evidence: ${repositoryId}`);
				members.push({
					repositoryId, publicationId: publication.id, runId: member.runId, reviewId: member.reviewId,
					patchSha256: member.patchSha256, branchName: publication.branchName, marker: publication.marker,
					status: publication.status, rolloutLayer: member.rolloutLayer,
				});
			}
			execution = this.#store.recordPreflight(execution.id, {
				version: 1, executionId: execution.id, authorizationId: authorization.id, members,
				githubMutationAuthorized: false, rolloutAuthorized: false, mergeAuthorized: false,
			}, principal);
			const blocked = members.find(({ status }) => status !== 'pending');
			if (blocked) return this.#store.settle(execution.id, {
				manifestSha256: execution.manifestSha256, status: 'blocked', members,
				failedRepositoryId: blocked.repositoryId,
				reason: `All linked draft intents must pass preflight before the first GitHub mutation; ${blocked.repositoryId} is ${blocked.status}.`,
				rolloutAuthorized: false, mergeAuthorized: false,
			}, principal);
		}
		const claim = this.#store.claim(execution.id, principal);
		if (!claim.newlyClaimed) return claim.execution;
		execution = claim.execution;
		for (let index = 0; index < execution.manifest!.members.length; index += 1) {
			const member = execution.manifest!.members[index]!;
			this.#store.recordPublicationStart(execution.id, principal, index);
			try {
				const publication = await this.#publications.execute(member.publicationId, principal);
				if (publication.repositoryId !== member.repositoryId || publication.id !== member.publicationId || !publishedStatuses.has(publication.status)) {
					throw new Error(`Linked draft was not created for ${member.repositoryId}`);
				}
			} catch (error) {
				const members = this.#currentMembers(execution.manifest!.members, principal);
				const partial = members.some(({ status }) => publishedStatuses.has(status));
				return this.#store.settle(execution.id, {
					manifestSha256: execution.manifestSha256, status: partial ? 'partial' : error instanceof PublicationPolicyBlockedError ? 'blocked' : 'failed',
					members, failedRepositoryId: member.repositoryId,
					reason: (error instanceof Error ? error.message : 'Linked draft publication failed').slice(0, 4_000),
					rolloutAuthorized: false, mergeAuthorized: false,
				}, principal);
			}
		}
		const members = this.#currentMembers(execution.manifest!.members, principal);
		return this.#store.settle(execution.id, {
			manifestSha256: execution.manifestSha256, status: 'succeeded', members,
			reason: 'Every linked draft pull request exists; rollout and merge remain human-controlled.',
			rolloutAuthorized: false, mergeAuthorized: false,
		}, principal);
	}

	#currentMembers(manifest: readonly MultiRepositoryPublicationExecutionMember[], principal: Principal): MultiRepositoryPublicationExecutionMember[] {
		return manifest.map((member) => ({ ...member, status: this.#publications.get(member.publicationId, principal).status }));
	}
}
