import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubRepositoryEnrollmentGateway, RepositoryEnrollmentService, RepositoryEnrollmentPolicyError, type RepositoryEnrollmentGateway } from '../src/control-plane/repository-enrollment-service.ts';
import { RepositoryEnrollmentStore } from '../src/control-plane/repository-enrollment-store.ts';
import { getRepository } from '../src/control-plane/repositories.ts';

const source = getRepository('frostyard/frostyard-org')!;
const candidate = { id: 24680, name: 'satellite', full_name: 'frostyard/satellite', description: 'A satellite application', default_branch: 'main', archived: false, disabled: false };
const { id: _id, githubRepositoryId: _githubId, displayName: _display, description: _description, defaultBranch: _branch, enabled: _enabled, ...policy } = source;
const declaration = { version: 1 as const, ...policy };

function gateway(policyDocument: unknown = declaration): RepositoryEnrollmentGateway {
	return { list: async () => [candidate], get: async () => candidate, policy: async () => policyDocument };
}

test('discovers installed repositories without enrolling them', async () => {
	const store = new RepositoryEnrollmentStore(':memory:');
	const service = new RepositoryEnrollmentService(store, gateway(), () => []);
	assert.deepEqual(await service.discover(), [{ id: 'frostyard/satellite', displayName: 'satellite', description: 'A satellite application', defaultBranch: 'main', archived: false, disabled: false, enrollmentVersion: undefined, enrolled: false, enabled: false }]);
	assert.equal(store.list().length, 0);
	store.close();
});

test('enrolls a GitHub-identified repository from its versioned policy and can disable it', async () => {
	const store = new RepositoryEnrollmentStore(':memory:');
	let refreshes = 0;
	const service = new RepositoryEnrollmentService(store, gateway(), () => { refreshes += 1; return []; });
	const enrolled = await service.enroll({ repositoryId: candidate.full_name, expectedVersion: 0, reason: 'Enroll the reviewed satellite policy' }, { id: 'github:1' }, 'enroll-satellite');
	assert.equal(store.get(candidate.full_name)?.repository.githubRepositoryId, candidate.id);
	assert.equal(enrolled.repository.defaultBranch, candidate.default_branch);
	assert.equal(enrolled.repository.publicationPolicy.enabled, source.publicationPolicy.enabled);
	assert.equal(enrolled.version, 1);
	assert.equal(refreshes, 1);
	const [listed] = service.list();
	assert.equal('githubRepositoryId' in listed.repository, false);
	assert.equal('actorId' in listed, false);
	assert.equal('reason' in listed, false);
	const disabled = service.disable({ repositoryId: candidate.full_name, expectedVersion: 1, reason: 'Pause new satellite work' }, { id: 'github:1' }, 'disable-satellite');
	assert.equal(disabled.repository.enabled, false);
	assert.equal(disabled.version, 2);
	const reenabled = await service.enroll({ repositoryId: candidate.full_name, expectedVersion: 2, reason: 'Resume under the current repository policy' }, { id: 'github:1' }, 'enable-satellite');
	assert.equal(reenabled.repository.enabled, true);
	assert.equal(reenabled.version, 3);
	assert.equal(refreshes, 3);
	store.close();
});

test('rejects invalid, unreadable, or non-canonical repository policy', async () => {
	for (const [gatewayValue, expected] of [
		[gateway({ version: 1 }), /Invalid/],
		[gateway({ ...declaration, capabilities: { ...declaration.capabilities, read: false } }), /bounded reads/],
		[gateway({ ...declaration, executionPolicy: { ...declaration.executionPolicy, requiredGateIds: ['missing'] } }), /required execution gate/],
	] as const) {
		const store = new RepositoryEnrollmentStore(':memory:');
		const service = new RepositoryEnrollmentService(store, gatewayValue, () => []);
		await assert.rejects(() => service.enroll({ repositoryId: candidate.full_name, expectedVersion: 0, reason: 'Invalid enrollment' }, { id: 'github:1' }, 'invalid'), expected);
		store.close();
	}
	const store = new RepositoryEnrollmentStore(':memory:');
	const mismatch = new RepositoryEnrollmentService(store, { ...gateway(), get: async () => ({ ...candidate, full_name: 'frostyard/renamed' }) }, () => []);
	await assert.rejects(() => mismatch.enroll({ repositoryId: candidate.full_name, expectedVersion: 0, reason: 'Stale name' }, { id: 'github:1' }, 'mismatch'), RepositoryEnrollmentPolicyError);
	store.close();
});

test('rejects policy bytes that do not match GitHub content metadata', async () => {
	const github = new GitHubRepositoryEnrollmentGateway({
		withCandidateRequest: async (_name: string, _id: number, _capability: string, use: (authority: { request: () => Promise<Response> }) => Promise<unknown>) =>
			use({ request: async () => Response.json({ type: 'file', encoding: 'base64', size: 99, content: Buffer.from('{}').toString('base64') }) }),
	} as never);
	await assert.rejects(() => github.policy(candidate), /size does not match/);
});
