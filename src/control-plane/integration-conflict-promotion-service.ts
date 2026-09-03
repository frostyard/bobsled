import * as v from 'valibot';
import {
	IntegrationConflictPromotionResultSchema,
	type IntegrationConflictPromotionResult,
} from './integration-conflict-promotion-contracts.ts';
import {
	MultiWorkerParentStore,
	type IntegrationConflictResolutionParent,
} from './multi-worker-parent-store.ts';
import {
	inspectIntegrationWorkspace,
	type IntegrationWorkspaceInspector,
} from './integration-preflight-service.ts';

export interface IntegrationConflictPromotionOptions {
	inspector?: IntegrationWorkspaceInspector;
}

export class IntegrationConflictPromotionError extends Error {}

export class IntegrationConflictPromotionService {
	readonly #inspector: IntegrationWorkspaceInspector;

	constructor(private readonly store: MultiWorkerParentStore, options: IntegrationConflictPromotionOptions = {}) {
		this.#inspector = options.inspector ?? inspectIntegrationWorkspace;
	}

	async promote(assemblyId: string, resolutionId: string, ownerId: string, idempotencyKey: string) {
		const resolution = this.store.getConflictResolution(resolutionId, ownerId);
		if (resolution.status !== 'resolved' || resolution.result.status !== 'resolved') {
			throw new IntegrationConflictPromotionError('Only resolved conflict evidence can be promoted');
		}
		let result: IntegrationConflictPromotionResult;
		try {
			const inspection = await this.#inspector(resolution.result.workspacePath);
			result = evaluatePromotion(assemblyId, resolution, inspection);
		} catch (error) {
			result = v.parse(IntegrationConflictPromotionResultSchema, {
				assemblyId, resolutionId, status: 'blocked', modelCalls: 0, workerAuthorized: false,
				violations: ['inspection_failed'],
				detail: (error instanceof Error ? error.message : 'Resolved workspace inspection failed').slice(0, 10_000),
			});
		}
		return this.store.recordConflictPromotion({ assemblyId, resolutionId, result }, ownerId, idempotencyKey);
	}
}

function evaluatePromotion(
	assemblyId: string,
	resolution: IntegrationConflictResolutionParent,
	inspection: Awaited<ReturnType<IntegrationWorkspaceInspector>>,
): IntegrationConflictPromotionResult {
	if (resolution.result.status !== 'resolved') throw new IntegrationConflictPromotionError('Resolution is not promotable');
	const violations: Array<'head_moved' | 'index_changed' | 'dirty_worktree'> = [];
	if (inspection.headCommit !== resolution.result.baseCommit) violations.push('head_moved');
	if (inspection.stagedPatchSha256 !== resolution.result.patchSha256) violations.push('index_changed');
	if (inspection.dirtyPaths.length > 0) violations.push('dirty_worktree');
	if (violations.length > 0) return v.parse(IntegrationConflictPromotionResultSchema, {
		assemblyId, resolutionId: resolution.resolutionId, status: 'blocked', inspection, violations,
		detail: 'Resolved workspace no longer matches its immutable conflict-resolution evidence',
		modelCalls: 0, workerAuthorized: false,
	});
	return v.parse(IntegrationConflictPromotionResultSchema, {
		assemblyId, resolutionId: resolution.resolutionId, status: 'promoted', inspection,
		modelCalls: 0, workerAuthorized: false,
		assembly: {
			assemblyId, taskId: resolution.result.taskId, baseCommit: resolution.result.baseCommit,
			workspacePath: resolution.result.workspacePath, appliedTaskIds: resolution.result.appliedTaskIds,
			changedPaths: resolution.result.changedPaths, workerAuthorized: false,
			status: 'assembled', patchSha256: resolution.result.patchSha256,
		},
	});
}
