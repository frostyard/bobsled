import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubEventStore } from '../src/control-plane/github-events.ts';
import {
	PublicationWebhookReconciler,
	PublicationWebhookReconciliationError,
	type PublicationWebhookTarget,
} from '../src/control-plane/publication-webhook-reconciler.ts';
import type { DraftPublicationRecord } from '../src/control-plane/publication-contracts.ts';
import type { PublicationWebhookSignal } from '../src/control-plane/publication-service.ts';

function record(store: GitHubEventStore, deliveryId: string, eventName: string, body: Record<string, unknown>) {
	const payload = new TextEncoder().encode(JSON.stringify(body));
	return store.recordVerified({ deliveryId, eventName, payload, decodedPayload: body });
}

test('routes signed check and pull-request evidence into the bounded publication refresher', async () => {
	const store = new GitHubEventStore(':memory:');
	const signals: PublicationWebhookSignal[] = [];
	const target: PublicationWebhookTarget = {
		async refreshMatchingWebhook(signal) { signals.push(signal); return [] as DraftPublicationRecord[]; },
	};
	const reconciler = new PublicationWebhookReconciler(store, target);
	try {
		const check = record(store, 'check-run-1', 'check_run', {
			action: 'completed', repository: { id: 7, full_name: 'frostyard/clix' }, check_run: { head_sha: 'a'.repeat(40) },
		});
		assert.equal(await reconciler.reconcile(check), 0);
		const pull = record(store, 'pull-1', 'pull_request', {
			action: 'closed', repository: { id: 7, full_name: 'frostyard/clix' },
			pull_request: { number: 42, head: { sha: 'b'.repeat(40) } },
		});
		assert.equal(await reconciler.reconcile(pull), 0);
		assert.deepEqual(signals, [
			{ repositoryId: 'frostyard/clix', commitSha: 'a'.repeat(40) },
			{ repositoryId: 'frostyard/clix', commitSha: 'b'.repeat(40), pullNumber: 42 },
		]);
	} finally { store.close(); }
});

test('ignores unrelated deliveries and rejects malformed or inconsistent lifecycle evidence', async () => {
	const store = new GitHubEventStore(':memory:');
	let calls = 0;
	const target: PublicationWebhookTarget = {
		async refreshMatchingWebhook() { calls += 1; return []; },
	};
	const reconciler = new PublicationWebhookReconciler(store, target);
	try {
		assert.equal(await reconciler.reconcile(record(store, 'issue-1', 'issues', {
			action: 'opened', repository: { id: 7, full_name: 'frostyard/clix' },
		})), 0);
		const malformed = record(store, 'bad-check', 'check_run', {
			action: 'completed', repository: { id: 7, full_name: 'frostyard/clix' }, check_run: {},
		});
		await assert.rejects(reconciler.reconcile(malformed), PublicationWebhookReconciliationError);
		const inconsistent = record(store, 'repo-check', 'check_run', {
			action: 'completed', repository: { id: 7, full_name: 'frostyard/clix' }, check_run: { head_sha: 'c'.repeat(40) },
		});
		await assert.rejects(reconciler.reconcile({ ...inconsistent, repositoryFullName: 'frostyard/bobsled' }), PublicationWebhookReconciliationError);
		assert.equal(calls, 0);
	} finally { store.close(); }
});
