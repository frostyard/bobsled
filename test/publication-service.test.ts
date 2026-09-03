import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import type { GitHubInstallationAuthority, ScopedInstallationAuthority } from '../src/control-plane/github-installation.ts';
import {
	DraftPublicationService,
	PublicationConflictError,
	PublicationForbiddenError,
	PublicationPolicyBlockedError,
} from '../src/control-plane/publication-service.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const owner = { id: 'github:123' };
const other = { id: 'github:456' };
const runId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const reviewId = '44444444-4444-4444-8444-444444444444';
const baseCommit = 'a'.repeat(40);
const patchDigest = 'b'.repeat(64);
const commitSha = 'e'.repeat(40);

const writableRepository = {
	...getRepository('frostyard/clix')!, readOnly: false,
	capabilities: { ...getRepository('frostyard/clix')!.capabilities, writeGitHub: true },
	publicationPolicy: { ...getRepository('frostyard/clix')!.publicationPolicy, enabled: true },
} satisfies RepositoryContract;

function candidate(repository: RepositoryContract = writableRepository) {
	return {
		runId, runVersion: 7, jobId, attemptId, reviewId, repository,
		workItem: { source: 'manual' as const, key: 'publication-test', title: 'Clarify verification guidance', body: 'Document the local gate.', labels: [] },
		workspacePath: '/unused/injected/workspace', baseCommit, approvedPatchSha256: patchDigest,
	};
}

const snapshot = {
	patchSha256: patchDigest, totalBlobBytes: 12,
	entries: [{ path: 'docs/README.md', mode: '100644' as const, contentBase64: Buffer.from('clarified\n').toString('base64'), deleted: false }],
};

function authority(handler: (path: string, init: RequestInit, capability: string) => Promise<Response>, uses?: string[]): GitHubInstallationAuthority {
	return {
		async withRequest<T>(repository: string, capability: string, use: (scoped: ScopedInstallationAuthority) => Promise<T>) {
			assert.equal(repository, 'frostyard/clix'); uses?.push(capability);
			return use({ repository, repositoryId: 1172846628, capability: capability as never, expiresAt: '2026-09-02T05:00:00Z', permissions: {}, request: (path, init = {}) => handler(path, init, capability) });
		},
	} as GitHubInstallationAuthority;
}

function service(options: { repository?: RepositoryContract; authority?: GitHubInstallationAuthority } = {}) {
	const repository = options.repository ?? writableRepository;
	return new DraftPublicationService({
		path: ':memory:', repository: (id) => id === repository.id ? repository : undefined,
		authority: options.authority ?? authority(async () => Response.json({})),
		candidateResolver: () => candidate(repository), workspaceInspector: async () => snapshot,
		now: () => new Date('2026-09-02T04:00:00.000Z'),
	});
}

test('records a policy-blocked publication without minting GitHub authority', async () => {
	const uses: string[] = [];
	const blockedRepository = getRepository('frostyard/clix')!;
	const publications = service({ repository: blockedRepository, authority: authority(async () => Response.json({}), uses) });
	try {
		const input = { runId, expectedVersion: 7, reason: 'Operator records a draft publication intent for policy evidence.' };
		const record = await publications.admit(input, owner, 'blocked-publication');
		assert.equal(record.status, 'blocked');
		assert.match(record.blockedReason ?? '', /does not permit draft publication/);
		assert.equal((await publications.admit(input, owner, 'blocked-publication')).id, record.id);
		await assert.rejects(publications.execute(record.id, owner), PublicationPolicyBlockedError);
		assert.deepEqual(uses, []);
		await assert.rejects(async () => publications.get(record.id, other), PublicationForbiddenError);
		await assert.rejects(publications.admit({ ...input, reason: 'A different request must conflict with the reused idempotency key.' }, owner, 'blocked-publication'), PublicationConflictError);
	} finally { publications.close(); }
});

