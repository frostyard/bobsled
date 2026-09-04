import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Bobsled } from './agents/bobsled.ts';
import { CodexAgent } from './agents/codex.ts';
import { CopilotAgent } from './agents/copilot.ts';
import { createBobsledGitHubChannel } from './channels/github.ts';
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
import { repositoryDriftService } from './control-plane/repository-drift.ts';
import { repositoryDriftObservationStore, RepositoryDriftObservationConflictError, RepositoryDriftObservationIntegrityError } from './control-plane/repository-drift-observation-store.ts';
import { repositoryEnrollmentService, RepositoryEnrollmentPolicyError, RepositoryEnrollmentUpstreamError } from './control-plane/repository-enrollment-service.ts';
import { fleetOperationsProjector } from './control-plane/fleet-operations-view.ts';
import { RepositoryEnrollmentConflictError, RepositoryEnrollmentIntegrityError } from './control-plane/repository-enrollment-store.ts';
import { triageWorkItem } from './control-plane/triage-service.ts';
import { IntakeConversationConflictError, IntakeConversationForbiddenError, IntakeConversationNotFoundError, IntakeConversationStore } from './control-plane/intake-conversation-store.ts';
import { IntakeConversationRevisionConflictError, IntakeConversationRevisionForbiddenError, IntakeConversationRevisionNotFoundError, IntakeConversationRevisionStore } from './control-plane/intake-conversation-revision-store.ts';
import { IntakeConversationRevisionService } from './control-plane/intake-conversation-revision-service.ts';
import { IntakeBriefSnapshotConflictError, IntakeBriefSnapshotForbiddenError, IntakeBriefSnapshotNotFoundError, IntakeBriefSnapshotStore } from './control-plane/intake-brief-snapshot-store.ts';
import { IntakeSnapshotTriageConflictError, IntakeSnapshotTriageForbiddenError, IntakeSnapshotTriageNotFoundError, IntakeSnapshotTriageStore } from './control-plane/intake-snapshot-triage-store.ts';
import { IntakeSnapshotTriageService } from './control-plane/intake-snapshot-triage-service.ts';
import { IntakeSnapshotRunAdmissionConflictError, IntakeSnapshotRunAdmissionForbiddenError, IntakeSnapshotRunAdmissionNotFoundError, IntakeSnapshotRunAdmissionService, IntakeSnapshotRunAdmissionStore } from './control-plane/intake-snapshot-run-admission-store.ts';
import { controlPlaneHtml } from './control-plane/ui/index.ts';
import { projectOperatorBoard } from './control-plane/operator-board-view.ts';
import { MultiWorkerOperatorStore } from './control-plane/multi-worker-operator-view.ts';
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
import { PublicationWebhookReconciler } from './control-plane/publication-webhook-reconciler.ts';
import {
	publicationRebases,
	PublicationRebaseConflictError,
	PublicationRebaseForbiddenError,
	PublicationRebaseNotFoundError,
} from './control-plane/publication-rebase-service.ts';
import {
	publicationRebaseReviews,
	PublicationRebaseReviewConflictError,
	PublicationRebaseReviewForbiddenError,
	PublicationRebaseReviewNotFoundError,
} from './control-plane/publication-rebase-review-service.ts';
import {
	publicationRecoveryResolutions,
	PublicationRecoveryResolutionConflictError,
	PublicationRecoveryResolutionForbiddenError,
} from './control-plane/publication-recovery-resolution-service.ts';
import './providers.ts';

const app = new Hono<{ Variables: { principal: OperatorPrincipal | typeof localPrincipal } }>();
const localPrincipal = { id: 'local-operator' } as const;
const sessionCookie = '__Host-bobsled-session';
const oauthStateCookie = '__Host-bobsled-oauth-state';
/** The operator screens, which are HTML; everything else under /api is JSON. */
const interfacePaths = /^\/(?:$|intake$|activity$|access$|change-sets$|runs\/[^/]+(?:\/live)?$)/;
const intakeConversations = new IntakeConversationStore();
const intakeRevisions = new IntakeConversationRevisionStore(undefined, undefined, intakeConversations);
const intakeRevisionService = new IntakeConversationRevisionService(intakeRevisions);
const intakeSnapshots = new IntakeBriefSnapshotStore(undefined, undefined, intakeConversations);
const intakeSnapshotTriages = new IntakeSnapshotTriageStore(undefined, undefined, intakeSnapshots);
const intakeSnapshotTriageService = new IntakeSnapshotTriageService(intakeSnapshotTriages);
const intakeSnapshotRunAdmissions = new IntakeSnapshotRunAdmissionStore(undefined, undefined, intakeSnapshotTriages, intakeConversations, jobLedger);
const intakeSnapshotRunAdmissionService = new IntakeSnapshotRunAdmissionService(intakeSnapshotRunAdmissions, jobLedger);

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
		// A browser asking for an operator screen is sent to sign in; an API
		// caller gets a status it can act on.
		if (interfacePaths.test(context.req.path)) return context.redirect('/auth/github/login', 302);
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

