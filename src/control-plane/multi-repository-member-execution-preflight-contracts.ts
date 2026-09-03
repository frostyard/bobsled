import * as v from 'valibot';

const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const BoundedPathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(500));

export const MultiRepositoryMemberExecutionWorkspaceInspectionSchema = v.object({
	headCommit: GitObjectIdSchema,
	dirtyPaths: v.pipe(v.array(BoundedPathSchema), v.maxLength(100)),
});

export const MultiRepositoryMemberExecutionPreflightViolationSchema = v.picklist([
	'parent_unavailable',
	'inspection_failed',
	'head_moved',
	'dirty_worktree',
]);

export const MultiRepositoryMemberExecutionPreflightResultSchema = v.pipe(
	v.object({
		reservationId: v.pipe(v.string(), v.uuid()),
		status: v.picklist(['passed', 'blocked']),
		inspection: v.optional(MultiRepositoryMemberExecutionWorkspaceInspectionSchema),
		violations: v.pipe(v.array(MultiRepositoryMemberExecutionPreflightViolationSchema), v.maxLength(4)),
		detail: v.pipe(v.string(), v.maxLength(10_000)),
		modelDispatchClaimed: v.literal(false),
	}),
	v.check((result) => result.status === (result.violations.length === 0 ? 'passed' : 'blocked'), 'Preflight status must agree with violations'),
	v.check((result) => result.status === 'blocked' || result.inspection !== undefined, 'Passing preflight evidence requires an inspection'),
);

export type MultiRepositoryMemberExecutionWorkspaceInspection = v.InferOutput<typeof MultiRepositoryMemberExecutionWorkspaceInspectionSchema>;
export type MultiRepositoryMemberExecutionPreflightResult = v.InferOutput<typeof MultiRepositoryMemberExecutionPreflightResultSchema>;

export function evaluateMultiRepositoryMemberExecutionPreflight(
	reservationId: string,
	expectedBaseCommit: string,
	input: MultiRepositoryMemberExecutionWorkspaceInspection,
): MultiRepositoryMemberExecutionPreflightResult {
	const inspection = v.parse(MultiRepositoryMemberExecutionWorkspaceInspectionSchema, input);
	const violations: MultiRepositoryMemberExecutionPreflightResult['violations'] = [];
	if (inspection.headCommit !== expectedBaseCommit) violations.push('head_moved');
	if (inspection.dirtyPaths.length > 0) violations.push('dirty_worktree');
	return v.parse(MultiRepositoryMemberExecutionPreflightResultSchema, {
		reservationId, status: violations.length === 0 ? 'passed' : 'blocked', inspection, violations,
		detail: violations.length === 0
			? 'Prepared member workspace still matches its immutable clean base'
			: 'Prepared member workspace changed after preparation',
		modelDispatchClaimed: false,
	});
}
