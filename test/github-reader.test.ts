import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubReader } from '../src/control-plane/github-reader.ts';

test('read-only intake uses GET and filters pull requests from the issues endpoint', async () => {
	const calls: Array<{ input: string; method: string | undefined }> = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		calls.push({ input: String(input), method: init?.method });
		return new Response(JSON.stringify([
			{
				number: 12,
				title: 'Document cancellation',
				body: null,
				html_url: 'https://github.com/frostyard/clix/issues/12',
				created_at: '2026-09-01T00:00:00Z',
				updated_at: '2026-09-01T00:00:00Z',
				user: { login: 'bob' },
				labels: [{ name: 'documentation' }],
			},
			{
				number: 13,
				title: 'A pull request',
				body: '',
				html_url: 'https://github.com/frostyard/clix/pull/13',
				created_at: '2026-09-01T00:00:00Z',
				updated_at: '2026-09-01T00:00:00Z',
				user: null,
				labels: [],
				pull_request: { url: 'ignored' },
			},
		]), { status: 200, headers: { 'content-type': 'application/json' } });
	};

	const reader = new GitHubReader({ fetch: fakeFetch });
	const issues = await reader.listOpenIssues('frostyard/clix');

	assert.deepEqual(calls, [{
		input: 'https://api.github.com/repos/frostyard/clix/issues?state=open&per_page=100',
		method: 'GET',
	}]);
	assert.equal(issues.length, 1);
	assert.equal(issues[0]?.key, 'issue:12');
	assert.deepEqual(issues[0]?.labels, ['documentation']);
});

test('intake does not hide GitHub failures', async () => {
	const reader = new GitHubReader({ fetch: async () => new Response('', { status: 403 }) });
	await assert.rejects(reader.listOpenIssues('frostyard/clix'), /HTTP 403/);
});
