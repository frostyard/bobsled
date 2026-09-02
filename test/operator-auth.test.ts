import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { operatorAuthConfiguration, operatorAuthStatus, requestOriginAllowed } from '../src/control-plane/operator-auth.ts';
import { OperatorAuthError, OperatorAuthForbiddenError, OperatorSessionStore } from '../src/control-plane/operator-sessions.ts';

const environment = {
	BOBSLED_OPERATOR_AUTH_MODE: 'github',
	BOBSLED_GITHUB_CLIENT_ID: 'test-client-id',
	BOBSLED_GITHUB_CLIENT_SECRET: 'test-client-secret',
	BOBSLED_SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
	BOBSLED_PUBLIC_ORIGIN: 'https://factory.example',
};

test('defaults to private local trust and scopes GitHub login to frostyard', () => {
	const status = operatorAuthStatus({});
	assert.equal(status.mode, 'local_trusted');
	assert.equal(status.requiredOrganization, 'frostyard');
	assert.equal(status.configurationComplete, false);
	assert.equal(status.sessionImplementationReady, true);
});

test('GitHub mode fails closed until every secure setting is valid', () => {
	assert.equal(operatorAuthStatus({ BOBSLED_OPERATOR_AUTH_MODE: 'github' }).mode, 'github_unconfigured');
	assert.equal(operatorAuthStatus({ ...environment, BOBSLED_PUBLIC_ORIGIN: 'http://factory.example' }).mode, 'github_unconfigured');
	assert.equal(operatorAuthStatus(environment).mode, 'github');
	assert.equal(operatorAuthConfiguration(environment)?.callbackUrl, 'https://factory.example/auth/github/callback');
});

test('mutation requests require the configured same origin', () => {
	const configuration = operatorAuthConfiguration(environment)!;
	assert.equal(requestOriginAllowed(new Request('https://factory.example/api/runs'), configuration), true);
	assert.equal(requestOriginAllowed(new Request('https://factory.example/api/runs', { method: 'POST', headers: { origin: 'https://factory.example' } }), configuration), true);
	assert.equal(requestOriginAllowed(new Request('https://factory.example/api/runs', { method: 'POST', headers: { origin: 'https://evil.example' } }), configuration), false);
	assert.equal(requestOriginAllowed(new Request('https://factory.example/api/runs', { method: 'POST' }), configuration), false);
});

test('PKCE login admits an active frostyard member and stores no GitHub token', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-operator-auth-'));
	const path = join(directory, 'auth.db');
	const store = new OperatorSessionStore(path, () => new Date('2026-09-01T12:00:00.000Z'));
	const configuration = operatorAuthConfiguration(environment)!;
	const login = store.begin(configuration);
	const authorize = new URL(login.authorizeUrl);
	const challenge = authorize.searchParams.get('code_challenge');
	const calls: string[] = [];
	let verifier = '';
	const fakeFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith('/login/oauth/access_token')) {
			const body = init?.body as URLSearchParams;
			verifier = body.get('code_verifier') ?? '';
			assert.equal(body.get('client_secret'), environment.BOBSLED_GITHUB_CLIENT_SECRET);
			return Response.json({ access_token: 'transient-user-token' });
		}
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer transient-user-token');
		if (url.endsWith('/user')) return Response.json({ id: 123, login: 'octocat' });
		return Response.json({ state: 'active', role: 'admin', organization: { login: 'frostyard' } });
	};
	try {
		assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(authorize.searchParams.get('state'), login.state);
		const completed = await store.complete({
			code: 'one-time-code', state: login.state, stateCookie: login.state, configuration, fetch: fakeFetch,
		});
		assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
		assert.equal(completed.principal.id, 'github:123');
		assert.equal(completed.principal.organization, 'frostyard');
		assert.equal(store.resolve(completed.sessionCookie, configuration.sessionSecret)?.login, 'octocat');
		assert.deepEqual(calls, [
			'https://github.com/login/oauth/access_token',
			'https://api.github.com/user',
			'https://api.github.com/user/memberships/orgs/frostyard',
		]);
		store.close();
		const database = new Database(path, { readonly: true });
		const serializedRows = JSON.stringify([
			...database.prepare('SELECT * FROM operator_oauth_states').all(),
			...database.prepare('SELECT * FROM operator_sessions').all(),
		]);
		assert.doesNotMatch(serializedRows, /transient-user-token|one-time-code/);
		database.close();
	} finally {
		try { store.close(); } catch {}
		rmSync(directory, { recursive: true, force: true });
	}
});

test('state is one-use and non-active organization membership is rejected', async () => {
	const configuration = operatorAuthConfiguration(environment)!;
	const store = new OperatorSessionStore(':memory:', () => new Date('2026-09-01T12:00:00.000Z'));
	const login = store.begin(configuration);
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith('/access_token')) return Response.json({ access_token: 'temporary' });
		if (url.endsWith('/user')) return Response.json({ id: 456, login: 'pending-user' });
		return Response.json({ state: 'pending', role: 'member', organization: { login: 'frostyard' } });
	};
	try {
		await assert.rejects(store.complete({ code: 'code', state: 'wrong', stateCookie: login.state, configuration, fetch: fakeFetch }), OperatorAuthError);
		await assert.rejects(store.complete({ code: 'code', state: login.state, stateCookie: login.state, configuration, fetch: fakeFetch }), OperatorAuthForbiddenError);
		await assert.rejects(store.complete({ code: 'code', state: login.state, stateCookie: login.state, configuration, fetch: fakeFetch }), /already used/);
	} finally {
		store.close();
	}
});

test('revocation and signature verification invalidate sessions', async () => {
	const configuration = operatorAuthConfiguration(environment)!;
	const store = new OperatorSessionStore(':memory:', () => new Date('2026-09-01T12:00:00.000Z'));
	const login = store.begin(configuration);
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith('/access_token')) return Response.json({ access_token: 'temporary' });
		if (url.endsWith('/user')) return Response.json({ id: 789, login: 'operator' });
		return Response.json({ state: 'active', role: 'member', organization: { login: 'frostyard' } });
	};
	try {
		const completed = await store.complete({ code: 'code', state: login.state, stateCookie: login.state, configuration, fetch: fakeFetch });
		assert.equal(store.resolve(`${completed.sessionCookie}tampered`, configuration.sessionSecret), undefined);
		store.revoke(completed.sessionCookie, configuration.sessionSecret);
		assert.equal(store.resolve(completed.sessionCookie, configuration.sessionSecret), undefined);
	} finally {
		store.close();
	}
});
