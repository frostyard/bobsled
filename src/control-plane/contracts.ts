import * as v from 'valibot';

export const RepositoryIdSchema = v.pipe(
	v.string(),
	v.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Expected owner/repository'),
);

export const GateSchema = v.object({
	id: v.pipe(v.string(), v.minLength(1)),
	name: v.pipe(v.string(), v.minLength(1)),
	command: v.pipe(v.string(), v.minLength(1)),
	kind: v.picklist(['fast', 'full', 'ci']),
	mutatesWorkspace: v.boolean(),
});

export const ProtectedBoundarySchema = v.object({
	id: v.pipe(v.string(), v.minLength(1)),
	paths: v.array(v.pipe(v.string(), v.minLength(1))),
	minimumRisk: v.picklist(['moderate', 'high', 'critical']),
	requiresHumanReview: v.literal(true),
});

export const WorkerNetworkPolicySchema = v.object({
	mode: v.picklist(['none', 'public_dependencies']),
});

export const ExecutionPolicySchema = v.object({
	enabled: v.boolean(),
	maxFiles: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
	maxDiffLines: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20_000)),
	requiredGateIds: v.array(v.pipe(v.string(), v.minLength(1))),
	workerTimeoutMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60)),
	gateTimeoutMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60)),
	workerNetwork: WorkerNetworkPolicySchema,
});

export const MultiWorkerPolicySchema = v.object({
	enabled: v.boolean(),
	maxConcurrentWorkers: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)),
	maxWorkerAttempts: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(128)),
	maxPreDispatchRetriesPerTask: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3)),
	maxRuntimeMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 60)),
	subscriptionCalls: v.object({
		openaiCodex: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
		githubCopilot: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)),
	}),
});

const ExecutionPolicySnapshotSchema = v.object({
	...ExecutionPolicySchema.entries,
	workerNetwork: v.optional(WorkerNetworkPolicySchema),
});

export const RepositoryContractSchema = v.object({
	id: RepositoryIdSchema,
	githubRepositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	displayName: v.pipe(v.string(), v.minLength(1)),
	description: v.string(),
	defaultBranch: v.pipe(v.string(), v.minLength(1)),
	enabled: v.boolean(),
	readOnly: v.boolean(),
	agentSurfaces: v.array(v.pipe(v.string(), v.minLength(1))),
	qualityGates: v.array(GateSchema),
	protectedBoundaries: v.array(ProtectedBoundarySchema),
	capabilities: v.object({
		read: v.boolean(),
		triage: v.boolean(),
		writeCode: v.boolean(),
		writeGitHub: v.boolean(),
		merge: v.literal(false),
	}),
	multiRepo: v.object({
		coordinateWith: v.array(RepositoryIdSchema),
	}),
	executionPolicy: ExecutionPolicySchema,
	multiWorkerPolicy: MultiWorkerPolicySchema,
	reviewPolicy: v.object({
		enabled: v.boolean(),
		maxRemediationRounds: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3)),
		reviewerTimeoutMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60)),
		remediationTimeoutMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60)),
	}),
	publicationPolicy: v.object({
		enabled: v.boolean(),
		branchPrefix: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._-]+\/$/)),
		draftPullRequestsOnly: v.literal(true),
		allowForcePush: v.literal(false),
		requiredCheckNames: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), v.minLength(1), v.maxLength(50)),
		maxAttempts: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
		maxTotalBlobBytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100 * 1024 * 1024)),
	}),
	workspacePreparation: v.object({
		name: v.pipe(v.string(), v.minLength(1)),
		command: v.pipe(v.string(), v.minLength(1)),
		timeoutMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60)),
		networkAccess: v.boolean(),
	}),
});

/** Historical snapshots remain readable when later milestones add execution-only policy fields. */
export const RepositoryPolicySnapshotSchema = v.object({
	...RepositoryContractSchema.entries,
	githubRepositoryId: v.optional(RepositoryContractSchema.entries.githubRepositoryId),
	executionPolicy: v.optional(ExecutionPolicySnapshotSchema),
	multiWorkerPolicy: v.optional(MultiWorkerPolicySchema),
	reviewPolicy: v.optional(RepositoryContractSchema.entries.reviewPolicy),
	publicationPolicy: v.optional(RepositoryContractSchema.entries.publicationPolicy),
	workspacePreparation: v.optional(RepositoryContractSchema.entries.workspacePreparation),
});

export const WorkItemSchema = v.object({
	source: v.picklist(['github_issue', 'manual', 'fixture']),
	key: v.pipe(v.string(), v.minLength(1)),
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	body: v.pipe(v.string(), v.maxLength(50_000)),
	labels: v.array(v.string()),
	author: v.optional(v.string()),
	url: v.optional(v.pipe(v.string(), v.url())),
	createdAt: v.optional(v.string()),
	updatedAt: v.optional(v.string()),
});

export const TriageRouteSchema = v.picklist([
	'ready_for_agent',
	'needs_spec',
	'needs_human',
	'needs_information',
	'ignore',
]);

export const TriageLabelSchema = v.picklist([
	'bobsled:ready',
	'bobsled:needs-spec',
	'bobsled:needs-human',
	'bobsled:needs-info',
	'bobsled:ignore',
]);

const routeLabels = {
	ready_for_agent: 'bobsled:ready',
	needs_spec: 'bobsled:needs-spec',
	needs_human: 'bobsled:needs-human',
	needs_information: 'bobsled:needs-info',
	ignore: 'bobsled:ignore',
} as const;

export const TriageDecisionSchema = v.pipe(
	v.object({
		route: TriageRouteSchema,
		risk: v.picklist(['low', 'moderate', 'high', 'critical']),
		confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
		summary: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
		rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(5_000)),
		acceptanceCriteria: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
		missingInformation: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
		suggestedLabels: v.array(TriageLabelSchema),
		eligibleForOneClick: v.boolean(),
	}),
	v.check(
		(decision) => decision.suggestedLabels.length === 1 && decision.suggestedLabels[0] === routeLabels[decision.route],
		'Triage decisions must contain exactly the label matching their route',
	),
	v.check(
		(decision) => !decision.eligibleForOneClick || (
			decision.route === 'ready_for_agent' &&
			(decision.risk === 'low' || decision.risk === 'moderate') &&
			decision.missingInformation.length === 0
		),
		'One-click work must be ready, low/moderate risk, and have no missing information',
	),
);

export const TriageRequestSchema = v.object({
	repository: RepositoryContractSchema,
	workItem: WorkItemSchema,
});

export const TriageApiRequestSchema = v.object({
	repositoryId: RepositoryIdSchema,
	workItem: WorkItemSchema,
});

export type RepositoryContract = v.InferOutput<typeof RepositoryContractSchema>;
export type RepositoryPolicySnapshot = v.InferOutput<typeof RepositoryPolicySnapshotSchema>;
export type WorkerNetworkPolicy = v.InferOutput<typeof WorkerNetworkPolicySchema>;
export type WorkItem = v.InferOutput<typeof WorkItemSchema>;
export type TriageDecision = v.InferOutput<typeof TriageDecisionSchema>;
export type TriageRequest = v.InferOutput<typeof TriageRequestSchema>;
export type TriageApiRequest = v.InferOutput<typeof TriageApiRequestSchema>;
