import * as v from 'valibot';
import { WorkItemSchema, type WorkItem } from './contracts.ts';

const GitHubIssueSchema = v.object({
	number: v.number(),
	title: v.string(),
	body: v.nullable(v.string()),
	html_url: v.pipe(v.string(), v.url()),
	created_at: v.string(),
	updated_at: v.string(),
	user: v.nullable(v.object({ login: v.string() })),
	labels: v.array(
		v.union([
			v.string(),
			v.object({ name: v.nullable(v.string()) }),
		]),
	),
	pull_request: v.optional(v.unknown()),
});

const GitHubIssueListSchema = v.array(GitHubIssueSchema);

export interface GitHubReaderOptions {
	fetch?: typeof fetch;
	apiBaseUrl?: string;
}

/** A deliberately read-only GitHub adapter. It exposes no generic request or mutation method. */
export class GitHubReader {
	readonly #fetch: typeof fetch;
	readonly #apiBaseUrl: string;

	constructor(options: GitHubReaderOptions = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
	}

	async listOpenIssues(repositoryId: string, signal?: AbortSignal): Promise<WorkItem[]> {
		const response = await this.#fetch(
			`${this.#apiBaseUrl}/repos/${repositoryId}/issues?state=open&per_page=100`,
			{
				method: 'GET',
				headers: {
					accept: 'application/vnd.github+json',
					'user-agent': 'bobsled-read-only-intake',
					'x-github-api-version': '2022-11-28',
				},
				signal,
			},
		);

		if (!response.ok) {
			throw new Error(`GitHub issue intake failed with HTTP ${response.status}`);
		}

		const issues = v.parse(GitHubIssueListSchema, await response.json());
		return issues
			.filter((issue) => issue.pull_request === undefined)
			.map((issue) =>
				v.parse(WorkItemSchema, {
					source: 'github_issue',
					key: `issue:${issue.number}`,
					title: issue.title,
					body: issue.body ?? '',
					labels: issue.labels
						.map((label) => (typeof label === 'string' ? label : label.name))
						.filter((label): label is string => label !== null),
					author: issue.user?.login,
					url: issue.html_url,
					createdAt: issue.created_at,
					updatedAt: issue.updated_at,
				}),
			);
	}
}

export const githubReader = new GitHubReader();
