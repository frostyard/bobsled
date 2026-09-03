import { resolve } from 'node:path';
import * as v from 'valibot';
import { GateResultSchema, type GateResult } from './execution-contracts.ts';
import { IntegrationInvocationStore, type IntegrationInvocationLease } from './integration-invocation-store.ts';
import {
	evaluateIntegrationFinalIntegrity,
	failedIntegrationFinalIntegrity,
} from './integration-final-integrity.ts';
import {
	inspectIntegrationWorkerWorkspace,
	type IntegrationWorkerInspector,
} from './integration-workspace-inspection.ts';
import {
	IntegrationCommandContextSchema,
	runIntegrationCommand,
	type IntegrationCommandContext,
	type IntegrationCommandRunner,
} from './integration-command-service.ts';

export { runIntegrationCommand } from './integration-command-service.ts';
export const IntegrationGateContextSchema = IntegrationCommandContextSchema;
export type IntegrationGateContext = IntegrationCommandContext;
export type IntegrationGateCommandRunner = IntegrationCommandRunner;

const MAX_OUTPUT_BYTES = 512 * 1024;

function failedEvidence(id: string, name: string, command: string, message: string): GateResult {
	return v.parse(GateResultSchema, {
		id, name, command, status: 'failed', exitCode: null, durationMs: 0,
		stdout: '', stderr: message.slice(0, MAX_OUTPUT_BYTES), truncated: message.length > MAX_OUTPUT_BYTES,
	});
}

export class IntegrationGateService {
	readonly #store: IntegrationInvocationStore;
	readonly #runner: IntegrationGateCommandRunner;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;
	readonly #inspector: IntegrationWorkerInspector;

	constructor(store: IntegrationInvocationStore, runner: IntegrationGateCommandRunner = runIntegrationCommand, options: {
		toolDataRoot?: string;
		executablePath?: string;
		inspector?: IntegrationWorkerInspector;
	} = {}) {
		this.#store = store;
		this.#runner = runner;
		this.#toolDataRoot = resolve(options.toolDataRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces', 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#inspector = options.inspector ?? inspectIntegrationWorkerWorkspace;
	}

	async run(integrationAttemptId: string, ownerId: string): Promise<IntegrationInvocationLease> {
		const lease = this.#store.get(integrationAttemptId, ownerId);
		if (lease.status !== 'awaiting_gates') throw new Error('Integration invocation is not awaiting trusted gates');
		let parent;
		try {
			parent = this.#store.getParentContext(integrationAttemptId, ownerId);
		} catch (error) {
			return this.#store.settleGates(integrationAttemptId, ownerId, [failedEvidence(
				'policy', 'Integration gate parent', '[unavailable]',
				error instanceof Error ? error.message : 'Integration gate parent could not be loaded',
			)], failedIntegrationFinalIntegrity(error));
		}
		const context = v.parse(IntegrationGateContextSchema, {
			integrationAttemptId, workspacePath: parent.workspacePath,
			sandboxHomePath: resolve(parent.workspacePath, '..', 'gate-home'),
			toolDataPath: resolve(this.#toolDataRoot, parent.repository.id.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath, repository: parent.repository,
		});
		const gateById = new Map(context.repository.qualityGates.map((gate) => [gate.id, gate]));
		const results: GateResult[] = [];
		for (const id of context.repository.executionPolicy.requiredGateIds) {
			const gate = gateById.get(id);
			if (!gate) {
				results.push(failedEvidence(id, 'Missing required gate', '[missing]', `Required integration gate is missing from the policy snapshot: ${id}`));
				break;
			}
			if (gate.mutatesWorkspace) {
				results.push(failedEvidence(gate.id, gate.name, gate.command,
					'Workspace-mutating integration gates are unsupported until trusted patch evidence is recomputed after gate execution'));
				break;
			}
			const result = await this.#runner(gate.command, context, context.repository.executionPolicy.gateTimeoutMinutes * 60_000).catch((error) => ({
				status: 'failed' as const, exitCode: null, durationMs: 0, stdout: '',
				stderr: (error instanceof Error ? error.message : 'Gate runner failed').slice(0, MAX_OUTPUT_BYTES), truncated: false,
			}));
			results.push(v.parse(GateResultSchema, { ...result, id: gate.id, name: gate.name, command: gate.command }));
			if (result.status !== 'passed') break;
		}
		if (results.length === 0) results.push(failedEvidence(
			'policy', 'Required gate policy', '[missing]', 'Integration policy must require at least one trusted gate',
		));
		const leaseAfterGates = this.#store.get(context.integrationAttemptId, ownerId);
		let integrity;
		try {
			const inspection = await this.#inspector(context.workspacePath);
			if (!leaseAfterGates.outcome) throw new Error('Successful worker disposition is unavailable');
			integrity = evaluateIntegrationFinalIntegrity({
				baseCommit: parent.baseCommit,
				assemblyPatchSha256: parent.assemblyPatchSha256,
				assemblyChangedPaths: parent.assemblyChangedPaths,
				repository: parent.repository,
				outcome: leaseAfterGates.outcome,
			}, inspection);
		} catch (error) {
			integrity = failedIntegrationFinalIntegrity(error);
		}
		return this.#store.settleGates(context.integrationAttemptId, ownerId, results, integrity);
	}
}
