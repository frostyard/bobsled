import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepositoryContract } from '../src/control-plane/contracts.ts';
import {
	GitHubActionConflictError,
	GitHubActionForbiddenError,
	GitHubActionPolicyBlockedError,
	GitHubIssueActionService,
} from '../src/control-plane/github-actions.ts';
import type { GitHubInstallationAuthority, ScopedInstallationAuthority } from '../src/control-plane/github-installation.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const owner = { id: 'github:123' };
const other = { id: 'github:456' };
const writableRepository = {
	...getRepository('frostyard/clix')!,
	readOnly: false,
	capabilities: { ...getRepository('frostyard/clix')!.capabilities, writeGitHub: true },
} satisfies RepositoryContract;

function fakeAuthority(request: typeof fetch = async () => Response.json({}), onUse?: () => void): GitHubInstallationAuthority {
	return {
		async withRequest<T>(repository: string, capability: string, use: (authority: ScopedInstallationAuthority) => Promise<T>) {
			onUse?.();
			assert.equal(repository, 'frostyard/clix');
			assert.equal(capability, 'issue_metadata_write');
			return use({
				repository, repositoryId: 1172846628, capability: 'issue_metadata_write',
				expiresAt: '2026-09-01T13:00:00Z', permissions: { issues: 'write' },
				request: (path, init) => request(`https://api.github.com${path}`, init),
			});
		},
	} as GitHubInstallationAuthority;
}

test('records policy-blocked intent without minting a token or creating a dead end', async () => {
	let tokenUses = 0;
	const service = new GitHubIssueActionService({ path: ':memory:', installationAuthority: fakeAuthority(undefined, () => { tokenUses += 1; }) });
	try {
		const input = { kind: 'set_triage_label', repositoryId: 'frostyard/clix', issueNumber: 12, label: 'bobsled:ready' };
		const admitted = service.admit(input, owner, 'blocked-action');
		assert.equal(admitted.status, 'blocked');
		assert.match(admitted.blockedReason ?? '', /read-only/);
		assert.equal(service.admit(input, owner, 'blocked-action').id, admitted.id);
		assert.throws(() => service.admit({ ...input, issueNumber: 13 }, owner, 'blocked-action'), GitHubActionConflictError);
		assert.throws(() => service.get(admitted.id, other), GitHubActionForbiddenError);
		await assert.rejects(service.execute(admitted.id, owner), GitHubActionPolicyBlockedError);
		assert.equal(tokenUses, 0);
	} finally {
		service.close();
	}
});

test('label execution converges only Bobsled route labels and is not repeated after success', async () => {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	const service = new GitHubIssueActionService({
		path: ':memory:',
		repository: (id) => id === writableRepository.id ? writableRepository : undefined,
		installationAuthority: fakeAuthority(async (input, init) => {
			calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
			if (init?.method === 'POST') return Response.json([]);
			return new Response(null, { status: 404 });
		}),
	});
	try {
		const action = service.admit({
			kind: 'set_triage_label', repositoryId: 'frostyard/clix', issueNumber: 12, label: 'bobsled:needs-spec',
		}, owner, 'label-action');
		assert.equal(action.status, 'pending');
		const completed = await service.execute(action.id, owner);
		assert.equal(completed.status, 'succeeded');
		assert.equal(completed.attemptCount, 1);
		assert.deepEqual(JSON.parse(calls[0]!.body!), { labels: ['bobsled:needs-spec'] });
		assert.equal(calls.filter(({ method }) => method === 'DELETE').length, 4);
		await service.execute(action.id, owner);
		assert.equal(calls.length, 5);
	} finally {
		service.close();
	}
});

test('comment reconciliation recognizes its durable marker and avoids a duplicate post', async () => {
	let marker = '';
	const calls: string[] = [];
	const service = new GitHubIssueActionService({
		path: ':memory:',
		repository: () => writableRepository,
		installationAuthority: fakeAuthority(async (input, init) => {
			calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
			return Response.json([{ id: 77, html_url: 'https://github.com/frostyard/clix/issues/12#issuecomment-77', body: `Earlier result\n${marker}` }]);
		}),
	});
	try {
		const action = service.admit({ kind: 'comment', repositoryId: 'frostyard/clix', issueNumber: 12, body: 'Please clarify.' }, owner, 'comment-action');
		marker = action.marker!;
		const completed = await service.execute(action.id, owner);
		assert.equal(completed.status, 'succeeded');
		assert.deepEqual(completed.result, {
			commentId: 77,
			recovered: true,
			url: 'https://github.com/frostyard/clix/issues/12#issuecomment-77',
		});
		assert.equal(calls.length, 1);
		assert.match(calls[0]!, /^GET /);
	} finally {
		service.close();
	}
});
