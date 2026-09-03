import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import {
	RepositoryContractSchema,
	RepositoryPolicySnapshotSchema,
	WorkerNetworkPolicySchema,
} from '../src/control-plane/contracts.ts';
import { repositories } from '../src/control-plane/repositories.ts';
import { workerNetworkInstruction } from '../src/control-plane/worker-network-policy.ts';

test('worker network policy has explicit denied and public-dependency modes', () => {
	assert.match(workerNetworkInstruction({ mode: 'none' }), /Do not use the network/);
	const dependencyAccess = workerNetworkInstruction({ mode: 'public_dependencies' });
	assert.match(dependencyAccess, /credential-free package or module tooling/);
	assert.match(dependencyAccess, /Do not use general-purpose network clients/);
	assert.match(dependencyAccess, /fetch or pull repository remotes/);
	assert.throws(() => v.parse(WorkerNetworkPolicySchema, { mode: 'unrestricted' }));
});

test('clix explicitly permits public dependency resolution', () => {
	assert.equal(repositories[0]?.executionPolicy.workerNetwork.mode, 'public_dependencies');
});

test('the public website permits dependency preparation without worker credentials', () => {
	const website = repositories.find(({ id }) => id === 'frostyard/frostyard-org');
	assert.equal(website?.executionPolicy.workerNetwork.mode, 'public_dependencies');
	assert.equal(website?.publicationPolicy.draftPullRequestsOnly, true);
	assert.equal(website?.capabilities.merge, false);
});

test('historical snapshots without worker network policy stay readable but cannot become executable', () => {
	const historical = structuredClone(repositories[0]) as Record<string, unknown>;
	const executionPolicy = historical.executionPolicy as Record<string, unknown>;
	delete executionPolicy.workerNetwork;
	assert.equal(v.safeParse(RepositoryPolicySnapshotSchema, historical).success, true);
	assert.equal(v.safeParse(RepositoryContractSchema, historical).success, false);
});