test('publishes only a generated non-force branch and draft PR, then waits for required checks', async () => {
	const calls: Array<{ path: string; method: string; body?: unknown; capability: string }> = [];
	const uses: string[] = [];
	let pullBody = '';
	let pullBranch = '';
	let mergedAt: string | null = null;
	const publications = service({ authority: authority(async (path, init, capability) => {
		const body = init.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path, method: init.method ?? 'GET', body, capability });
		if (path.includes('/pulls?')) return Response.json([]);
		if (path.endsWith('/pulls/42')) return Response.json({
			number: 42, html_url: 'https://github.com/frostyard/clix/pull/42', body: pullBody,
			draft: mergedAt === null, state: mergedAt ? 'closed' : 'open', merged_at: mergedAt, closed_at: mergedAt,
			head: { ref: pullBranch, sha: commitSha }, base: { ref: 'main' },
		});
		if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: baseCommit } });
		if (path.includes('/git/ref/heads/bobsled%2F')) return new Response(null, { status: 404 });
		if (path.endsWith('/git/blobs')) return Response.json({ sha: 'c'.repeat(40) });
		if (path.endsWith('/git/trees')) return Response.json({ sha: 'd'.repeat(40) });
		if (path.endsWith('/git/commits')) return Response.json({ sha: commitSha });
		if (path.endsWith('/git/refs')) return Response.json({ object: { sha: commitSha } });
		if (path.endsWith('/pulls')) {
			pullBody = body.body; pullBranch = body.head;
			return Response.json({ number: 42, html_url: 'https://github.com/frostyard/clix/pull/42', body: pullBody, draft: true, head: { ref: pullBranch, sha: commitSha } });
		}
		if (path.includes('/check-runs')) return Response.json({ check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success', details_url: 'https://github.com/check/1' }] });
		throw new Error(`Unexpected request: ${init.method} ${path}`);
	}, uses) });
	try {
		const record = await publications.admit({ runId, expectedVersion: 7, reason: 'Operator authorizes trusted draft-only publication.' }, owner, 'publish-success');
		assert.equal(record.status, 'pending');
		assert.match(record.branchName, /^bobsled\/11111111-/);
		assert.match(record.body, new RegExp(record.marker));
		const published = await publications.execute(record.id, owner);
		assert.equal(published.status, 'published');
		assert.equal(published.pullNumber, 42);
		const pullCall = calls.find(({ path, method }) => path.endsWith('/pulls') && method === 'POST');
		assert.deepEqual(pullCall?.body && { draft: (pullCall.body as { draft: boolean }).draft, head: (pullCall.body as { head: string }).head }, { draft: true, head: record.branchName });
		assert.equal(calls.some(({ body }) => body && (body as { force?: boolean }).force === true), false);
		const ready = await publications.refreshChecks(record.id, owner);
		assert.equal(ready.status, 'ready_for_human');
		assert.equal(ready.pullState, 'open');
		mergedAt = '2026-09-02T04:30:00.000Z';
		const merged = await publications.refreshChecks(record.id, owner);
		assert.equal(merged.status, 'merged');
		assert.equal(merged.pullMergedAt, mergedAt);
		assert.deepEqual(uses, ['draft_pr_publish', 'pull_request_status_read', 'commit_checks_read', 'pull_request_status_read']);
	} finally { publications.close(); }
});

test('reconciles an existing marked draft PR only when its head equals the deterministic approved commit', async () => {
	const visibleMutationCalls: string[] = [];
	let marker = '';
	const publications = service({ authority: authority(async (path, init) => {
		if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: baseCommit } });
		if (path.endsWith('/git/blobs')) return Response.json({ sha: 'c'.repeat(40) });
		if (path.endsWith('/git/trees')) return Response.json({ sha: 'd'.repeat(40) });
		if (path.endsWith('/git/commits')) return Response.json({ sha: commitSha });
		if (path.includes('/pulls?')) return Response.json([{ number: 51, html_url: 'https://github.com/frostyard/clix/pull/51', body: `Recovered\n${marker}`, draft: true, head: { ref: 'bobsled/recovered', sha: commitSha } }]);
		if (path.endsWith('/pulls/51')) return Response.json({
			number: 51, html_url: 'https://github.com/frostyard/clix/pull/51', body: `Recovered\n${marker}`,
			draft: true, state: 'open', merged_at: null, closed_at: null,
			head: { ref: 'bobsled/recovered', sha: commitSha }, base: { ref: 'main' },
		});
		if (path.endsWith('/git/refs') || (path.endsWith('/pulls') && init.method === 'POST')) visibleMutationCalls.push(path);
		throw new Error(`Unexpected request: ${init.method} ${path}`);
	}) });
	try {
		const record = await publications.admit({ runId, expectedVersion: 7, reason: 'Operator retries a recoverable publication after interruption.' }, owner, 'publish-recovery');
		marker = record.marker;
		const recovered = await publications.execute(record.id, owner);
		assert.equal(recovered.pullNumber, 51);
		assert.equal(recovered.commitSha, commitSha);
		assert.deepEqual(visibleMutationCalls, []);
		await assert.rejects(publications.refreshChecks(record.id, owner), PublicationPolicyBlockedError);
		assert.match(publications.get(record.id, owner).blockedReason ?? '', /immutable evidence/);
	} finally { publications.close(); }
});

