import { createAppAuth, type InstallationAccessTokenAuthentication } from '@octokit/auth-app';
import { resolveGitHubPrivateKey, type PrivateKeyReader } from './github-app.ts';
import { getRepository } from './repositories.ts';

const permissionProfiles = {
	issue_metadata_read: { issues: 'read' },
	issue_metadata_write: { issues: 'write' },
	repository_contents_read: { contents: 'read' },
	draft_pr_publish: { contents: 'write', pull_requests: 'write' },
	commit_checks_read: { checks: 'read' },
} as const;

export type GitHubInstallationCapability = keyof typeof permissionProfiles;

export interface GitHubInstallationEnvironment {
	BOBSLED_GITHUB_APP_ID?: string;
	BOBSLED_GITHUB_INSTALLATION_ID?: string;
	BOBSLED_GITHUB_PRIVATE_KEY?: string;
	BOBSLED_GITHUB_PRIVATE_KEY_FILE?: string;
}

export interface ScopedInstallationAuthority {
	repository: string;
	repositoryId: number;
	capability: GitHubInstallationCapability;
	expiresAt: string;
	permissions: Record<string, string>;
	request(path: `/${string}`, init?: RequestInit): Promise<Response>;
}

export class GitHubInstallationConfigurationError extends Error {}
export class GitHubInstallationScopeError extends Error {}

type CreateAuth = (options: Parameters<typeof createAppAuth>[0]) => ReturnType<typeof createAppAuth>;

function positiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Mints the narrowest short-lived token inside a callback so credentials do
 * not become durable application data or escape into model-visible state.
 */
export class GitHubInstallationAuthority {
	readonly #environment: GitHubInstallationEnvironment;
	readonly #createAuth: CreateAuth;
	readonly #fetch: typeof fetch;
	readonly #readPrivateKey?: PrivateKeyReader;

	constructor(
		environment: GitHubInstallationEnvironment = process.env,
		createAuth: CreateAuth = createAppAuth,
		request: typeof fetch = fetch,
		readPrivateKey?: PrivateKeyReader,
	) {
		this.#environment = environment;
		this.#createAuth = createAuth;
		this.#fetch = request;
		this.#readPrivateKey = readPrivateKey;
	}

	async withRequest<T>(
		repositoryName: string,
		capability: GitHubInstallationCapability,
		use: (authority: ScopedInstallationAuthority) => Promise<T>,
	): Promise<T> {
		const repository = getRepository(repositoryName);
		if (!repository || !repository.enabled || !repository.capabilities.read) {
			throw new GitHubInstallationScopeError(`Repository is not enrolled: ${repositoryName}`);
		}
		const appId = positiveInteger(this.#environment.BOBSLED_GITHUB_APP_ID);
		const installationId = positiveInteger(this.#environment.BOBSLED_GITHUB_INSTALLATION_ID);
		const privateKey = resolveGitHubPrivateKey(this.#environment, this.#readPrivateKey);
		if (!appId || !installationId || !privateKey) {
			throw new GitHubInstallationConfigurationError('GitHub App installation authority is not configured');
		}
		const permissions = permissionProfiles[capability];
		const auth = this.#createAuth({ appId, privateKey });
		const authentication = await auth({
			type: 'installation', installationId,
			repositoryIds: [repository.githubRepositoryId], permissions,
		}) as InstallationAccessTokenAuthentication;
		let active = true;
		const scoped: ScopedInstallationAuthority = {
			repository: repository.id,
			repositoryId: repository.githubRepositoryId,
			capability,
			expiresAt: authentication.expiresAt,
			permissions: authentication.permissions,
			request: async (path, init = {}) => {
				if (!active) throw new GitHubInstallationScopeError('Scoped GitHub authority has expired');
				if (!path.startsWith('/') || path.startsWith('//')) throw new GitHubInstallationScopeError('GitHub request path is outside the API origin');
				const headers = new Headers(init.headers);
				headers.set('accept', 'application/vnd.github+json');
				headers.set('authorization', `Bearer ${authentication.token}`);
				headers.set('x-github-api-version', '2026-03-10');
				headers.set('user-agent', 'bobsled-control-plane');
				return this.#fetch(`https://api.github.com${path}`, { ...init, headers });
			},
		};
		try {
			return await use(scoped);
		} finally {
			active = false;
		}
	}
}

export const githubInstallationAuthority = new GitHubInstallationAuthority();
