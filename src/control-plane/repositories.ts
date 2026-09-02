import * as v from 'valibot';
import { RepositoryContractSchema, type RepositoryContract } from './contracts.ts';

const enrolled = [
	{
		id: 'frostyard/clix',
		githubRepositoryId: 1172846628,
		displayName: 'clix',
		description: 'CLI convenience module for Frostyard tools',
		defaultBranch: 'main',
		enabled: true,
		readOnly: true,
		agentSurfaces: [
			'AGENTS.md',
			'.agents/skills/',
			'.github/prompts/issue-triage.prompt.md',
			'docs/README.md',
			'policies/agent-governance.json',
		],
		qualityGates: [
			{ id: 'verify', name: 'Credential-free verification', command: 'make verify', kind: 'fast', mutatesWorkspace: false },
			{ id: 'check', name: 'Pre-commit quality gate', command: 'make check', kind: 'full', mutatesWorkspace: true },
			{ id: 'ci', name: 'CI-equivalent gate', command: 'make ci', kind: 'ci', mutatesWorkspace: true },
			{ id: 'docs', name: 'Documentation integrity', command: 'node scripts/check-docs.mjs', kind: 'full', mutatesWorkspace: false },
		],
		protectedBoundaries: [
			{
				id: 'workflow-and-permissions',
				paths: ['.github/workflows/**'],
				minimumRisk: 'high',
				requiresHumanReview: true,
			},
			{
				id: 'release-and-publication',
				paths: ['.goreleaser.yaml', '.svu.yaml', '.github/workflows/release.yml'],
				minimumRisk: 'high',
				requiresHumanReview: true,
			},
		],
		capabilities: {
			read: true,
			triage: true,
			writeCode: true,
			writeGitHub: false,
			merge: false,
		},
		multiRepo: { coordinateWith: [] },
		executionPolicy: {
			enabled: true,
			maxFiles: 8,
			maxDiffLines: 500,
			requiredGateIds: ['docs', 'verify'],
			workerTimeoutMinutes: 20,
			gateTimeoutMinutes: 15,
			workerNetwork: { mode: 'public_dependencies' },
		},
		reviewPolicy: {
			enabled: true,
			maxRemediationRounds: 1,
			reviewerTimeoutMinutes: 15,
			remediationTimeoutMinutes: 20,
		},
		publicationPolicy: {
			enabled: false,
			branchPrefix: 'bobsled/',
			draftPullRequestsOnly: true,
			allowForcePush: false,
			requiredCheckNames: ['verify'],
			maxAttempts: 3,
			maxTotalBlobBytes: 5 * 1024 * 1024,
		},
		workspacePreparation: {
			name: 'Install repository-pinned tools',
			command: 'mise install',
			timeoutMinutes: 15,
			networkAccess: true,
		},
	},
	{
		id: 'frostyard/bobsled',
		githubRepositoryId: 1355051288,
		displayName: 'bobsled',
		description: 'Frostyard software factory control plane',
		defaultBranch: 'main',
		enabled: true,
		readOnly: false,
		agentSurfaces: ['AGENTS.md', 'README.md', 'docs/'],
		qualityGates: [
			{ id: 'test', name: 'Deterministic tests', command: 'npm test', kind: 'full', mutatesWorkspace: false },
			{ id: 'types', name: 'TypeScript validation', command: 'npm run check:types', kind: 'fast', mutatesWorkspace: false },
			{ id: 'build', name: 'Production build', command: 'npm run build', kind: 'ci', mutatesWorkspace: false },
		],
		protectedBoundaries: [],
		capabilities: {
			read: true,
			triage: true,
			writeCode: false,
			writeGitHub: true,
			merge: false,
		},
		multiRepo: { coordinateWith: [] },
		executionPolicy: {
			enabled: false,
			maxFiles: 8,
			maxDiffLines: 500,
			requiredGateIds: ['test', 'types', 'build'],
			workerTimeoutMinutes: 20,
			gateTimeoutMinutes: 15,
			workerNetwork: { mode: 'none' },
		},
		reviewPolicy: {
			enabled: false,
			maxRemediationRounds: 0,
			reviewerTimeoutMinutes: 15,
			remediationTimeoutMinutes: 20,
		},
		publicationPolicy: {
			enabled: false,
			branchPrefix: 'bobsled/',
			draftPullRequestsOnly: true,
			allowForcePush: false,
			requiredCheckNames: ['Node 22.19.0', 'Node 24.x', 'Secret scan'],
			maxAttempts: 3,
			maxTotalBlobBytes: 5 * 1024 * 1024,
		},
		workspacePreparation: {
			name: 'Install locked dependencies',
			command: 'npm ci',
			timeoutMinutes: 15,
			networkAccess: true,
		},
	},
] satisfies unknown[];

export const repositories: readonly RepositoryContract[] = enrolled.map((entry) =>
	v.parse(RepositoryContractSchema, entry),
);

export function getRepository(id: string): RepositoryContract | undefined {
	return repositories.find((repository) => repository.id === id && repository.enabled);
}
