import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import app from '../src/app.ts';
import { operatorAuthConfiguration } from '../src/control-plane/operator-auth.ts';
import { operatorSessionStore } from '../src/control-plane/operator-sessions.ts';
import { controlPlaneHtml } from '../src/control-plane/ui/index.ts';

const authEnvironmentKeys = [
	'BOBSLED_OPERATOR_AUTH_MODE', 'BOBSLED_GITHUB_CLIENT_ID', 'BOBSLED_GITHUB_CLIENT_SECRET',
	'BOBSLED_SESSION_SECRET', 'BOBSLED_PUBLIC_ORIGIN',
] as const;

async function withGitHubAuthEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const before = Object.fromEntries(authEnvironmentKeys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		BOBSLED_OPERATOR_AUTH_MODE: 'github',
		BOBSLED_GITHUB_CLIENT_ID: 'test-client',
		BOBSLED_GITHUB_CLIENT_SECRET: 'test-client-secret',
		BOBSLED_SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
		BOBSLED_PUBLIC_ORIGIN: 'https://factory.example',
	});
	try {
		return await run();
	} finally {
		for (const key of authEnvironmentKeys) {
			const value = before[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('lists only enrolled repositories and exposes their bounded policies', async () => {
	const response = await app.request('/api/repositories');
	assert.equal(response.status, 200);
	const repositories = await response.json() as Array<{
		id: string;
		readOnly: boolean;
		capabilities: { writeGitHub: boolean };
	}>;
	assert.equal(repositories.length, 3);
	const clix = repositories.find((repository) => repository.id === 'frostyard/clix');
	const bobsled = repositories.find((repository) => repository.id === 'frostyard/bobsled');
	const website = repositories.find((repository) => repository.id === 'frostyard/frostyard-org');
	assert.equal(clix?.readOnly, true);
	assert.equal(clix?.capabilities.writeGitHub, false);
	assert.equal(bobsled?.readOnly, false);
	assert.equal(bobsled?.capabilities.writeGitHub, true);
	assert.equal(website?.readOnly, false);
	assert.equal(website?.capabilities.writeGitHub, true);
});

test('lists bounded durable repository enrollment state', async () => {
	const response = await app.request('/api/repository-enrollments');
	assert.equal(response.status, 200);
	const records = await response.json() as Array<Record<string, unknown> & { repository: Record<string, unknown> }>;
	assert.equal(records.length, 3);
	for (const record of records) {
		assert.equal(record.version, 1);
		assert.equal(record.action, 'bootstrap');
		assert.equal('actorId' in record, false);
		assert.equal('reason' in record, false);
		assert.equal('githubRepositoryId' in record.repository, false);
	}
});

test('reads retained repository drift and appends only on an explicit check', async () => {
	const response = await app.request('/api/repositories/drift');
	assert.equal(response.status, 200);
	const records = await response.json() as Array<Record<string, unknown>>;
	const priorCounts = new Map(records.map((record) => [record.repositoryId, Number(record.observationCount)]));
	const idempotencyKey = `drift-${randomUUID()}`;
	const checked = await app.request('/api/repositories/drift/check', { method: 'POST', headers: { 'idempotency-key': idempotencyKey } });
	assert.equal(checked.status, 200);
	const observations = await checked.json() as Array<Record<string, unknown>>;
	assert.equal(observations.length, 3);
	for (const record of observations) {
		assert.equal(record.status, 'unavailable');
		assert.deepEqual(record.findings, [{ kind: 'unreachable' }]);
		assert.equal(record.observationCount, (priorCounts.get(record.repositoryId) ?? 0) + 1);
		assert.deepEqual(record.policyImpact, { changedOpenRunCount: 0, byStatus: { pending: 0, running: 0, succeeded: 0, blocked: 0 }, sampleRunIds: [], truncated: false });
		for (const forbidden of ['token', 'permissions', 'githubRepositoryId', 'error']) assert.equal(forbidden in record, false);
	}
	const replay = await app.request('/api/repositories/drift/check', { method: 'POST', headers: { 'idempotency-key': idempotencyKey } });
	assert.equal(replay.status, 200);
	assert.deepEqual(await replay.json(), observations);
});

test('serves the operator interface', async () => {
	const response = await app.request('/');
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.match(html, /BOB<i>SLED/);
	assert.match(html, /Signed in as/);
	// Lane names the operator reads, not the lane ids the contract uses.
	assert.match(html, /Needs you/);
	assert.match(html, /Waiting for you to say go/);
	assert.match(html, /Codex is writing code/);
	// The authorization sheet replaces every window.prompt.
	assert.doesNotMatch(html, /window\.prompt/);
	assert.match(html, /What this lets it do/);
	assert.match(html, /What it still cannot do/);
	assert.match(html, /Start work on this\?/);
	// Watching is deliberately read-only.
	assert.match(html, /You are watching, not steering/);
	assert.match(html, /What we have agreed/);
	const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script, 'expected the control-plane module script');
	assert.doesNotThrow(() => new vm.Script(`(async () => {${script}})()`));
});

test('serves every operator surface as one document and 404s anything else', async () => {
	for (const path of ['/', '/intake', '/activity', '/access', '/change-sets', '/runs/9c41b7e2-0000-4000-8000-000000000000', '/runs/9c41b7e2-0000-4000-8000-000000000000/live']) {
		const response = await app.request(path);
		assert.equal(response.status, 200, path);
		assert.match(await response.text(), /<title>Bobsled<\/title>/, path);
	}
	assert.equal((await app.request('/not-a-surface')).status, 404);
});

test('never lets an operator login break out of the client module', () => {
	const html = controlPlaneHtml({ provider: 'github', login: '</script><img src=x onerror=alert(1)>' });
	assert.doesNotMatch(html, /<\/script><img/);
	assert.match(html, /\\u003c\/script>/);
});

test('exposes read-only live agent activity for a run and nothing for an unknown one', async () => {
	const admitted = await app.request('/api/runs', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': `activity-${randomUUID()}` },
		body: JSON.stringify({
			repositoryId: 'frostyard/clix',
			workItem: { source: 'manual', key: 'manual:activity', title: 'Watchable work', body: 'Body.', labels: [] },
			triageDecision: {
				route: 'ready_for_agent', risk: 'low', confidence: 0.9,
				summary: 'Small change.', rationale: 'Explicit and bounded.',
				acceptanceCriteria: ['It works'], missingInformation: [],
				suggestedLabels: ['bobsled:ready'], eligibleForOneClick: true,
			},
		}),
	});
	assert.equal(admitted.status, 201);
	const run = await admitted.json() as { id: string };

	const activity = await app.request(`/api/runs/${run.id}/activity`);
	assert.equal(activity.status, 200);
	const payload = await activity.json() as { runId: string; events: unknown[] };
	assert.equal(payload.runId, run.id);
	// Nothing has run yet, so there is nothing to watch -- but the route must
	// answer rather than fail, and it must never start anything.
	assert.deepEqual(payload.events, []);
	assert.equal((await app.request(`/api/runs/${run.id}`)).status, 200);
	assert.equal((await app.request('/api/runs/00000000-0000-4000-8000-000000000000/activity')).status, 404);
});

test('serves a typed operator board projection', async () => {
	const response = await app.request('/api/operator-board');
	assert.equal(response.status, 200);
	const board = await response.json() as { generatedAt?: string; cards?: unknown[] };
	assert.equal(typeof board.generatedAt, 'string');
	assert.equal(Array.isArray(board.cards), true);
});

test('serves principal-owned conversational intake without implicit model authority', async () => {
	const key = `app-conversation-${crypto.randomUUID()}`;
	const seed = { source:'manual', key, title:'Clarify one bounded website task', body:'Preserve the existing layout.', labels:[] };
	const brief = { version:1, repositoryId:'frostyard/frostyard-org', objective:seed.title, context:[seed.body], acceptanceCriteria:[], constraints:[], nonGoals:[], assumptions:[], unresolvedQuestions:['What outcome is required?'] };
	const createdResponse = await app.request('/api/intake-conversations',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({repositoryId:brief.repositoryId,seed,brief})});
	assert.equal(createdResponse.status,201);const created=await createdResponse.json() as {id:string;version:number;intakeModelCallAuthorized:boolean;runAdmissionAuthorized:boolean;githubMutationAuthorized:boolean};assert.equal(created.version,1);assert.equal(created.intakeModelCallAuthorized,false);assert.equal(created.runAdmissionAuthorized,false);assert.equal(created.githubMutationAuthorized,false);
	assert.equal((await app.request(`/api/intake-conversations/${created.id}`)).status,200);const listed=await (await app.request('/api/intake-conversations')).json() as Array<{id:string}>;assert.equal(listed.some(({id})=>id===created.id),true);
	assert.deepEqual(await (await app.request(`/api/intake-conversations/${created.id}/revisions`)).json(),[]);
	const missingKey=await app.request(`/api/intake-conversations/${created.id}/revisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:1,message:'Clarify the audience.'})});assert.equal(missingKey.status,409);
	const finalized=await app.request(`/api/intake-conversations/${created.id}/finalize`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':`${key}:final`},body:JSON.stringify({expectedVersion:1,reason:'LGTM'})});assert.equal(finalized.status,201);const payload=await finalized.json() as {snapshot:{briefSha256:string;triageAuthorized:boolean;runAdmissionAuthorized:boolean};conversation:{status:string;version:number}};assert.equal(payload.conversation.status,'finalized');assert.equal(payload.conversation.version,2);assert.equal(payload.snapshot.briefSha256.length,64);assert.equal(payload.snapshot.triageAuthorized,false);assert.equal(payload.snapshot.runAdmissionAuthorized,false);assert.equal((await app.request(`/api/intake-conversations/${created.id}/snapshot`)).status,200);
	assert.equal(await (await app.request(`/api/intake-conversations/${created.id}/snapshot/triage`)).json(),null);
	assert.equal(await (await app.request(`/api/intake-conversations/${created.id}/snapshot/admission`)).json(),null);
	const prematureAdmission=await app.request(`/api/intake-conversations/${created.id}/snapshot/admission`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':`${key}:premature-admission`},body:'{}'});assert.equal(prematureAdmission.status,409);
	const correction=await app.request(`/api/intake-conversations/${created.id}/corrections`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':`${key}:correction`},body:JSON.stringify({reason:'Operator identified a correction that requires a new snapshot.'})});assert.equal(correction.status,201);const corrected=await correction.json() as {id:string;version:number;status:string;supersession?:{sourceConversationId:string;sourceSnapshotId:string}};assert.equal(corrected.status,'active');assert.equal(corrected.supersession?.sourceConversationId,created.id);assert.equal(typeof corrected.supersession?.sourceSnapshotId,'string');assert.equal((await app.request(`/api/intake-conversations/${corrected.id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:corrected.version,reason:'Operator cancelled this route-level correction fixture.'})})).status,200);
	const cancelKey=`${key}:cancel`,cancelledConversation=await (await app.request('/api/intake-conversations',{method:'POST',headers:{'content-type':'application/json','idempotency-key':cancelKey},body:JSON.stringify({repositoryId:brief.repositoryId,seed:{...seed,key:cancelKey},brief})})).json() as {id:string;version:number};
	const cancelled=await app.request(`/api/intake-conversations/${cancelledConversation.id}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:cancelledConversation.version,reason:'Operator stopped this application-route test.'})});assert.equal(cancelled.status,200);assert.equal((await cancelled.json() as {status:string}).status,'cancelled');
});

test('creates RFC 4122 UUIDs when randomUUID is unavailable over private HTTP', async () => {
	const html = await (await app.request('/')).text();
	const helper = html.match(/function browserUuid\(\) \{[\s\S]*?\n\}\n\nasync function json/)?.[0]
		.replace(/\n\nasync function json$/, '');
	assert.ok(helper, 'expected the browser UUID compatibility helper');
	const context = {
		crypto: {
			getRandomValues(bytes: Uint8Array) {
				bytes.set(Array.from({ length: 16 }, (_, index) => index));
				return bytes;
			},
		},
		result: '',
	};
	vm.runInNewContext(`${helper}\nresult = browserUuid();`, context);
	assert.equal(context.result, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('reports GitHub App readiness without exposing credential values', async () => {
	const response = await app.request('/api/github-app/status');
	assert.equal(response.status, 200);
	const status = await response.json() as Record<string, unknown>;
	assert.deepEqual(Object.keys(status).sort(), [
		'appIdConfigured',
		'installationIdConfigured',
		'privateKeyConfigured',
		'readyForApi',
		'readyForWebhooks',
		'webhookSecretConfigured',
		'webhooks',
	]);
	assert.equal(typeof status.webhooks, 'object');
	delete status.webhooks;
	assert.equal(Object.values(status).every((value) => typeof value === 'boolean'), true);
});

test('reports bounded GitHub App permission authority from verified snapshots', async () => {
	const response = await app.request('/api/github-app/authority');
	assert.equal(response.status, 200);
	const audit = await response.json() as Record<string, unknown>;
	assert.equal(['unobserved', 'within_policy', 'exceeds_policy'].includes(String(audit.status)), true);
	assert.equal(Array.isArray(audit.excessPermissions), true);
	for (const forbidden of ['installationId', 'accountLogin', 'deliveryId', 'permissions']) {
		assert.equal(forbidden in audit, false);
	}
});

test('keeps the Flue GitHub channel unavailable until its protected secret is configured', async () => {
	const response = await app.request('/channels/github/webhook', { method: 'POST' });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'GitHub webhooks are not configured' });
});

test('reports aggregate observability health without exposing event content', async () => {
	const response = await app.request('/api/observability/status');
	assert.equal(response.status, 200);
	const status = await response.json() as Record<string, unknown>;
	for (const key of ['byType', 'processes', 'storedBytes', 'total']) assert.equal(key in status, true);
	assert.equal(Object.keys(status).every((key) => ['byType', 'lastObservedAt', 'processes', 'storedBytes', 'total'].includes(key)), true);
	assert.equal('payload' in status, false);
});

test('reports bounded fleet workload, quota, and retention metadata without execution authority', async () => {
	const response = await app.request('/api/operations/fleet');
	assert.equal(response.status, 200);
	const view = await response.json() as Record<string, any>;
	assert.equal(typeof view.organization.concurrencyLimitConfigured, 'boolean');
	assert.equal(view.organization.enforcementMode, 'disabled');
	assert.deepEqual(Object.keys(view.organization.capacityUsage).sort(), ['activeWorkflows','ambiguousClaims','expiredClaims','providerCalls','wouldExceedPolicyClaims']);
	assert.equal(Array.isArray(view.repositories), true);
	assert.equal(view.repositories.length, 3);
	assert.equal(view.observability.retentionMode, 'indefinite');
	for (const forbidden of ['token','credential','payload','events']) assert.equal(forbidden in view, false);
});

test('reconciles expired provider claims only through an explicit idempotent operator action', async () => {
	const response = await app.request('/api/operations/capacity-claims/recover-expired', {
		method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `capacity-recovery-${randomUUID()}` }, body: JSON.stringify({ reason: 'Retire provider claims beyond their bounded lease.' }),
	});
	assert.equal(response.status, 201);
	const result = await response.json() as Record<string, unknown>;
	assert.equal(typeof result.recoveredClaims, 'number');
});

test('records policy and changes enforcement only through a separate version-bound action', async () => {
	const before = await (await app.request('/api/operations/fleet')).json() as Record<string, any>;
	const expectedVersion = before.organization.capacityPolicy?.version ?? 0;
	const response = await app.request('/api/operations/capacity-policy', {
		method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `capacity-${randomUUID()}` },
		body: JSON.stringify({ policy: { maxActiveWorkflows: 4, providerConcurrentCalls: { openaiCodex: 2, githubCopilot: 1 } }, expectedVersion, reason: 'Bound fleet subscription concurrency' }),
	});
	assert.equal(response.status, 201);
	const after = await (await app.request('/api/operations/fleet')).json() as Record<string, any>;
	assert.equal(after.organization.concurrencyLimitConfigured, true);
	assert.equal(after.organization.enforcementMode, 'disabled');
	assert.equal(after.organization.capacityPolicy.version, expectedVersion + 1);
	const enabledResponse=await app.request('/api/operations/capacity-enforcement',{method:'POST',headers:{'content-type':'application/json','idempotency-key':`capacity-enforcement-${randomUUID()}`},body:JSON.stringify({mode:'enabled',expectedVersion:after.organization.capacityEnforcement?.version??0,expectedPolicyVersion:after.organization.capacityPolicy.version,reason:'Bind enforcement only after live claim conformance.'})});
	assert.equal(enabledResponse.status,201);
	const enabled=await(await app.request('/api/operations/fleet')).json() as Record<string,any>;
	assert.equal(enabled.organization.enforcementMode,'enabled');
	const disabledResponse=await app.request('/api/operations/capacity-enforcement',{method:'POST',headers:{'content-type':'application/json','idempotency-key':`capacity-disable-${randomUUID()}`},body:JSON.stringify({mode:'disabled',expectedVersion:enabled.organization.capacityEnforcement.version,expectedPolicyVersion:enabled.organization.capacityPolicy.version,reason:'Return the shared gate to observation after the route proof.'})});
	assert.equal(disabledResponse.status,201);
	assert.equal((await(await app.request('/api/operations/fleet')).json() as Record<string,any>).organization.enforcementMode,'disabled');
});

test('admits GitHub issue actions as blocked evidence while repository writes are disabled', async () => {
	const response = await app.request('/api/github-actions', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': 'app-test-blocked-action' },
		body: JSON.stringify({
			kind: 'set_triage_label', repositoryId: 'frostyard/clix', issueNumber: 12, label: 'bobsled:ready',
		}),
	});
	assert.equal(response.status, 201);
	const action = await response.json() as { status: string; blockedReason?: string };
	assert.equal(action.status, 'blocked');
	assert.match(action.blockedReason ?? '', /read-only/);
});

test('GitHub mode redirects the UI and rejects unauthenticated APIs', async () => {
	await withGitHubAuthEnvironment(async () => {
		const page = await app.request('https://factory.example/');
		assert.equal(page.status, 302);
		assert.equal(page.headers.get('location'), '/auth/github/login');
		const api = await app.request('https://factory.example/api/repositories');
		assert.equal(api.status, 401);
		const rawAgent = await app.request('https://factory.example/agents/bobsled');
		assert.equal(rawAgent.status, 401);
		const login = await app.request('https://factory.example/auth/github/login');
		assert.equal(login.status, 302);
		assert.match(login.headers.get('location') ?? '', /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
		assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/);
		assert.match(login.headers.get('set-cookie') ?? '', /Secure/);
	});
});

test('GitHub mode exposes only the bounded unauthenticated ingress paths', async () => {
	await withGitHubAuthEnvironment(async () => {
		assert.equal((await app.request('https://factory.example/health')).status, 200);
		assert.equal((await app.request('https://factory.example/api/github-app/status')).status, 200);
		assert.equal((await app.request('https://factory.example/api/operator-auth/status')).status, 200);
		assert.equal((await app.request('https://factory.example/auth/github/callback')).status, 400);
		assert.equal((await app.request('https://factory.example/api/github-app/authority')).status, 401);
		assert.equal((await app.request('https://factory.example/api/observability/status')).status, 401);
		assert.equal((await app.request('https://factory.example/api/operator-board')).status, 401);
		assert.equal((await app.request('https://factory.example/api/intake-conversations')).status, 401);
		assert.equal((await app.request('https://factory.example/api/publication-recoveries/replays', { method: 'POST' })).status, 401);
		assert.equal((await app.request('https://factory.example/api/publication-recoveries/resolutions', { method: 'POST' })).status, 401);
	});
});

test('authenticated principals reach protected routes and mutations enforce origin', async () => {
	await withGitHubAuthEnvironment(async () => {
		const configuration = operatorAuthConfiguration()!;
		const login = operatorSessionStore.begin(configuration);
		const fakeFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith('/access_token')) return Response.json({ access_token: 'temporary' });
			if (url.endsWith('/user')) return Response.json({ id: 999, login: 'operator' });
			return Response.json({ state: 'active', role: 'member', organization: { login: 'frostyard' } });
		};
		const completed = await operatorSessionStore.complete({
			code: 'code', state: login.state, stateCookie: login.state, configuration, fetch: fakeFetch,
		});
		const headers = { cookie: `__Host-bobsled-session=${completed.sessionCookie}` };
		const page = await app.request('https://factory.example/', { headers });
		assert.equal(page.status, 200);
		const html = await page.text();
		// Only the display label reaches the page; the principal id and its
		// organisation membership stay on the server.
		assert.match(html, /"provider":"github","label":"@operator"/);
		assert.doesNotMatch(html, /github:999/);
		assert.doesNotMatch(html, /membership/);
		assert.equal((await app.request('https://factory.example/api/runs', { headers })).status, 200);
		assert.equal((await app.request('https://factory.example/api/github-app/authority', { headers })).status, 200);
		assert.equal((await app.request('https://factory.example/api/runs', { method: 'POST', headers })).status, 403);
		assert.equal((await app.request('https://factory.example/auth/logout', {
			method: 'POST', headers: { ...headers, origin: 'https://factory.example' },
		})).status, 204);
		assert.equal((await app.request('https://factory.example/api/runs', { headers })).status, 401);
	});
});