function intakeConversationError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'Conversational intake failed';
	if (error instanceof IntakeConversationNotFoundError || error instanceof IntakeConversationRevisionNotFoundError || error instanceof IntakeBriefSnapshotNotFoundError || error instanceof IntakeSnapshotTriageNotFoundError || error instanceof IntakeSnapshotRunAdmissionNotFoundError) return context.json({ error: message }, 404);
	if (error instanceof IntakeConversationForbiddenError || error instanceof IntakeConversationRevisionForbiddenError || error instanceof IntakeBriefSnapshotForbiddenError || error instanceof IntakeSnapshotTriageForbiddenError || error instanceof IntakeSnapshotRunAdmissionForbiddenError) return context.json({ error: message }, 403);
	if (error instanceof IntakeConversationConflictError || error instanceof IntakeConversationRevisionConflictError || error instanceof IntakeBriefSnapshotConflictError || error instanceof IntakeSnapshotTriageConflictError || error instanceof IntakeSnapshotRunAdmissionConflictError || error instanceof LedgerConflictError) return context.json({ error: message }, 409);
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

function publicationRecoveryError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'Publication recovery failed';
	if (error instanceof PublicationRebaseNotFoundError || error instanceof PublicationRebaseReviewNotFoundError || error instanceof PublicationNotFoundError) return context.json({ error: message }, 404);
	if (error instanceof PublicationRebaseForbiddenError || error instanceof PublicationRebaseReviewForbiddenError || error instanceof PublicationRecoveryResolutionForbiddenError || error instanceof PublicationForbiddenError) return context.json({ error: message }, 403);
	if (error instanceof PublicationRebaseConflictError || error instanceof PublicationRebaseReviewConflictError || error instanceof PublicationRecoveryResolutionConflictError || error instanceof PublicationConflictError || error instanceof PublicationPolicyBlockedError) return context.json({ error: message }, 409);
	if (error instanceof GitHubInstallationConfigurationError) return context.json({ error: message }, 503);
	if (error instanceof PublicationUpstreamError) return context.json({ error: message }, 502);
	return context.json({ error: message }, 400);
}

function repositoryEnrollmentError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'Repository enrollment failed';
	if (error instanceof RepositoryEnrollmentConflictError) return context.json({ error: message }, 409);
	if (error instanceof RepositoryEnrollmentPolicyError) return context.json({ error: message }, 422);
	if (error instanceof RepositoryEnrollmentUpstreamError) return context.json({ error: message }, 502);
	if (error instanceof RepositoryEnrollmentIntegrityError) return context.json({ error: message }, 503);
	if (error instanceof GitHubInstallationConfigurationError) return context.json({ error: message }, 503);
	return context.json({ error: message }, 400);
}

function repositoryDriftError(context: Parameters<Parameters<typeof app.onError>[0]>[1], error: unknown) {
	const message = error instanceof Error ? error.message : 'Repository drift check failed';
	if (error instanceof RepositoryDriftObservationConflictError) return context.json({ error: message }, 409);
	if (error instanceof RepositoryDriftObservationIntegrityError) return context.json({ error: message }, 503);
	return context.json({ error: message }, 400);
}

function repositoryDriftProjection() {
	return repositoryDriftObservationStore.latest().map((observation) => ({
		...observation.record,
		enrollmentVersion: observation.enrollmentVersion,
		observationCount: repositoryDriftObservationStore.count(observation.repositoryId),
		policyImpact: repositoryDriftObservationStore.policyImpact(observation.repositoryId, observation.record.policyDigest),
	}));
}

app.route('/agents/bobsled', createAgentRouter(Bobsled));
app.route('/agents/codex', createAgentRouter(CodexAgent));
app.route('/agents/copilot', createAgentRouter(CopilotAgent));

const githubWebhookSecret = process.env.BOBSLED_GITHUB_WEBHOOK_SECRET;
if (githubWebhookSecret) {
	const publicationWebhookReconciler = new PublicationWebhookReconciler(githubEventStore, draftPublications);
	const githubIngress = createBobsledGitHubChannel({
		webhookSecret: githubWebhookSecret,
		onRecorded: async (delivery) => { await publicationWebhookReconciler.reconcile(delivery); },
	});
	app.use('/channels/github/webhook', githubIngress.captureExactBody);
	app.route('/channels/github', githubIngress.channel.route());
} else {
	app.post('/channels/github/webhook', (context) => context.json({ error: 'GitHub webhooks are not configured' }, 503));
}

