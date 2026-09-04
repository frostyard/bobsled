import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { OrganizationCapacityPolicyConflictError, OrganizationCapacityPolicyIntegrityError, OrganizationCapacityPolicyStore } from '../src/control-plane/organization-capacity-policy-store.ts';

const policy = { maxActiveWorkflows: 4, providerConcurrentCalls: { openaiCodex: 2, githubCopilot: 1 } };

test('records versioned organization capacity policy without activating enforcement', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-capacity-policy-')), path = join(root, 'bobsled.db');
	const first = new OrganizationCapacityPolicyStore(path, () => new Date('2026-09-04T20:00:00.000Z'));
	try {
		assert.equal(first.current(), undefined);
		const recorded = first.record({ policy, expectedVersion: 0, reason: 'Bound concurrent subscription use' }, { id: 'operator' }, 'capacity-1');
		assert.deepEqual(recorded.policy, policy); assert.equal(recorded.version, 1);
		assert.deepEqual(first.record({ policy, expectedVersion: 0, reason: 'Bound concurrent subscription use' }, { id: 'operator' }, 'capacity-1'), recorded);
		assert.throws(() => first.record({ policy: { ...policy, maxActiveWorkflows: 5 }, expectedVersion: 1, reason: 'Changed input' }, { id: 'operator' }, 'capacity-1'), OrganizationCapacityPolicyConflictError);
	} finally { first.close(); }
	const reopened = new OrganizationCapacityPolicyStore(path);
	try { assert.equal(reopened.current()?.version, 1); assert.equal(reopened.history().length, 1); }
	finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test('serializes competing updates and rejects retained policy tampering', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-capacity-policy-race-')), path = join(root, 'bobsled.db');
	const left = new OrganizationCapacityPolicyStore(path), right = new OrganizationCapacityPolicyStore(path);
	try {
		left.record({ policy, expectedVersion: 0, reason: 'Initial policy' }, { id: 'operator' }, 'initial');
		right.record({ policy: { ...policy, maxActiveWorkflows: 5 }, expectedVersion: 1, reason: 'First update' }, { id: 'operator' }, 'left');
		assert.throws(() => left.record({ policy: { ...policy, maxActiveWorkflows: 6 }, expectedVersion: 1, reason: 'Competing update' }, { id: 'operator' }, 'right'), OrganizationCapacityPolicyConflictError);
		const tamper = new Database(path); tamper.prepare("UPDATE organization_capacity_policy_events SET actor_id='intruder' WHERE version=2").run(); tamper.close();
		assert.throws(() => right.current(), OrganizationCapacityPolicyIntegrityError);
		const secondTamper = new Database(path); secondTamper.prepare('UPDATE organization_capacity_policy_events SET actor_id=?,policy_json=? WHERE version=2').run('operator',JSON.stringify(policy)); secondTamper.close();
		assert.throws(() => right.current(), OrganizationCapacityPolicyIntegrityError);
	} finally { left.close(); right.close(); rmSync(root, { recursive: true, force: true }); }
});
