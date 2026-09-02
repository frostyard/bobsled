import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Bobsled } from './agents/bobsled.ts';
import { CodexAgent } from './agents/codex.ts';
import { CopilotAgent } from './agents/copilot.ts';
import { createBobsledGitHubChannel } from './channels/github.ts';
import { clixFixtures } from './control-plane/fixtures.ts';
import { githubReader } from './control-plane/github-reader.ts';
import { githubAppStatus } from './control-plane/github-app.ts';
import {
	githubIssueActions,
	GitHubActionConflictError,
	GitHubActionForbiddenError,
	GitHubActionNotFoundError,
	GitHubActionPolicyBlockedError,
	GitHubActionUpstreamError,
} from './control-plane/github-actions.ts';
import { auditGitHubPermissions, GitHubInstallationConfigurationError } from './control-plane/github-installation.ts';
import {
	githubEventStore,
} from './control-plane/github-events.ts';
import {
	jobLedger,
	LedgerConflictError,
	LedgerForbiddenError,
	LedgerNotFoundError,
} from './control-plane/ledger.ts';
import { getRepository, repositories } from './control-plane/repositories.ts';
import { triageWorkItem } from './control-plane/triage-service.ts';
import { controlPlaneHtml } from './control-plane/ui.ts';
import { projectOperatorBoard } from './control-plane/operator-board-view.ts';
import {
	operatorAuthConfiguration,
	operatorAuthStatus,
	requestOriginAllowed,
} from './control-plane/operator-auth.ts';
import {
	operatorSessionStore,
	OperatorAuthError,
	OperatorAuthForbiddenError,
	type OperatorPrincipal,
} from './control-plane/operator-sessions.ts';
import { flueObservationStore } from './control-plane/observability.ts';
import { reviewService } from './control-plane/review-service.ts';
import { runOrchestrationService } from './control-plane/run-orchestration-service.ts';
import {
	draftPublications,
	PublicationConflictError,
	PublicationForbiddenError,
	PublicationNotFoundError,
	PublicationPolicyBlockedError,
	PublicationUpstreamError,
} from './control-plane/publication-service.ts';
import './providers.ts';

const app = new Hono<{ Variables: { principal: OperatorPrincipal | typeof localPrincipal } }>();
const localPrincipal = { id: 'local-operator' } as const;
const sessionCookie = '__Host-bobsled-session';
const oauthStateCookie = '__Host-bobsled-oauth-state';

app.use('*', async (context, next) => {
	const publicPath = context.req.path === '/health' ||
		context.req.path === '/api/github-app/status' ||
		context.req.path === '/api/operator-auth/status' ||
		context.req.path === '/channels/github/webhook' ||
		context.req.path === '/auth/github/login' ||
		context.req.path === '/auth/github/callback';
	const status = operatorAuthStatus();
	if (status.mode === 'local_trusted') {
		context.set('principal', localPrincipal);
		return next();
	}
	if (status.mode === 'github_unconfigured') {
		if (publicPath) return next();
		return context.json({ error: 'GitHub operator authentication is requested but incomplete; control-plane routes are fail-closed' }, 503);
	}
	if (publicPath) return next();
	const configuration = operatorAuthConfiguration();
	if (!configuration) return context.json({ error: 'GitHub operator authentication is unavailable' }, 503);
	const principal = operatorSessionStore.resolve(getCookie(context, sessionCookie), configuration.sessionSecret);
	if (!principal) {
		if (context.req.path === '/') return context.redirect('/auth/github/login', 302);
		return context.json({ error: 'Authentication required' }, 401);
	}
	if (!requestOriginAllowed(context.req.raw, configuration)) return context.json({ error: 'Request origin is not allowed' }, 403);
	context.set('principal', principal);
	return next();
});

function ledgerError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'Ledger operation failed';
	if (error instanceof LedgerNotFoundError) return context.json({ error: message }, 404);
	if (error instanceof LedgerForbiddenError) return context.json({ error: message }, 403);
	if (error instanceof LedgerConflictError) return context.json({ error: message }, 409);
	return context.json({ error: message }, 400);
}

