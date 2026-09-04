import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubInstallationAuthority } from '../src/control-plane/github-installation.ts';
import { RepositoryDriftService } from '../src/control-plane/repository-drift.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const repository = getRepository('frostyard/clix')!;
const environment = {
	BOBSLED_GITHUB_APP_ID: '123',
	BOBSLED_GITHUB_INSTALLATION_ID: '456',
	BOBSLED_GITHUB_PRIVATE_KEY: 'test-private-key',
};

function authority(response: unknown, status = 200, observe?: (input: string, init?: RequestInit) => void) {
	return new GitHubInstallationAuthority(environment, (() => async (options: Record<string, unknown>) => {
		assert.deepEqual(options, {
			type: 'installation', installationId: 456,
			repositoryIds: [repository.githubRepositoryId], permissions: { metadata: 'read' },
		});
		return {
			type: 'token', tokenType: 'installation', token: 'short-lived-token', installationId: 456,
			createdAt: '2026-09-04T14:00:00Z', expiresAt: '2026-09-04T15:00:00Z',
			permissions: { metadata: 'read' }, repositorySelection: 'selected', repositoryIds: [repository.githubRepositoryId],
		};
	}) as never, async (input, init) => {
		observe?.(String(input), init);
		return Response.json(response, { status });
	});
}

test('proves enrolled repository identity and policy alignment through metadata-only authority', async () => {
	let request: { input: string; method?: string } | undefined;
	const service = new RepositoryDriftService(authority({
		id: repository.githubRepositoryId,
		full_name: repository.id,
		default_branch: repository.defaultBranch,
		archived: false,
		disabled: false,
	}, 200, (input, init) => { request = { input, method: init?.method }; }), [repository], () => new Date('2026-09-04T14:00:00Z'));

	const [result] = await service.inspectAll();
	assert.deepEqual(request, { input: `https://api.github.com/repositories/${repository.githubRepositoryId}`, method: 'GET' });
	assert.equal(result?.status, 'aligned');
	assert.equal(result?.findings.length, 0);
	assert.match(result?.policyDigest ?? '', /^[a-f0-9]{64}$/);
	assert.deepEqual(result?.policy, {
		enabled: true, readOnly: true, executionEnabled: true,
		reviewEnabled: true, publicationEnabled: false, multiWorkerEnabled: false,
	});
});

test('reports bounded name, branch, and lifecycle drift without changing enrollment', async () => {
	const service = new RepositoryDriftService(authority({
		id: repository.githubRepositoryId + 1,
		full_name: 'frostyard/renamed-clix',
		default_branch: 'trunk',
		archived: true,
		disabled: true,
	}), [repository], () => new Date('2026-09-04T14:00:00Z'));

	const [result] = await service.inspectAll();
	assert.equal(result?.status, 'drifted');
	assert.deepEqual(result?.findings, [
		{ kind: 'repository_identity' },
		{ kind: 'repository_name', expected: 'frostyard/clix', observed: 'frostyard/renamed-clix' },
		{ kind: 'default_branch', expected: 'main', observed: 'trunk' },
		{ kind: 'archived', expected: 'active', observed: 'archived' },
		{ kind: 'disabled', expected: 'enabled', observed: 'disabled' },
	]);
	assert.deepEqual(getRepository('frostyard/clix'), repository);
});

test('turns inaccessible or malformed GitHub metadata into bounded unavailable evidence', async () => {
	for (const source of [authority({ message: 'not found' }, 404), authority({ secret: 'untrusted response shape' })]) {
		const [result] = await new RepositoryDriftService(source, [repository]).inspectAll();
		assert.equal(result?.status, 'unavailable');
		assert.deepEqual(result?.findings, [{ kind: 'unreachable' }]);
		assert.equal('error' in (result as object), false);
	}
});
