import * as v from 'valibot';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const GitObjectIdSchema = v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const BoundedPathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(500));

export const IntegrationWorkspaceInspectionSchema = v.object({
	headCommit: GitObjectIdSchema,
	stagedPatchSha256: Sha256Schema,
	dirtyPaths: v.pipe(v.array(BoundedPathSchema), v.maxLength(100)),
});

export const IntegrationPreflightViolationSchema = v.picklist([
	'parent_unavailable',
	'inspection_failed',
	'head_moved',
	'index_changed',
	'dirty_worktree',
]);

export const IntegrationPreflightResultSchema = v.pipe(
	v.object({
		integrationAttemptId: v.pipe(v.string(), v.uuid()),
		status: v.picklist(['passed', 'blocked']),
		inspection: v.optional(IntegrationWorkspaceInspectionSchema),
		violations: v.pipe(v.array(IntegrationPreflightViolationSchema), v.minLength(0), v.maxLength(5)),
		detail: v.pipe(v.string(), v.maxLength(10_000)),
		workerAuthorized: v.boolean(),
	}),
	v.check((result) => result.status === (result.violations.length === 0 ? 'passed' : 'blocked'), 'Preflight status must agree with violations'),
	v.check((result) => result.workerAuthorized === (result.status === 'passed'), 'Only passing preflight evidence can authorize the reserved worker'),
	v.check((result) => result.status === 'blocked' || result.inspection !== undefined, 'Passing preflight evidence requires a workspace inspection'),
);

export type IntegrationWorkspaceInspection = v.InferOutput<typeof IntegrationWorkspaceInspectionSchema>;
export type IntegrationPreflightResult = v.InferOutput<typeof IntegrationPreflightResultSchema>;

export function evaluateIntegrationPreflight(
	integrationAttemptId: string,
	expectedBaseCommit: string,
	expectedStagedPatchSha256: string,
	inputInspection: IntegrationWorkspaceInspection,
): IntegrationPreflightResult {
	const inspection = v.parse(IntegrationWorkspaceInspectionSchema, inputInspection);
	const violations: IntegrationPreflightResult['violations'] = [];
	if (inspection.headCommit !== expectedBaseCommit) violations.push('head_moved');
	if (inspection.stagedPatchSha256 !== expectedStagedPatchSha256) violations.push('index_changed');
	if (inspection.dirtyPaths.length > 0) violations.push('dirty_worktree');
	return v.parse(IntegrationPreflightResultSchema, {
		integrationAttemptId,
		status: violations.length === 0 ? 'passed' : 'blocked',
		inspection,
		violations,
		detail: violations.length === 0 ? 'Workspace matches its durable assembly evidence' : 'Workspace no longer matches its clean assembled state',
		workerAuthorized: violations.length === 0,
	});
}
