import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	auditGitHubPermissions,
	GitHubInstallationAuthority,
	GitHubInstallationConfigurationError,
	GitHubInstallationScopeError,
	type ScopedInstallationAuthority,
} from '../src/control-plane/github-installation.ts';

test('audits verified installation permissions against the declared capability ceiling', () => {
	assert.deepEqual(auditGitHubPermissions(), { status: 'unobserved', excessPermissions: [] });
	assert.deepEqual(auditGitHubPermissions({
		repositorySelection: 'all',
		permissions: { metadata: 'read', issues: 'write', contents: 'read' },
		recordedAt: '2026-09-02T19:00:00.000Z',
	}), {
		status: 'within_policy',
		repositorySelection: 'all',
		observedAt: '2026-09-02T19:00:00.000Z',
		excessPermissions: [],
	});
	assert.deepEqual(auditGitHubPermissions({
		repositorySelection: 'all',
		permissions: { workflows: 'write', checks: 'write', metadata: 'read' },
		recordedAt: '2026-09-02T19:00:00.000Z',
	}), {
		status: 'exceeds_policy',
		repositorySelection: 'all',
		observedAt: '2026-09-02T19:00:00.000Z',
		excessPermissions: [
			{ name: 'checks', granted: 'write', maximum: 'read' },
			{ name: 'workflows', granted: 'write', maximum: undefined },
		],
	});
});

const environment = {
	BOBSLED_GITHUB_APP_ID: '123',
	BOBSLED_GITHUB_INSTALLATION_ID: '456',
	BOBSLED_GITHUB_PRIVATE_KEY: 'test-private-key',
};

test('mints a repository-ID-scoped token with a typed permission profile', async () => {
	let strategy: Record<string, unknown> | undefined;
	let request: Record<string, unknown> | undefined;
	let scopedRequest: ScopedInstallationAuthority['request'] | undefined;
	let apiAuthorization: string | null = null;
	const authority = new GitHubInstallationAuthority(environment, ((options: Record<string, unknown>) => {
		strategy = options;
		return async (authOptions: Record<string, unknown>) => {
			request = authOptions;
			return {
				type: 'token', tokenType: 'installation', token: 'short-lived-token', installationId: 456,
				createdAt: '2026-09-01T12:00:00Z', expiresAt: '2026-09-01T13:00:00Z',
				permissions: { issues: 'write' }, repositorySelection: 'selected', repositoryIds: [1172846628],
			};
		};
	}) as never, async (input, init) => {
		apiAuthorization = new Headers(init?.headers).get('authorization');
		return Response.json({ url: String(input) });
	});
	const result = await authority.withRequest('frostyard/clix', 'issue_metadata_write', async (scoped) => {
		scopedRequest = scoped.request;
		const response = await scoped.request('/repos/frostyard/clix', { headers: { authorization: 'Bearer attacker-value' } });
		return {
			repository: scoped.repository, repositoryId: scoped.repositoryId,
			permissions: scoped.permissions, expiresAt: scoped.expiresAt,
			response: await response.json(),
		};
	});
	assert.deepEqual(strategy, { appId: 123, privateKey: 'test-private-key' });
	assert.deepEqual(request, {
		type: 'installation', installationId: 456,
		repositoryIds: [1172846628], permissions: { issues: 'write' },
	});
	assert.deepEqual(result, {
		repository: 'frostyard/clix', repositoryId: 1172846628,
		permissions: { issues: 'write' }, expiresAt: '2026-09-01T13:00:00Z',
		response: { url: 'https://api.github.com/repos/frostyard/clix' },
	});
	assert.equal(apiAuthorization, 'Bearer short-lived-token');
	await assert.rejects(scopedRequest!('/user'), /expired/);
});

test('rejects unenrolled repositories and missing authority before minting', async () => {
	const configured = new GitHubInstallationAuthority(environment);
	await assert.rejects(configured.withRequest('frostyard/not-enrolled', 'issue_metadata_read', async () => undefined), GitHubInstallationScopeError);
	const unconfigured = new GitHubInstallationAuthority({});
	await assert.rejects(unconfigured.withRequest('frostyard/clix', 'issue_metadata_read', async () => undefined), GitHubInstallationConfigurationError);
});

test('loads installation key material from the configured protected file', async () => {
	let strategy: Record<string, unknown> | undefined;
	let reads = 0;
	const authority = new GitHubInstallationAuthority({
		BOBSLED_GITHUB_APP_ID: '123',
		BOBSLED_GITHUB_INSTALLATION_ID: '456',
		BOBSLED_GITHUB_PRIVATE_KEY: 'stale-inline-key',
		BOBSLED_GITHUB_PRIVATE_KEY_FILE: '/protected/github-app.pem',
	}, ((options: Record<string, unknown>) => {
		strategy = options;
		return async () => ({
			type: 'token', tokenType: 'installation', token: 'short-lived-token', installationId: 456,
			createdAt: '2026-09-01T12:00:00Z', expiresAt: '2026-09-01T13:00:00Z',
			permissions: { issues: 'read' }, repositorySelection: 'selected', repositoryIds: [1172846628],
		});
	}) as never, fetch, (path) => {
		reads += 1;
		assert.equal(path, '/protected/github-app.pem');
		return 'complete-file-key\n';
	});
	await authority.withRequest('frostyard/clix', 'issue_metadata_read', async () => undefined);
	assert.equal(reads, 1);
	assert.deepEqual(strategy, { appId: 123, privateKey: 'complete-file-key' });
});