function operatorInterfaceHtml(principal: OperatorPrincipal | typeof localPrincipal): string {
	return controlPlaneHtml('login' in principal
		? { provider: 'github', login: principal.login }
		: { provider: 'local' });
}

// Every operator surface is one document; the client reads location.pathname.
// Listing the paths explicitly keeps an unknown address a 404 rather than
// silently serving the interface for anything at all.
app.get('/', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));
app.get('/intake', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));
app.get('/activity', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));
app.get('/access', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));
app.get('/change-sets', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));
app.get('/runs/:runId', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));
app.get('/runs/:runId/live', (context) => context.html(operatorInterfaceHtml(context.get('principal'))));

app.get('/api/repositories', (context) => context.json(repositories.filter(({ enabled }) => enabled)));

app.get('/api/repositories/drift', (context) => {
	try { return context.json(repositoryDriftProjection()); }
	catch (error) { return repositoryDriftError(context, error); }
});
app.post('/api/repositories/drift/check', async (context) => {
	try {
		const principal = context.get('principal');
		const idempotencyKey = context.req.header('idempotency-key') ?? '';
		const replay = repositoryDriftObservationStore.replay(principal, idempotencyKey);
		if (replay) return context.json(repositoryDriftProjection());
		const records = await repositoryDriftService.inspectAll();
		const enrollmentVersions = new Map(repositoryEnrollmentService.list().map(({ repository, version }) => [repository.id, version]));
		repositoryDriftObservationStore.record(records.map((record) => ({ record, enrollmentVersion: enrollmentVersions.get(record.repositoryId) })), principal, idempotencyKey);
		return context.json(repositoryDriftProjection());
	} catch (error) { return repositoryDriftError(context, error); }
});
app.get('/api/repository-enrollments', (context) => context.json(repositoryEnrollmentService.list()));
app.get('/api/repository-enrollments/discover', async (context) => {
	try { return context.json(await repositoryEnrollmentService.discover()); }
	catch (error) { return repositoryEnrollmentError(context, error); }
});
app.post('/api/repository-enrollments', async (context) => {
	try { return context.json(await repositoryEnrollmentService.enroll(await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? ''), 201); }
	catch (error) { return repositoryEnrollmentError(context, error); }
});
app.post('/api/repository-enrollments/:owner/:repository/disable', async (context) => {
	try { return context.json(repositoryEnrollmentService.disable({ ...await context.req.json(), repositoryId: `${context.req.param('owner')}/${context.req.param('repository')}` }, context.get('principal'), context.req.header('idempotency-key') ?? '')); }
	catch (error) { return repositoryEnrollmentError(context, error); }
});
app.get('/api/github-app/status', (context) => context.json({ ...githubAppStatus(), webhooks: githubEventStore.metrics() }));
app.get('/api/github-app/authority', (context) => context.json(auditGitHubPermissions(githubEventStore.latestInstallationSnapshot())));
app.get('/api/operator-auth/status', (context) => context.json(operatorAuthStatus()));
app.get('/api/observability/status', (context) => context.json(flueObservationStore.metrics()));
app.get('/api/operations/fleet', (context) => context.json(fleetOperationsProjector.project(repositoryEnrollmentService.list().map(({ repository }) => repository))));

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

app.post('/api/triage', async (context) => {
	try {
		return context.json(await triageWorkItem(await context.req.json()));
	} catch (error) {
		return context.json({ error: error instanceof Error ? error.message : 'Triage failed' }, 400);
	}
});

app.get('/api/intake-conversations', (context) => context.json(intakeConversations.list(context.get('principal'))));

app.post('/api/intake-conversations', async (context) => {
	try {
		return context.json(intakeConversations.create(await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? ''), 201);
	} catch (error) { return intakeConversationError(context, error); }
});

app.get('/api/intake-conversations/:conversationId', (context) => {
	try { return context.json(intakeConversations.get(context.req.param('conversationId'), context.get('principal'))); }
	catch (error) { return intakeConversationError(context, error); }
});

app.get('/api/intake-conversations/:conversationId/revisions', (context) => {
	try { return context.json(intakeRevisions.list(context.req.param('conversationId'), context.get('principal'))); }
	catch (error) { return intakeConversationError(context, error); }
});

