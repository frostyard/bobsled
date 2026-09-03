import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IntegrationGateService } from '../src/control-plane/integration-gate-service.ts';
import { IntegrationInvocationStore } from '../src/control-plane/integration-invocation-store.ts';
import { IntegrationOrchestrationService } from '../src/control-plane/integration-orchestration-service.ts';
import { IntegrationPreflightService } from '../src/control-plane/integration-preflight-service.ts';
import { IntegrationPreparationService } from '../src/control-plane/integration-preparation-service.ts';
import { JobLedger } from '../src/control-plane/ledger.ts';
import { MultiWorkerParentStore } from '../src/control-plane/multi-worker-parent-store.ts';

const ownerId = 'operator';

function git(root: string, args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture(repositoryId = 'frostyard/clix') {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-integration-orchestration-'));
	const workspacePath = join(root, 'workspace');
	mkdirSync(join(workspacePath, 'src', 'api'), { recursive: true });
	mkdirSync(join(workspacePath, 'src', 'integration'), { recursive: true });
	git(root, ['init', '--quiet', '--initial-branch=main', workspacePath]);
	git(workspacePath, ['config', 'user.name', 'Bobsled Test']);
	git(workspacePath, ['config', 'user.email', 'bobsled@example.invalid']);
	writeFileSync(join(workspacePath, 'README.md'), 'base\n');
	writeFileSync(join(workspacePath, 'src', 'integration', '.gitkeep'), '');
	git(workspacePath, ['add', '.']);
	git(workspacePath, ['commit', '--quiet', '-m', 'base']);
	const baseCommit = git(workspacePath, ['rev-parse', 'HEAD']);
	writeFileSync(join(workspacePath, 'src', 'api', 'client.ts'), 'export const client = true;\n');
	git(workspacePath, ['add', 'src/api/client.ts']);
	const stagedPatch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-renames', '--cached', 'HEAD', '--'], { cwd: workspacePath, encoding: 'utf8' });
	const assemblyPatchSha256 = createHash('sha256').update(stagedPatch).digest('hex');

	const path = join(root, 'ledger.db');
	const ledger = new JobLedger(path);
	const admitted = ledger.admit({
		repositoryId,
		workItem: { source: 'manual', key: 'm5-orchestration', title: 'Integrate API', body: '', labels: [] },
	}, { id: ownerId }, 'admit-integration');
	ledger.close();
	const plan = {
		version: 2 as const, summary: 'Integrate one completed prerequisite.',
		tasks: [
			{ id: 'api', title: 'API', objective: 'Build API.', acceptanceCriteria: ['API passes.'], dependsOn: [], fileScopes: [{ kind: 'directory' as const, path: 'src/api' }] },
			{ id: 'integration', title: 'Integration', objective: 'Integrate API.', acceptanceCriteria: ['Integration passes.'], dependsOn: ['api'], fileScopes: [{ kind: 'directory' as const, path: 'src/integration' }] },
		], assumptions: [], risks: [],
	};
	const parents = new MultiWorkerParentStore(path);
	const planId = randomUUID();
	const parent = parents.recordPlan({ planId, jobId: admitted.jobs[0]?.id, baseCommit, plan }, ownerId, 'plan');
	const assemblyId = randomUUID();
	parents.recordAssembly({
		assemblyId, planId, taskId: 'integration',
		result: {
			assemblyId, taskId: 'integration', baseCommit, workspacePath,
			appliedTaskIds: ['api'], changedPaths: ['src/api/client.ts'], workerAuthorized: false,
			status: 'assembled', patchSha256: assemblyPatchSha256,
		},
	}, ownerId);
	parents.close();
	const integrationAttemptId = randomUUID();
	const store = new IntegrationInvocationStore(path);
	store.reserve({ integrationAttemptId, assemblyId, planSha256: parent.planSha256, taskId: 'integration' }, ownerId, 'invoke');
	return { root, workspacePath, integrationAttemptId, store };
}

function passingGates(store: IntegrationInvocationStore, calls: string[] = []) {
	return new IntegrationGateService(store, async (command) => {
		calls.push(command);
		return { status: 'passed', exitCode: 0, durationMs: 1, stdout: 'ok', stderr: '', truncated: false };
	});
}

function passingPreparation(store: IntegrationInvocationStore, calls: string[] = []) {
	return new IntegrationPreparationService(store, { runner: async (command) => {
		calls.push(command);
		return { status: 'passed', exitCode: 0, durationMs: 1, stdout: 'prepared', stderr: '', truncated: false };
	} });
}

test('orchestrates one native worker receipt through trusted inspection and gates', async () => {
	const value = fixture();
	let workerCalls = 0;
	const gateCalls: string[] = [];
	const preparationCalls: string[] = [];
	const service = new IntegrationOrchestrationService(value.store, {
		preparation: passingPreparation(value.store, preparationCalls),
		gates: passingGates(value.store, gateCalls),
		worker: async (input, timeoutMs) => {
			workerCalls += 1;
			assert.equal(input.repository.id, 'frostyard/clix');
			assert.equal(input.workItem.key, 'm5-orchestration');
			assert.equal(timeoutMs, 1_200_000);
			writeFileSync(join(input.workspacePath, 'src', 'integration', 'result.ts'), 'export const integrated = true;\n');
			return {
				conversationId: 'integration-conversation', submissionId: 'integration-submission',
				result: { disposition: 'changed', summary: 'Integrated API.', changedPaths: ['src/integration/result.ts'], testsRun: [], notes: [] },
				text: 'Integrated API.',
			};
		},
		toolDataRoot: join(value.root, 'tools'),
	});
	try {
		const settled = await service.execute(value.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'succeeded');
		assert.equal(settled.workerCalls, 1);
		assert.equal(settled.workerRun?.evidence.status, 'completed');
		assert.equal(settled.outcome?.status, 'succeeded');
		assert.deepEqual(settled.outcome?.workerChangedPaths, ['src/integration/result.ts']);
		assert.deepEqual(gateCalls, ['node scripts/check-docs.mjs', 'make verify']);
		assert.deepEqual(preparationCalls, ['mise install']);
		assert.equal(settled.preparation?.result.status, 'passed');
		assert.equal(settled.finalIntegrity?.result.status, 'passed');
		assert.equal(workerCalls, 1);
		assert.equal((await service.execute(value.integrationAttemptId, ownerId)).status, 'succeeded');
		assert.equal(workerCalls, 1);
	} finally { value.store.close(); }
});

test('failed repository preparation is durable and prevents preflight and worker token spend', async () => {
	const value = fixture();
	let workerCalls = 0;
	const service = new IntegrationOrchestrationService(value.store, {
		preparation: new IntegrationPreparationService(value.store, { runner: async () => ({
			status: 'failed', exitCode: 1, durationMs: 4, stdout: '', stderr: 'mise failed', truncated: false,
		}) }),
		worker: async () => { workerCalls += 1; throw new Error('must not run'); },
	});
	try {
		const settled = await service.execute(value.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.workerCalls, 0);
		assert.equal(settled.preparation?.result.status, 'failed');
		assert.match(settled.preparation?.result.stderr ?? '', /mise failed/);
		assert.equal(settled.preflight, undefined);
		assert.equal(workerCalls, 0);
		assert.equal((await service.execute(value.integrationAttemptId, ownerId)).status, 'blocked');
		assert.equal(workerCalls, 0);
	} finally { value.store.close(); }
});

test('an expired ambiguous preparation is blocked without rerunning its command', async () => {
	const value = fixture();
	value.store.claimPreparation(value.integrationAttemptId, ownerId);
	let preparationCalls = 0;
	const preparation = new IntegrationPreparationService(value.store, {
		runner: async () => {
			preparationCalls += 1;
			return { status: 'passed', exitCode: 0, durationMs: 1, stdout: '', stderr: '', truncated: false };
		},
		now: () => new Date(Date.now() + 17 * 60_000),
	});
	const service = new IntegrationOrchestrationService(value.store, { preparation });
	try {
		const settled = await service.execute(value.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.workerCalls, 0);
		assert.equal(preparationCalls, 0);
		assert.match(settled.preparation?.result.stderr ?? '', /expired ambiguous command/);
	} finally { value.store.close(); }
});

test('blocks policy-denied integration before preflight or token spend', async () => {
	const value = fixture('frostyard/bobsled');
	let workerCalls = 0;
	const service = new IntegrationOrchestrationService(value.store, {
		preparation: passingPreparation(value.store),
		worker: async () => { workerCalls += 1; throw new Error('must not run'); },
	});
	try {
		const settled = await service.execute(value.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(settled.workerCalls, 0);
		assert.deepEqual(settled.preflight?.result.violations, ['policy_denied']);
		assert.equal(workerCalls, 0);
	} finally { value.store.close(); }
});

test('records worker failure and never retries an ambiguous claimed invocation', async () => {
	const failed = fixture();
	let failedCalls = 0;
	const failing = new IntegrationOrchestrationService(failed.store, {
		preparation: passingPreparation(failed.store),
		worker: async () => { failedCalls += 1; throw new Error('worker unavailable'); },
	});
	try {
		const settled = await failing.execute(failed.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'failed');
		assert.equal(settled.workerRun?.evidence.status, 'failed');
		assert.equal(failedCalls, 1);
		assert.equal((await failing.execute(failed.integrationAttemptId, ownerId)).status, 'failed');
		assert.equal(failedCalls, 1);
	} finally { failed.store.close(); }

	const ambiguous = fixture();
	await passingPreparation(ambiguous.store).run(ambiguous.integrationAttemptId, ownerId);
	await new IntegrationPreflightService(ambiguous.store).run(ambiguous.integrationAttemptId, ownerId);
	let retryCalls = 0;
	const inFlight = new IntegrationOrchestrationService(ambiguous.store, {
		preparation: passingPreparation(ambiguous.store),
		worker: async () => { retryCalls += 1; throw new Error('must not retry'); },
	});
	try {
		assert.equal((await inFlight.execute(ambiguous.integrationAttemptId, ownerId)).status, 'running');
		assert.equal(retryCalls, 0);
		const recovery = new IntegrationOrchestrationService(ambiguous.store, {
			preparation: passingPreparation(ambiguous.store),
			worker: async () => { retryCalls += 1; throw new Error('must not retry'); },
			now: () => new Date(Date.now() + 22 * 60_000),
		});
		const settled = await recovery.execute(ambiguous.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'failed');
		assert.equal(retryCalls, 0);
		assert.match(settled.workerRun?.evidence.status === 'failed' ? settled.workerRun.evidence.detail : '', /expired.*retry is forbidden/);
	} finally { ambiguous.store.close(); }
});

test('blocks a worker scope escape before running repository gates', async () => {
	const value = fixture();
	const gateCalls: string[] = [];
	const service = new IntegrationOrchestrationService(value.store, {
		preparation: passingPreparation(value.store),
		gates: passingGates(value.store, gateCalls),
		worker: async (input) => {
			writeFileSync(join(input.workspacePath, 'outside.ts'), 'export const escaped = true;\n');
			return {
				conversationId: 'integration-conversation', submissionId: 'integration-submission',
				result: { disposition: 'changed', summary: 'Escaped scope.', changedPaths: ['outside.ts'], testsRun: [], notes: [] },
				text: 'Escaped scope.',
			};
		},
	});
	try {
		const settled = await service.execute(value.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.ok(settled.outcome?.violations.includes('scope_violation'));
		assert.deepEqual(gateCalls, []);
	} finally { value.store.close(); }
});

test('blocks terminal success when a declared non-mutating gate changes the final patch', async () => {
	const value = fixture();
	let gateCalls = 0;
	const gates = new IntegrationGateService(value.store, async (_command, context) => {
		gateCalls += 1;
		if (gateCalls === 1) writeFileSync(join(context.workspacePath, 'src', 'integration', 'result.ts'), 'export const integrated = false;\n');
		return { status: 'passed', exitCode: 0, durationMs: 1, stdout: 'ok', stderr: '', truncated: false };
	});
	const service = new IntegrationOrchestrationService(value.store, {
		preparation: passingPreparation(value.store), gates,
		worker: async (input) => {
			writeFileSync(join(input.workspacePath, 'src', 'integration', 'result.ts'), 'export const integrated = true;\n');
			return {
				conversationId: 'integration-conversation', submissionId: 'integration-submission',
				result: { disposition: 'changed', summary: 'Integrated API.', changedPaths: ['src/integration/result.ts'], testsRun: [], notes: [] },
				text: 'Integrated API.',
			};
		},
	});
	try {
		const settled = await service.execute(value.integrationAttemptId, ownerId);
		assert.equal(settled.status, 'blocked');
		assert.equal(gateCalls, 2);
		assert.deepEqual(settled.gateResults?.map(({ status }) => status), ['passed', 'passed']);
		assert.equal(settled.finalIntegrity?.result.status, 'blocked');
		assert.deepEqual(settled.finalIntegrity?.result.violations, ['final_patch_changed']);
	} finally { value.store.close(); }
});
