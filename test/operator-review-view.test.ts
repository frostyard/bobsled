import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewReport } from '../src/control-plane/execution-contracts.ts';
import { projectReviewForOperator } from '../src/control-plane/operator-review-view.ts';

const initial: ReviewReport = {
	verdict: 'changes_requested', summary: 'One correction is required.', testedClaims: ['The patch is bounded.'], residualRisks: [],
	findings: [{ id: 'finding-1', severity: 'moderate', category: 'maintainability', blocking: true, summary: 'Pins can drift.', evidence: 'Two files carry independent values.', remediation: 'Add an enforced consistency check.' }],
};

const final: ReviewReport = {
	verdict: 'changes_requested', summary: 'The remediation still permits drift.', testedClaims: ['Both gates passed.'], residualRisks: ['Other consumers were not inspected.'],
	findings: [{ id: 'finding-1', severity: 'moderate', category: 'scope', blocking: true, summary: 'Pins remain unguarded.', evidence: 'No gate compares them.', remediation: 'Compare the pins during verification.' }],
};

test('projects a blocked review into operator findings, remediation, evidence, and safe next action', () => {
	const view = projectReviewForOperator({
		status: 'blocked', initialVerdict: initial, finalVerdict: final,
		outcome: {
			evidence: {
				baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), headMoved: false,
				changedPaths: ['go.mod', 'mise.toml'], filesChanged: 2, diffLines: 12, diffSha256: 'b'.repeat(64),
				protectedPaths: [], policyViolations: [], workspacePath: '/tmp/workspace', evidencePath: '/tmp/evidence',
				gates: [{ id: 'verify', name: 'Verification', command: 'make verify', status: 'passed', exitCode: 0, durationMs: 10, stdout: '', stderr: '', truncated: false }],
			},
			remediation: {
				conversationId: 'remediation', submissionId: 'submission', text: '',
				result: { summary: 'Changed the pin source.', addressedFindingIds: ['finding-1'], unresolvedFindingIds: [], changedPaths: ['mise.toml'], testsRun: ['make verify'], notes: [] },
			},
		},
	});
	assert.equal(view.primaryReport?.summary, final.summary);
	assert.equal(view.remediation?.performed, true);
	assert.equal(view.evidence?.gates[0]?.status, 'passed');
	assert.equal(view.evidence?.headMoved, false);
	assert.equal(view.nextAction.kind, 'start_revised_run');
	assert.match(view.nextAction.guidance, /Do not re-review/);
});

test('projects approval and malformed historical evidence without hiding the operator action', () => {
	const approved = projectReviewForOperator({ status: 'approved', initialVerdict: { verdict: 'approve', summary: 'Sound.', findings: [], testedClaims: [], residualRisks: [] } });
	assert.equal(approved.nextAction.kind, 'prepare_publication');
	const historical = projectReviewForOperator({ status: 'failed', initialVerdict: { obsolete: true }, outcome: { error: 'Provider unavailable' } });
	assert.equal(historical.primaryReport, undefined);
	assert.equal(historical.error, 'Provider unavailable');
	assert.equal(historical.nextAction.kind, 'inspect_failure');
});
