import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { TriageDecisionSchema } from '../src/control-plane/contracts.ts';
import { ImplementationResultSchema, parseStoredWorkerOutcome } from '../src/control-plane/execution-contracts.ts';

const ready = {
	route: 'ready_for_agent',
	risk: 'low',
	confidence: 0.9,
	summary: 'Bounded documentation update',
	rationale: 'Clear request with no protected paths.',
	acceptanceCriteria: ['Document cancellation behavior.'],
	missingInformation: [],
	suggestedLabels: ['bobsled:ready'],
	eligibleForOneClick: true,
};

test('accepts a policy-consistent one-click triage decision', () => {
	assert.deepEqual(v.parse(TriageDecisionSchema, ready), ready);
});

test('rejects one-click eligibility when information is missing', () => {
	assert.throws(() => v.parse(TriageDecisionSchema, {
		...ready,
		missingInformation: ['Which API behavior is intended?'],
	}));
});

test('rejects a route label that disagrees with the decision', () => {
	assert.throws(() => v.parse(TriageDecisionSchema, {
		...ready,
		suggestedLabels: ['bobsled:needs-human'],
	}));
});

test('implementation disposition agrees with model-reported paths', () => {
	const base = { summary: 'Result.', testsRun: [], notes: [] };
	assert.equal(v.parse(ImplementationResultSchema, { ...base, disposition: 'no_change', changedPaths: [] }).disposition, 'no_change');
	assert.throws(() => v.parse(ImplementationResultSchema, { ...base, disposition: 'changed', changedPaths: [] }));
	assert.throws(() => v.parse(ImplementationResultSchema, { ...base, disposition: 'no_change', changedPaths: ['README.md'] }));
});

test('historical worker evidence gains a read-time disposition without weakening new writes', () => {
	const historical = {
		conversationId: 'historical-worker', submissionId: 'historical-submission', text: '',
		plan: {
			summary: 'Historical plan.',
			tasks: [{ id: 'implementation', objective: 'Change README.', expectedPaths: ['README.md'], acceptanceCriteria: ['README changes.'] }],
			assumptions: [], risks: [],
		},
		result: { summary: 'Changed README.', changedPaths: ['README.md'], testsRun: [], notes: [] },
	};
	assert.equal(parseStoredWorkerOutcome(historical).result.disposition, 'changed');
	assert.throws(() => v.parse(ImplementationResultSchema, historical.result));
});
