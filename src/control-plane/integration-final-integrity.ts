import * as v from 'valibot';
import { RepositoryContractSchema } from './contracts.ts';
import {
	IntegrationWorkerDispositionSchema,
	IntegrationWorkerInspectionSchema,
	type IntegrationWorkerDisposition,
	type IntegrationWorkerInspection,
} from './integration-worker-contracts.ts';

const IntegrityViolationSchema = v.picklist([
	'inspection_failed', 'head_moved', 'index_changed', 'worker_paths_changed',
	'final_paths_changed', 'final_patch_changed', 'file_limit', 'diff_limit', 'protected_path',
]);

export const IntegrationFinalIntegrityResultSchema = v.variant('status', [
	v.object({
		status: v.literal('passed'),
		inspection: IntegrationWorkerInspectionSchema,
		violations: v.pipe(v.array(IntegrityViolationSchema), v.length(0)),
		detail: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
	}),
	v.object({
		status: v.literal('blocked'),
		inspection: v.optional(IntegrationWorkerInspectionSchema),
		violations: v.pipe(v.array(IntegrityViolationSchema), v.minLength(1), v.maxLength(9)),
		detail: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000)),
	}),
]);

export type IntegrationFinalIntegrityResult = v.InferOutput<typeof IntegrationFinalIntegrityResultSchema>;

export interface IntegrationFinalIntegrityInput {
	baseCommit: string;
	assemblyPatchSha256: string;
	assemblyChangedPaths: string[];
	repository: v.InferOutput<typeof RepositoryContractSchema>;
	outcome: IntegrationWorkerDisposition;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0');
}

function protectedPath(path: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	return path === pattern;
}

export function evaluateIntegrationFinalIntegrity(
	input: IntegrationFinalIntegrityInput,
	inputInspection: IntegrationWorkerInspection,
): IntegrationFinalIntegrityResult {
	const repository = v.parse(RepositoryContractSchema, input.repository);
	const outcome = v.parse(IntegrationWorkerDispositionSchema, input.outcome);
	const inspection = v.parse(IntegrationWorkerInspectionSchema, inputInspection);
	const violations: v.InferOutput<typeof IntegrityViolationSchema>[] = [];
	if (inspection.headCommit !== input.baseCommit) violations.push('head_moved');
	if (inspection.stagedPatchSha256 !== input.assemblyPatchSha256) violations.push('index_changed');
	if (!samePaths(inspection.workerChangedPaths, outcome.workerChangedPaths)) violations.push('worker_paths_changed');
	if (!samePaths(inspection.finalChangedPaths, [...input.assemblyChangedPaths, ...outcome.workerChangedPaths])) violations.push('final_paths_changed');
	if (inspection.finalPatchSha256 !== outcome.finalPatchSha256) violations.push('final_patch_changed');
	if (inspection.finalChangedPaths.length > repository.executionPolicy.maxFiles) violations.push('file_limit');
	if (inspection.diffLines > repository.executionPolicy.maxDiffLines) violations.push('diff_limit');
	if (inspection.finalChangedPaths.some((path) => repository.protectedBoundaries.some((boundary) =>
		boundary.paths.some((pattern) => protectedPath(path, pattern)),
	))) violations.push('protected_path');
	return v.parse(IntegrationFinalIntegrityResultSchema, {
		status: violations.length === 0 ? 'passed' : 'blocked', inspection, violations,
		detail: violations.length === 0
			? 'Final patch exactly matches trusted post-worker evidence after repository gates'
			: 'Repository gates changed or invalidated the trusted final patch',
	});
}

export function failedIntegrationFinalIntegrity(error: unknown): IntegrationFinalIntegrityResult {
	return v.parse(IntegrationFinalIntegrityResultSchema, {
		status: 'blocked', violations: ['inspection_failed'],
		detail: (error instanceof Error ? error.message : 'Final workspace inspection failed').slice(0, 10_000),
	});
}
