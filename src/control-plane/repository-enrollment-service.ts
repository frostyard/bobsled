import * as v from 'valibot';
import { RepositoryContractSchema, RepositoryIdSchema, RepositoryPolicyDeclarationSchema, type RepositoryContract } from './contracts.ts';
import { githubInstallationAuthority, type GitHubInstallationAuthority } from './github-installation.ts';
import { repositoryEnrollmentStore, refreshRepositories } from './repositories.ts';
import { RepositoryEnrollmentConflictError, type RepositoryEnrollmentStore } from './repository-enrollment-store.ts';

const CandidateSchema = v.object({
	id: v.pipe(v.number(), v.integer(), v.minValue(1)),
	name: v.pipe(v.string(), v.minLength(1)),
	full_name: RepositoryIdSchema,
	description: v.nullable(v.string()),
	default_branch: v.pipe(v.string(), v.minLength(1)),
	archived: v.boolean(),
	disabled: v.optional(v.boolean()),
});
const ListSchema = v.object({ total_count: v.pipe(v.number(), v.integer(), v.minValue(0)), repositories: v.array(CandidateSchema) });
const ContentSchema = v.object({
	type: v.literal('file'), encoding: v.literal('base64'),
	size: v.pipe(v.number(), v.integer(), v.maxValue(100_000)),
	content: v.pipe(v.string(), v.maxLength(140_000), v.regex(/^[A-Za-z0-9+/=\r\n]+$/)),
});
const ChangeSchema = v.object({ repositoryId: RepositoryIdSchema, expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(0)), reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)) });

export interface RepositoryCandidate { id: string; displayName: string; description: string; defaultBranch: string; archived: boolean; disabled: boolean; enrollmentVersion?: number; enrolled: boolean; enabled: boolean; }
export class RepositoryEnrollmentUpstreamError extends Error {}
export class RepositoryEnrollmentPolicyError extends Error {}

export interface RepositoryEnrollmentGateway {
	list(): Promise<v.InferOutput<typeof CandidateSchema>[]>;
	get(repositoryId: string): Promise<v.InferOutput<typeof CandidateSchema>>;
	policy(candidate: v.InferOutput<typeof CandidateSchema>): Promise<unknown>;
}

export class GitHubRepositoryEnrollmentGateway implements RepositoryEnrollmentGateway {
	readonly #authority: GitHubInstallationAuthority;
	constructor(authority = githubInstallationAuthority) { this.#authority = authority; }
	async list() {
		return this.#authority.withInstallationRequest('repository_metadata_read', async (scoped) => {
			const result: v.InferOutput<typeof CandidateSchema>[] = [];
			for (let page = 1; page <= 10; page += 1) {
				const response = await scoped.request(`/installation/repositories?per_page=100&page=${page}`, { method: 'GET' });
				if (!response.ok) throw new RepositoryEnrollmentUpstreamError(`GitHub repository discovery returned HTTP ${response.status}`);
				const body = v.parse(ListSchema, await response.json());
				result.push(...body.repositories.filter(({ full_name }) => full_name.toLowerCase().startsWith('frostyard/')));
				if (result.length >= body.total_count || body.repositories.length < 100) return result;
			}
			throw new RepositoryEnrollmentUpstreamError('GitHub repository discovery exceeded the 1,000 repository bound');
		});
	}
	async get(repositoryId: string) {
		v.parse(RepositoryIdSchema, repositoryId);
		return this.#authority.withInstallationRequest('repository_metadata_read', async (scoped) => {
			const response = await scoped.request(`/repos/${repositoryId}`, { method: 'GET' });
			if (!response.ok) throw new RepositoryEnrollmentUpstreamError(`GitHub repository metadata returned HTTP ${response.status}`);
			const candidate = v.parse(CandidateSchema, await response.json());
			if (!candidate.full_name.toLowerCase().startsWith('frostyard/')) throw new RepositoryEnrollmentPolicyError('Repository is outside the Frostyard organization');
			return candidate;
		});
	}
	async policy(candidate: v.InferOutput<typeof CandidateSchema>) {
		return this.#authority.withCandidateRequest(candidate.full_name, candidate.id, 'repository_contents_read', async (scoped) => {
			const path = `/repos/${candidate.full_name}/contents/.bobsled/repository.json?ref=${encodeURIComponent(candidate.default_branch)}` as `/${string}`;
			const response = await scoped.request(path, { method: 'GET' });
			if (!response.ok) throw new RepositoryEnrollmentPolicyError(`Repository policy .bobsled/repository.json is unavailable (HTTP ${response.status})`);
			const file = v.parse(ContentSchema, await response.json());
			const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
			if (bytes.byteLength !== file.size) throw new RepositoryEnrollmentPolicyError('Repository policy size does not match GitHub metadata');
			try { return JSON.parse(bytes.toString('utf8')); }
			catch { throw new RepositoryEnrollmentPolicyError('Repository policy is not valid JSON'); }
		});
	}
}

