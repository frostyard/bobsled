import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunRecord } from '../src/control-plane/ledger-contracts.ts';
import { RunOrchestrationService, isAutomaticReviewEligible } from '../src/control-plane/run-orchestration-service.ts';

function run(filesChanged: number, reviewEnabled = true): RunRecord {
	return {
		id: '00000000-0000-4000-8000-000000000001', ownerId: 'operator', status: 'succeeded', version: 3,
		createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', approvals: [], audit: [],
		jobs: [{
			id: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000001', repositoryId: 'frostyard/clix', status: 'succeeded', version: 3,
			createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', currentAttempt: 1, reviews: [], artifacts: [],
			workItemSnapshot: { source: 'manual', key: 'manual:test', title: 'Test', body: 'Test', labels: [] },
			policySnapshot: { reviewPolicy: { enabled: reviewEnabled } },
			attempts: [{ id: '00000000-0000-4000-8000-000000000003', jobId: '00000000-0000-4000-8000-000000000002', number: 1, status: 'succeeded', outcome: { evidence: { filesChanged } } }],
		}],
	} as unknown as RunRecord;
}

test('successful changed execution automatically continues into review', async () => {
	const executed = run(1);
	const reviewed = { ...executed, version: 5 };
	let reviewCalls = 0;
	const service = new RunOrchestrationService(
		{ execute: async () => executed },
		{ reviewAutomatically: async (runId, version) => { reviewCalls += 1; assert.equal(runId, executed.id); assert.equal(version, 3); return reviewed; } },
	);
	assert.equal(isAutomaticReviewEligible(executed), true);
	assert.equal(await service.execute(executed.id, {}, { id: 'operator' }), reviewed);
	assert.equal(reviewCalls, 1);
});

test('no-change execution does not spend an adversarial review call', async () => {
	const executed = run(0);
	let reviewCalls = 0;
	const service = new RunOrchestrationService(
		{ execute: async () => executed },
		{ reviewAutomatically: async () => { reviewCalls += 1; return executed; } },
	);
	assert.equal(isAutomaticReviewEligible(executed), false);
	assert.equal(await service.execute(executed.id, {}, { id: 'operator' }), executed);
	assert.equal(reviewCalls, 0);
});
