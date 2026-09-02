import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { AuthFileStore, resolveOAuthCredential } from '../src/auth-file.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'bobsled-auth-test-'));
	temporaryDirectories.push(directory);
	const path = join(directory, 'auth.json');
	return { path, store: new AuthFileStore(path) };
}

function expired(access: string): OAuthCredential {
	return { type: 'oauth', access, refresh: `refresh-${access}`, expires: 0 };
}

function oauth(delay = 0, fail = false) {
	let refreshes = 0;
	const implementation: Pick<OAuthAuth, 'refresh' | 'toAuth'> = {
		async refresh(credential) {
			refreshes += 1;
			await new Promise((resolve) => setTimeout(resolve, delay));
			if (fail) throw new Error('refresh failed');
			return { ...credential, access: `${credential.access}-new`, expires: Date.now() + 300_000 };
		},
		async toAuth(credential) {
			return { apiKey: credential.access };
		},
	};
	return { implementation, refreshes: () => refreshes };
}

test('simultaneous Codex and Copilot refreshes preserve both credentials', async () => {
	const { path, store } = await fixture();
	await writeFile(path, JSON.stringify({
		'openai-codex': expired('codex'),
		'github-copilot': expired('copilot'),
	}));
	const codex = oauth(40);
	const copilot = oauth(10);

	await Promise.all([
		resolveOAuthCredential(store, 'openai-codex', 'Codex', codex.implementation),
		resolveOAuthCredential(store, 'github-copilot', 'Copilot', copilot.implementation),
	]);

	const auth = JSON.parse(await readFile(path, 'utf8'));
	assert.equal(auth['openai-codex'].access, 'codex-new');
	assert.equal(auth['github-copilot'].access, 'copilot-new');
});

test('concurrent refreshes for one provider perform one refresh', async () => {
	const { path, store } = await fixture();
	await writeFile(path, JSON.stringify({ 'openai-codex': expired('codex') }));
	const codex = oauth(30);

	const results = await Promise.all([
		resolveOAuthCredential(store, 'openai-codex', 'Codex', codex.implementation),
		resolveOAuthCredential(store, 'openai-codex', 'Codex', codex.implementation),
	]);

	assert.equal(codex.refreshes(), 1);
	assert.deepEqual(results.map((result) => result.auth.apiKey), ['codex-new', 'codex-new']);
});

test('lock is released after refresh failure', async () => {
	const { path, store } = await fixture();
	await writeFile(path, JSON.stringify({ 'openai-codex': expired('codex') }));
	await assert.rejects(
		resolveOAuthCredential(store, 'openai-codex', 'Codex', oauth(0, true).implementation),
		/refresh failed/,
	);

	const result = await resolveOAuthCredential(store, 'openai-codex', 'Codex', oauth().implementation);
	assert.equal(result.auth.apiKey, 'codex-new');
});

test('separate processes serialize updates to the same auth file', async () => {
	const { path } = await fixture();
	const helper = join(import.meta.dirname, 'fixtures/auth-writer.ts');
	const run = (provider: string, access: string, delay: number) => new Promise<void>((resolveRun, reject) => {
		const child = spawn(process.execPath, ['--import', 'tsx', helper, path, provider, access, String(delay)], {
			stdio: 'pipe',
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += String(chunk); });
		child.once('error', reject);
		child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(stderr)));
	});

	await Promise.all([
		run('openai-codex', 'codex', 100),
		run('github-copilot', 'copilot', 0),
	]);

	const auth = JSON.parse(await readFile(path, 'utf8'));
	assert.equal(auth['openai-codex'].access, 'codex');
	assert.equal(auth['github-copilot'].access, 'copilot');
});
