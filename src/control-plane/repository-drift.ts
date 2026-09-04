import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { githubInstallationAuthority, type GitHubInstallationAuthority } from './github-installation.ts';
import { repositories } from './repositories.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';

const GitHubRepositoryMetadataSchema = v.object({
	id: v.pipe(v.number(), v.integer(), v.minValue(1)),
	full_name: RepositoryIdSchema,
	default_branch: v.pipe(v.string(), v.minLength(1)),
	archived: v.boolean(),
	disabled: v.optional(v.boolean()),
});

export const RepositoryDriftFindingSchema = v.object({
	kind: v.picklist(['repository_identity', 'repository_name', 'default_branch', 'archived', 'disabled', 'unreachable']),
	expected: v.optional(v.string()),
	observed: v.optional(v.string()),
});

export const RepositoryDriftRecordSchema = v.object({
	repositoryId: RepositoryIdSchema,
	status: v.picklist(['aligned', 'drifted', 'unavailable']),
	checkedAt: v.string(),
	policyDigest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
	policy: v.object({
		enabled: v.boolean(),
		readOnly: v.boolean(),
		executionEnabled: v.boolean(),
		reviewEnabled: v.boolean(),
		publicationEnabled: v.boolean(),
		multiWorkerEnabled: v.boolean(),
	}),
	findings: v.array(RepositoryDriftFindingSchema),
});

export type RepositoryDriftRecord = v.InferOutput<typeof RepositoryDriftRecordSchema>;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

function digest(repository: RepositoryContract): string {
	return createHash('sha256').update(JSON.stringify(canonical(repository))).digest('hex');
}

function policy(repository: RepositoryContract): RepositoryDriftRecord['policy'] {
	return {
		enabled: repository.enabled,
		readOnly: repository.readOnly,
		executionEnabled: repository.executionPolicy.enabled,
		reviewEnabled: repository.reviewPolicy.enabled,
		publicationEnabled: repository.publicationPolicy.enabled,
		multiWorkerEnabled: repository.multiWorkerPolicy.enabled,
	};
}

export class RepositoryDriftService {
	readonly #authority: GitHubInstallationAuthority;
	readonly #repositories: readonly RepositoryContract[];
	readonly #now: () => Date;

	constructor(authority = githubInstallationAuthority, enrolled = repositories, now = () => new Date()) {
		this.#authority = authority;
		this.#repositories = enrolled;
		this.#now = now;
	}

	async inspectAll(): Promise<RepositoryDriftRecord[]> {
		const records: RepositoryDriftRecord[] = [];
		// Keep installation-token minting and GitHub reads bounded and sequential.
		for (const repository of this.#repositories) records.push(await this.#inspect(repository));
		return records;
	}

	async #inspect(repository: RepositoryContract): Promise<RepositoryDriftRecord> {
		const checkedAt = this.#now().toISOString();
		const base = { repositoryId: repository.id, checkedAt, policyDigest: digest(repository), policy: policy(repository) };
		try {
			const observed = await this.#authority.withRequest(repository.id, 'repository_metadata_read', async (scoped) => {
				const response = await scoped.request(`/repositories/${repository.githubRepositoryId}`, { method: 'GET' });
				if (!response.ok) throw new Error(`GitHub repository metadata returned HTTP ${response.status}`);
				return v.parse(GitHubRepositoryMetadataSchema, await response.json());
			});
			const findings: RepositoryDriftRecord['findings'] = [];
			if (observed.id !== repository.githubRepositoryId) findings.push({ kind: 'repository_identity' });
			if (observed.full_name !== repository.id) findings.push({ kind: 'repository_name', expected: repository.id, observed: observed.full_name });
			if (observed.default_branch !== repository.defaultBranch) findings.push({ kind: 'default_branch', expected: repository.defaultBranch, observed: observed.default_branch });
			if (observed.archived) findings.push({ kind: 'archived', expected: 'active', observed: 'archived' });
			if (observed.disabled) findings.push({ kind: 'disabled', expected: 'enabled', observed: 'disabled' });
			return v.parse(RepositoryDriftRecordSchema, { ...base, status: findings.length ? 'drifted' : 'aligned', findings });
		} catch {
			return v.parse(RepositoryDriftRecordSchema, { ...base, status: 'unavailable', findings: [{ kind: 'unreachable' }] });
		}
	}
}

export const repositoryDriftService = new RepositoryDriftService();