test('blocks recovery when a marked PR branch drifted from the deterministic approved commit', async () => {
	let marker = '';
	const publications = service({ authority: authority(async (path) => {
		if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: baseCommit } });
		if (path.endsWith('/git/blobs')) return Response.json({ sha: 'c'.repeat(40) });
		if (path.endsWith('/git/trees')) return Response.json({ sha: 'd'.repeat(40) });
		if (path.endsWith('/git/commits')) return Response.json({ sha: commitSha });
		if (path.includes('/pulls?')) return Response.json([{ number: 52, html_url: 'https://github.com/frostyard/clix/pull/52', body: marker, draft: true, head: { ref: 'bobsled/drifted', sha: 'f'.repeat(40) } }]);
		throw new Error(`Unexpected request: ${path}`);
	}) });
	try {
		const record = await publications.admit({ runId, expectedVersion: 7, reason: 'Operator attempts recovery of an interrupted publication.' }, owner, 'publish-drift');
		marker = record.marker;
		await assert.rejects(publications.execute(record.id, owner), PublicationPolicyBlockedError);
		assert.match(publications.get(record.id, owner).blockedReason ?? '', /does not match/);
	} finally { publications.close(); }
});

test('required failed checks remain visible and never create merge authority', async () => {
	let closedAt: string | null = null;
	const publications = service({ authority: authority(async (path, init) => {
		if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: baseCommit } });
		if (path.endsWith('/git/blobs')) return Response.json({ sha: 'c'.repeat(40) });
		if (path.endsWith('/git/trees')) return Response.json({ sha: 'd'.repeat(40) });
		if (path.endsWith('/git/commits')) return Response.json({ sha: commitSha });
		if (path.includes('/pulls?')) return Response.json([{ number: 61, html_url: 'https://github.com/frostyard/clix/pull/61', body: currentMarker, draft: true, head: { ref: 'bobsled/checks', sha: commitSha } }]);
		if (path.endsWith('/pulls/61')) return Response.json({
			number: 61, html_url: 'https://github.com/frostyard/clix/pull/61', body: currentMarker,
			draft: closedAt === null, state: closedAt ? 'closed' : 'open', merged_at: null, closed_at: closedAt,
			head: { ref: currentBranch, sha: commitSha }, base: { ref: 'main' },
		});
		if (path.includes('/check-runs')) return Response.json({ check_runs: [{ name: 'verify', status: 'completed', conclusion: 'failure' }] });
		throw new Error(`Unexpected request: ${init.method} ${path}`);
	}) });
	let currentMarker = '';
	let currentBranch = '';
	try {
		const record = await publications.admit({ runId, expectedVersion: 7, reason: 'Operator tracks required checks without merge authority.' }, owner, 'checks-fail');
		currentMarker = record.marker; currentBranch = record.branchName;
		await publications.execute(record.id, owner);
		const checked = await publications.refreshChecks(record.id, owner);
		assert.equal(checked.status, 'checks_failed');
		assert.equal(checked.checks[0]?.conclusion, 'failure');
		closedAt = '2026-09-02T04:45:00.000Z';
		const closed = await publications.refreshChecks(record.id, owner);
		assert.equal(closed.status, 'closed');
		assert.equal(closed.pullClosedAt, closedAt);
		closedAt = null;
		const reopened = await publications.refreshChecks(record.id, owner);
		assert.equal(reopened.status, 'checks_failed');
		assert.equal(reopened.pullState, 'open');
		assert.equal(reopened.pullClosedAt, undefined);
	} finally { publications.close(); }
});
