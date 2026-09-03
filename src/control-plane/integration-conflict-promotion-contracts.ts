import * as v from 'valibot';
import { IntegrationWorkspaceResultSchema } from './integration-workspace-service.ts';
import { IntegrationWorkspaceInspectionSchema } from './integration-preflight-contracts.ts';

const PromotionEntries = {
	assemblyId: v.pipe(v.string(), v.uuid()),
	resolutionId: v.pipe(v.string(), v.uuid()),
	modelCalls: v.literal(0),
	workerAuthorized: v.literal(false),
};

export const IntegrationConflictPromotionResultSchema = v.variant('status', [
	v.object({
		...PromotionEntries,
		status: v.literal('promoted'),
		inspection: IntegrationWorkspaceInspectionSchema,
		assembly: IntegrationWorkspaceResultSchema,
	}),
	v.object({
		...PromotionEntries,
		status: v.literal('blocked'),
		inspection: v.optional(IntegrationWorkspaceInspectionSchema),
		violations: v.pipe(v.array(v.picklist([
			'inspection_failed', 'head_moved', 'index_changed', 'dirty_worktree',
		])), v.minLength(1), v.maxLength(4)),
		detail: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
	}),
]);

export type IntegrationConflictPromotionResult = v.InferOutput<typeof IntegrationConflictPromotionResultSchema>;