function githubActionError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'GitHub issue action failed';
	if (error instanceof GitHubActionNotFoundError) return context.json({ error: message }, 404);
	if (error instanceof GitHubActionForbiddenError) return context.json({ error: message }, 403);
	if (error instanceof GitHubActionPolicyBlockedError) return context.json({ error: message }, 409);
	if (error instanceof GitHubActionConflictError) return context.json({ error: message }, 409);
	if (error instanceof GitHubInstallationConfigurationError) return context.json({ error: message }, 503);
	if (error instanceof GitHubActionUpstreamError) return context.json({ error: message }, 502);
	return context.json({ error: message }, 400);
}

function publicationError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'Draft publication failed';
	if (error instanceof PublicationNotFoundError) return context.json({ error: message }, 404);
	if (error instanceof PublicationForbiddenError) return context.json({ error: message }, 403);
	if (error instanceof PublicationConflictError || error instanceof PublicationPolicyBlockedError) return context.json({ error: message }, 409);
	if (error instanceof GitHubInstallationConfigurationError) return context.json({ error: message }, 503);
	if (error instanceof PublicationUpstreamError) return context.json({ error: message }, 502);
	return context.json({ error: message }, 400);
}

app.route('/agents/bobsled', createAgentRouter(Bobsled));
app.route('/agents/codex', createAgentRouter(CodexAgent));
app.route('/agents/copilot', createAgentRouter(CopilotAgent));

const githubWebhookSecret = process.env.BOBSLED_GITHUB_WEBHOOK_SECRET;
if (githubWebhookSecret) {
	const githubIngress = createBobsledGitHubChannel({ webhookSecret: githubWebhookSecret });
	app.use('/channels/github/webhook', githubIngress.captureExactBody);
	app.route('/channels/github', githubIngress.channel.route());
} else {
	app.post('/channels/github/webhook', (context) => context.json({ error: 'GitHub webhooks are not configured' }, 503));
}

app.get('/', (context) => {
	const principal = context.get('principal');
	return context.html(controlPlaneHtml('login' in principal
		? { provider: 'github', login: principal.login }
		: { provider: 'local' }));
});

app.get('/api/repositories', (context) => context.json(repositories));
app.get('/api/github-app/status', (context) => context.json({ ...githubAppStatus(), webhooks: githubEventStore.metrics() }));
app.get('/api/github-app/authority', (context) => context.json(auditGitHubPermissions(githubEventStore.latestInstallationSnapshot())));
app.get('/api/operator-auth/status', (context) => context.json(operatorAuthStatus()));
app.get('/api/observability/status', (context) => context.json(flueObservationStore.metrics()));

app.get('/auth/github/login', (context) => {
	const configuration = operatorAuthConfiguration();
	if (operatorAuthStatus().mode !== 'github' || !configuration) return context.json({ error: 'GitHub operator authentication is not configured' }, 503);
	const login = operatorSessionStore.begin(configuration);
	setCookie(context, oauthStateCookie, login.state, {
		httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600,
	});
	return context.redirect(login.authorizeUrl, 302);
});

app.get('/auth/github/callback', async (context) => {
	const configuration = operatorAuthConfiguration();
	if (operatorAuthStatus().mode !== 'github' || !configuration) return context.json({ error: 'GitHub operator authentication is not configured' }, 503);
	try {
		if (context.req.query('error')) throw new OperatorAuthError('GitHub authorization was not completed');
		const completed = await operatorSessionStore.complete({
			code: context.req.query('code') ?? '',
			state: context.req.query('state') ?? '',
			stateCookie: getCookie(context, oauthStateCookie) ?? '',
			configuration,
		});
		deleteCookie(context, oauthStateCookie, { path: '/', secure: true });
		setCookie(context, sessionCookie, completed.sessionCookie, {
			httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 8 * 60 * 60,
		});
		return context.redirect('/', 302);
	} catch (error) {
		deleteCookie(context, oauthStateCookie, { path: '/', secure: true });
		if (error instanceof OperatorAuthForbiddenError) return context.json({ error: error.message }, 403);
		if (error instanceof OperatorAuthError) return context.json({ error: error.message }, 400);
		return context.json({ error: 'GitHub authentication failed' }, 502);
	}
});

app.post('/auth/logout', (context) => {
	const configuration = operatorAuthConfiguration();
	if (configuration) operatorSessionStore.revoke(getCookie(context, sessionCookie), configuration.sessionSecret);
	deleteCookie(context, sessionCookie, { path: '/', secure: true });
	return context.body(null, 204);
});

app.get('/api/github-actions', (context) => context.json(githubIssueActions.list(context.get('principal'))));

