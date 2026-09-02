import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubAppStatus, resolveGitHubPrivateKey, verifyGitHubWebhook } from '../src/control-plane/github-app.ts';

test('verifies GitHub official webhook signature vector', () => {
	const payload = new TextEncoder().encode('Hello, World!');
	assert.equal(
		verifyGitHubWebhook(payload, 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17', "It's a Secret to Everybody"),
		true,
	);
	assert.equal(verifyGitHubWebhook(payload, `sha256=${'0'.repeat(64)}`, "It's a Secret to Everybody"), false);
	assert.equal(verifyGitHubWebhook(payload, undefined, "It's a Secret to Everybody"), false);
});

test('readiness exposes only credential presence', () => {
	assert.deepEqual(githubAppStatus({
		BOBSLED_GITHUB_APP_ID: 'configured',
		BOBSLED_GITHUB_INSTALLATION_ID: 'configured',
		BOBSLED_GITHUB_PRIVATE_KEY: 'private-value',
	}), {
		appIdConfigured: true,
		installationIdConfigured: true,
		privateKeyConfigured: true,
		webhookSecretConfigured: false,
		readyForApi: true,
		readyForWebhooks: false,
	});
});

test('a protected private-key file is authoritative and fails closed when unreadable', () => {
	const environment = {
		BOBSLED_GITHUB_APP_ID: 'configured',
		BOBSLED_GITHUB_INSTALLATION_ID: 'configured',
		BOBSLED_GITHUB_PRIVATE_KEY: 'stale-inline-key',
		BOBSLED_GITHUB_PRIVATE_KEY_FILE: '/protected/github-app.pem',
	};
	assert.equal(resolveGitHubPrivateKey(environment, () => '  complete-file-key\n'), 'complete-file-key');
	assert.equal(resolveGitHubPrivateKey(environment, () => { throw new Error('unreadable'); }), undefined);
	assert.equal(githubAppStatus(environment, () => { throw new Error('unreadable'); }).readyForApi, false);
});