app.post('/api/intake-conversations/:conversationId/revisions', async (context) => {
	try {
		const body = await context.req.json() as { expectedVersion?: unknown; message?: unknown };
		const revision = intakeRevisions.reserve({conversationId:context.req.param('conversationId'),expectedVersion:body.expectedVersion,message:body.message,reason:'Operator explicitly requested one conversational brief revision.'}, context.get('principal'), context.req.header('idempotency-key') ?? '');
		const settled = await intakeRevisionService.run(revision.id, context.get('principal'));
		return context.json({ revision:settled, conversation:intakeConversations.get(revision.conversationId, context.get('principal')) }, 201);
	} catch (error) { return intakeConversationError(context, error); }
});

app.post('/api/intake-conversations/:conversationId/cancel', async (context) => {
	try { return context.json(intakeConversations.cancel(context.req.param('conversationId'), await context.req.json(), context.get('principal'))); }
	catch (error) { return intakeConversationError(context, error); }
});

app.post('/api/intake-conversations/:conversationId/corrections', async (context) => {
	try { return context.json(intakeConversations.correct(context.req.param('conversationId'),await context.req.json(),context.get('principal'),context.req.header('idempotency-key')??''),201); }
	catch (error) { return intakeConversationError(context,error); }
});

app.get('/api/intake-conversations/:conversationId/snapshot', (context) => {
	try { return context.json(intakeSnapshots.getForConversation(context.req.param('conversationId'), context.get('principal'))); }
	catch (error) { return intakeConversationError(context, error); }
});

app.post('/api/intake-conversations/:conversationId/finalize', async (context) => {
	try {
		const body=await context.req.json() as {expectedVersion?:unknown;reason?:unknown};
		const snapshot=intakeSnapshots.finalize({conversationId:context.req.param('conversationId'),expectedVersion:body.expectedVersion,reason:body.reason},context.get('principal'),context.req.header('idempotency-key')??'');
		return context.json({snapshot,conversation:intakeConversations.get(snapshot.conversationId,context.get('principal'))},201);
	} catch (error) { return intakeConversationError(context, error); }
});

app.get('/api/intake-conversations/:conversationId/snapshot/triage', (context) => {
	try { const snapshot=intakeSnapshots.getForConversation(context.req.param('conversationId'),context.get('principal'));return context.json(intakeSnapshotTriages.getForSnapshot(snapshot.id,context.get('principal'))??null); }
	catch (error) { return intakeConversationError(context,error); }
});

app.post('/api/intake-conversations/:conversationId/snapshot/triage', async (context) => {
	try { const snapshot=intakeSnapshots.getForConversation(context.req.param('conversationId'),context.get('principal')),triage=intakeSnapshotTriages.reserve({snapshotId:snapshot.id,reason:'Operator explicitly requested independent triage of this immutable final brief.'},context.get('principal'),context.req.header('idempotency-key')??'');return context.json(await intakeSnapshotTriageService.run(triage.id,context.get('principal')),201); }
	catch (error) { return intakeConversationError(context,error); }
});

app.get('/api/intake-conversations/:conversationId/snapshot/admission', (context) => {
	try { const snapshot=intakeSnapshots.getForConversation(context.req.param('conversationId'),context.get('principal')),triage=intakeSnapshotTriages.getForSnapshot(snapshot.id,context.get('principal'));if(!triage)return context.json(null);return context.json(intakeSnapshotRunAdmissions.getForTriage(triage.id,context.get('principal'))??null); }
	catch (error) { return intakeConversationError(context,error); }
});

app.post('/api/intake-conversations/:conversationId/snapshot/admission', async (context) => {
	try { const snapshot=intakeSnapshots.getForConversation(context.req.param('conversationId'),context.get('principal')),triage=intakeSnapshotTriages.getForSnapshot(snapshot.id,context.get('principal'));if(!triage)throw new IntakeSnapshotRunAdmissionConflictError('Independent snapshot triage is required before run admission');const admission=intakeSnapshotRunAdmissions.reserve({triageId:triage.id,reason:'Operator explicitly admitted this immutable snapshot and independent triage as a ledger run.'},context.get('principal'),context.req.header('idempotency-key')??'');return context.json(intakeSnapshotRunAdmissionService.admit(admission.id,context.get('principal')),201); }
	catch (error) { return intakeConversationError(context,error); }
});

app.get('/api/runs', (context) => context.json(jobLedger.list(context.get('principal'))));