app.post('/api/github-actions', async (context) => {
	try {
		return context.json(githubIssueActions.admit(
			await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? '',
		), 201);
	} catch (error) {
		return githubActionError(context, error);
	}
});

app.get('/api/github-actions/:actionId', (context) => {
	try {
		return context.json(githubIssueActions.get(context.req.param('actionId'), context.get('principal')));
	} catch (error) {
		return githubActionError(context, error);
	}
});

app.post('/api/github-actions/:actionId/execute', async (context) => {
	try {
		return context.json(await githubIssueActions.execute(context.req.param('actionId'), context.get('principal')));
	} catch (error) {
		return githubActionError(context, error);
	}
});

app.get('/api/repositories/:owner/:repository/issues', async (context) => {
	const id = `${context.req.param('owner')}/${context.req.param('repository')}`;
	const repository = getRepository(id);
	if (!repository?.capabilities.read) return context.json({ error: 'Repository is not enrolled' }, 404);
	try {
		return context.json(await githubReader.listOpenIssues(id, context.req.raw.signal));
	} catch (error) {
		return context.json({ error: error instanceof Error ? error.message : 'GitHub intake failed' }, 502);
	}
});

app.get('/api/repositories/:owner/:repository/fixtures', (context) => {
	const id = `${context.req.param('owner')}/${context.req.param('repository')}`;
	if (!getRepository(id)) return context.json({ error: 'Repository is not enrolled' }, 404);
	return context.json(id === 'frostyard/clix' ? clixFixtures : []);
});

app.post('/api/triage', async (context) => {
	try {
		return context.json(await triageWorkItem(await context.req.json()));
	} catch (error) {
		return context.json({ error: error instanceof Error ? error.message : 'Triage failed' }, 400);
	}
});

app.get('/api/runs', (context) => context.json(jobLedger.list(context.get('principal'))));

app.get('/api/operator-board', (context) => {
	const principal = context.get('principal');
	return context.json(projectOperatorBoard(jobLedger.list(principal), draftPublications.list(principal)));
});

app.get('/api/runs/:runId', (context) => {
	try {
		return context.json(jobLedger.get(context.req.param('runId'), context.get('principal')));
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.post('/api/runs', async (context) => {
	try {
		return context.json(
			jobLedger.admit(await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? ''),
			201,
		);
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.post('/api/runs/:runId/override', async (context) => {
	try {
		return context.json(jobLedger.overrideBlocked(context.req.param('runId'), await context.req.json(), context.get('principal')));
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.post('/api/runs/:runId/cancel', async (context) => {
	try {
		return context.json(jobLedger.cancel(context.req.param('runId'), await context.req.json(), context.get('principal')));
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.post('/api/runs/:runId/execute', async (context) => {
	try {
		return context.json(await runOrchestrationService.execute(
			context.req.param('runId'), await context.req.json(), context.get('principal'),
		));
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.post('/api/runs/:runId/review', async (context) => {
	try {
		return context.json(await reviewService.review(
			context.req.param('runId'), await context.req.json(), context.get('principal'),
		));
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.get('/api/publications', (context) => context.json(draftPublications.list(context.get('principal'))));

app.post('/api/publications', async (context) => {
	try {
		return context.json(await draftPublications.admit(
			await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? '',
		), 201);
	} catch (error) {
		return publicationError(context, error);
	}
});

app.post('/api/publications/:publicationId/execute', async (context) => {
	try {
		return context.json(await draftPublications.execute(context.req.param('publicationId'), context.get('principal')));
	} catch (error) {
		return publicationError(context, error);
	}
});

app.post('/api/publications/:publicationId/refresh-checks', async (context) => {
	try {
		return context.json(await draftPublications.refreshChecks(context.req.param('publicationId'), context.get('principal')));
	} catch (error) {
		return publicationError(context, error);
	}
});

app.get('/health', (context) =>
	context.json({
		ok: true,
		agents: ['bobsled', 'codex', 'copilot', 'triage', 'implementation-worker', 'integration-worker', 'adversarial-reviewer', 'remediation-worker'],
		repositories: repositories.map(({ id, readOnly }) => ({ id, readOnly })),
		githubApp: githubAppStatus(),
		operatorAuth: operatorAuthStatus(),
		observability: flueObservationStore.metrics(),
	}),
);

export default app;
