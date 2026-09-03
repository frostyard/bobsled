import { resolve } from 'node:path';
import * as v from 'valibot';
import { PreparationResultSchema } from './execution-contracts.ts';
import {
	IntegrationCommandContextSchema,
	runIntegrationCommand,
	type IntegrationCommandRunner,
} from './integration-command-service.ts';
import { IntegrationInvocationStore, type IntegrationInvocationLease } from './integration-invocation-store.ts';

export interface IntegrationPreparationOptions {
	runner?: IntegrationCommandRunner;
	toolDataRoot?: string;
	executablePath?: string;
	now?: () => Date;
}

export class IntegrationPreparationService {
	readonly #runner: IntegrationCommandRunner;
	readonly #toolDataRoot: string;
	readonly #executablePath: string;
	readonly #now: () => Date;

	constructor(private readonly store: IntegrationInvocationStore, options: IntegrationPreparationOptions = {}) {
		this.#runner = options.runner ?? runIntegrationCommand;
		this.#toolDataRoot = resolve(options.toolDataRoot ?? process.env.BOBSLED_WORKSPACE_DIR ?? './data/workspaces', 'tool-cache');
		this.#executablePath = options.executablePath ?? `${resolve(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
		this.#now = options.now ?? (() => new Date());
	}

	async run(integrationAttemptId: string, ownerId: string): Promise<IntegrationInvocationLease> {
		let parent;
		try {
			parent = this.store.getParentContext(integrationAttemptId, ownerId);
		} catch (error) {
			const lease = this.store.get(integrationAttemptId, ownerId);
			if (lease.status !== 'preparing') this.store.claimPreparation(integrationAttemptId, ownerId);
			return this.store.completePreparation(integrationAttemptId, ownerId, v.parse(PreparationResultSchema, {
				name: 'Repository preparation', command: '[unavailable]', networkAccess: false,
				status: 'failed', exitCode: null, durationMs: 0, stdout: '',
				stderr: (error instanceof Error ? error.message : 'Integration preparation parent could not be loaded').slice(0, 512 * 1024),
				truncated: false,
			}));
		}
		const claim = this.store.claimPreparation(integrationAttemptId, ownerId);
		if (!claim.newlyClaimed) {
			if (claim.lease.status !== 'preparing') return claim.lease;
			const startedAt = claim.lease.startedAt ? Date.parse(claim.lease.startedAt) : Number.NaN;
			const timeoutMs = (parent.repository.workspacePreparation.timeoutMinutes + 1) * 60_000;
			if (Number.isFinite(startedAt) && this.#now().getTime() - startedAt <= timeoutMs) return claim.lease;
			return this.store.completePreparation(integrationAttemptId, ownerId, v.parse(PreparationResultSchema, {
				name: parent.repository.workspacePreparation.name,
				command: parent.repository.workspacePreparation.command,
				networkAccess: parent.repository.workspacePreparation.networkAccess,
				status: 'failed', exitCode: null, durationMs: 0, stdout: '',
				stderr: 'Preparation recovery found an expired ambiguous command; retry is forbidden', truncated: false,
			}));
		}
		const preparation = parent.repository.workspacePreparation;
		const context = v.parse(IntegrationCommandContextSchema, {
			integrationAttemptId, workspacePath: parent.workspacePath,
			sandboxHomePath: resolve(parent.workspacePath, '..', 'preparation-home'),
			toolDataPath: resolve(this.#toolDataRoot, parent.repository.id.replace('/', '__'), 'mise'),
			executablePath: this.#executablePath, repository: parent.repository,
		});
		const result = await this.#runner(preparation.command, context, preparation.timeoutMinutes * 60_000).catch((error) => ({
			status: 'failed' as const, exitCode: null, durationMs: 0, stdout: '',
			stderr: (error instanceof Error ? error.message : 'Preparation runner failed').slice(0, 512 * 1024), truncated: false,
		}));
		return this.store.completePreparation(integrationAttemptId, ownerId, v.parse(PreparationResultSchema, {
			...result, name: preparation.name, command: preparation.command, networkAccess: preparation.networkAccess,
		}));
	}
}