app.get('/api/operator-board', (context) => {
	const principal = context.get('principal');
	const multiWorker = new MultiWorkerOperatorStore();
	try {
		return context.json(projectOperatorBoard(
			jobLedger.list(principal), draftPublications.list(principal), new Date(), multiWorker.list(principal.id),
			publicationRebases.list(principal), publicationRebaseReviews.list(principal), publicationRecoveryResolutions.list(principal),
		));
	} finally {
		multiWorker.close();
	}
});

app.get('/api/runs/:runId', (context) => {
	try {
		return context.json(jobLedger.get(context.req.param('runId'), context.get('principal')));
	} catch (error) {
		return ledgerError(context, error);
	}
});

/**
 * Read-only live activity for one run: the Flue observations already recorded
 * for its implementation, review, and remediation workers.
 *
 * Watching is not steering. This route starts nothing, claims nothing, spends
 * no subscription call, and offers no way to reach into a running attempt --
 * every bound downstream of a run assumes nobody did.
 */
app.get('/api/runs/:runId/activity', (context) => {
	try {
		const run = jobLedger.get(context.req.param('runId'), context.get('principal'));
		const job = run.jobs[0];
		const prefixes = job
			? [
				...job.attempts.map((attempt) => `implementation-${attempt.id}`),
				...job.reviews.flatMap((review) => [`review-${review.id}-`, `remediation-${review.id}-`]),
			]
			: [];
		const after = Number.parseInt(context.req.query('after') ?? '0', 10);
		const events = flueObservationStore.activity(prefixes, Number.isFinite(after) && after > 0 ? after : 0);
		return context.json({ runId: run.id, status: run.status, events });
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

app.post('/api/runs/:runId/archive', async (context) => {
	try {
		return context.json(jobLedger.archive(context.req.param('runId'), await context.req.json(), context.get('principal')));
	} catch (error) {
		return ledgerError(context, error);
	}
});

app.post('/api/runs/:runId/restore', async (context) => {
	try {
		return context.json(jobLedger.restore(context.req.param('runId'), await context.req.json(), context.get('principal')));
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

app.post('/api/publication-recoveries/replays', async (context) => {
	try {
		const admitted = publicationRebases.admit(await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? '');
		return context.json(await publicationRebases.execute(admitted.id, context.get('principal')), 201);
	} catch (error) { return publicationRecoveryError(context, error); }
});

app.post('/api/publication-recoveries/replays/:rebaseId/execute', async (context) => {
	try { return context.json(await publicationRebases.execute(context.req.param('rebaseId'), context.get('principal'))); }
	catch (error) { return publicationRecoveryError(context, error); }
});

app.post('/api/publication-recoveries/replays/:rebaseId/reviews', async (context) => {
	try {
		const input = await context.req.json() as { reason?: unknown };
		const admitted = publicationRebaseReviews.admit({ rebaseId: context.req.param('rebaseId'), reason: input.reason }, context.get('principal'), context.req.header('idempotency-key') ?? '');
		return context.json(await publicationRebaseReviews.execute(admitted.id, context.get('principal')), 201);
	} catch (error) { return publicationRecoveryError(context, error); }
});

app.post('/api/publication-recoveries/reviews/:reviewId/execute', async (context) => {
	try { return context.json(await publicationRebaseReviews.execute(context.req.param('reviewId'), context.get('principal'))); }
	catch (error) { return publicationRecoveryError(context, error); }
});

app.post('/api/publication-recoveries/reviews/:reviewId/promote', async (context) => {
	try {
		const input = await context.req.json() as { reason?: unknown };
		return context.json(await draftPublications.admitRecovered(
			{ rebaseReviewId: context.req.param('reviewId'), reason: input.reason }, context.get('principal'), context.req.header('idempotency-key') ?? '',
		), 201);
	} catch (error) { return publicationRecoveryError(context, error); }
});

app.post('/api/publication-recoveries/resolutions', async (context) => {
	try {
		return context.json(publicationRecoveryResolutions.admit(
			await context.req.json(), context.get('principal'), context.req.header('idempotency-key') ?? '',
		), 201);
	} catch (error) { return publicationRecoveryError(context, error); }
});

app.get('/health', (context) =>
	context.json({
		ok: true,
		agents: ['bobsled', 'codex', 'copilot', 'triage', 'intake-brief-revision', 'intake-snapshot-triage', 'implementation-worker', 'integration-worker', 'integration-conflict-worker', 'adversarial-reviewer', 'remediation-worker'],
		repositories: repositories.filter(({ enabled }) => enabled).map(({ id, readOnly }) => ({ id, readOnly })),
		githubApp: githubAppStatus(),
		operatorAuth: operatorAuthStatus(),
		observability: flueObservationStore.metrics(),
	}),
);

export default app;