export class RepositoryEnrollmentService {
	readonly #store: RepositoryEnrollmentStore;
	readonly #gateway: RepositoryEnrollmentGateway;
	readonly #refresh: () => readonly RepositoryContract[];
	constructor(store = repositoryEnrollmentStore, gateway: RepositoryEnrollmentGateway = new GitHubRepositoryEnrollmentGateway(), refresh = refreshRepositories) { this.#store = store; this.#gateway = gateway; this.#refresh = refresh; }

	async discover(): Promise<RepositoryCandidate[]> {
		const candidates = await this.#gateway.list();
		return candidates.map((candidate) => {
			const current = this.#store.get(candidate.full_name);
			return { id: candidate.full_name, displayName: candidate.name, description: candidate.description ?? '', defaultBranch: candidate.default_branch, archived: candidate.archived, disabled: candidate.disabled ?? false, enrollmentVersion: current?.version, enrolled: Boolean(current), enabled: current?.repository.enabled ?? false };
		}).sort((left, right) => left.id.localeCompare(right.id));
	}

	#bounded({ repository, version, policySha256, action, createdAt }: ReturnType<RepositoryEnrollmentStore['get']> extends infer T ? NonNullable<T> : never) {
		const { githubRepositoryId: _githubRepositoryId, ...boundedRepository } = repository;
		return { repository: boundedRepository, version, policySha256, action, createdAt };
	}

	list() {
		return this.#store.list().map((record) => this.#bounded(record));
	}

	async enroll(input: unknown, principal: { id: string }, idempotencyKey: string) {
		const request = v.parse(ChangeSchema, input);
		const candidate = await this.#gateway.get(request.repositoryId);
		if (candidate.full_name !== request.repositoryId) throw new RepositoryEnrollmentPolicyError('GitHub canonical repository name differs from the requested enrollment');
		if (candidate.archived || candidate.disabled) throw new RepositoryEnrollmentPolicyError('Archived or disabled repositories cannot be enrolled');
		const declaration = v.parse(RepositoryPolicyDeclarationSchema, await this.#gateway.policy(candidate));
		const { version: _version, ...policy } = declaration;
		const repository = v.parse(RepositoryContractSchema, { id: candidate.full_name, githubRepositoryId: candidate.id, displayName: candidate.name, description: candidate.description ?? '', defaultBranch: candidate.default_branch, enabled: true, ...policy });
		if (!repository.capabilities.read) throw new RepositoryEnrollmentPolicyError('An enrolled repository must permit bounded reads');
		const gateIds = new Set(repository.qualityGates.map(({ id }) => id));
		if (repository.executionPolicy.requiredGateIds.some((id) => !gateIds.has(id))) throw new RepositoryEnrollmentPolicyError('Every required execution gate must exist in qualityGates');
		const result = this.#store.record({ repository, expectedVersion: request.expectedVersion, reason: request.reason }, principal, idempotencyKey);
		this.#refresh();
		return this.#bounded(result);
	}

	disable(input: unknown, principal: { id: string }, idempotencyKey: string) {
		const request = v.parse(ChangeSchema, input);
		const current = this.#store.get(request.repositoryId);
		if (!current) throw new RepositoryEnrollmentConflictError('Repository is not enrolled');
		const result = this.#store.record({ repository: { ...current.repository, enabled: false }, expectedVersion: request.expectedVersion, reason: request.reason }, principal, idempotencyKey);
		this.#refresh();
		return this.#bounded(result);
	}
}

export const repositoryEnrollmentService = new RepositoryEnrollmentService();
