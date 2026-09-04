import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// The application owns process-lifetime SQLite stores. Give this stateful HTTP
// integration test its own runtime so parallel test files cannot contend with
// those stores or make endpoint correctness depend on runner scheduling.
const root = mkdtempSync(join(tmpdir(), 'bobsled-archive-routes-'));
process.env.BOBSLED_AUTH_FILE = join(root, 'configuration', 'auth.json');
process.env.BOBSLED_DATA_DIR = join(root, 'data');
process.env.BOBSLED_WORKSPACE_DIR = join(root, 'workspaces');
process.env.BOBSLED_CLIX_SOURCE_PATH = join(root, 'sources', 'clix');

const { default: app } = await import('../src/app.ts');

after(() => rmSync(root, { recursive: true, force: true }));

test('archives and restores terminal runs through authenticated control-plane routes', async () => {
	const key = `archive-route-${randomUUID()}`;
	const admitted = await app.request('/api/runs', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'idempotency-key': key },
		body: JSON.stringify({
			repositoryId: 'frostyard/clix',
			workItem: { source: 'manual', key, title: 'Retire a test fixture', body: 'Keep the evidence without operator noise.', labels: [] },
			triageDecision: {
				route: 'needs_spec', risk: 'low', confidence: 0.9,
				summary: 'Fixture is intentionally blocked.', rationale: 'It exists to prove archive routing.',
				acceptanceCriteria: ['Archive it.'], missingInformation: ['No implementation is intended.'],
				suggestedLabels: ['bobsled:needs-spec'], eligibleForOneClick: false,
			},
		}),
	});
	assert.equal(admitted.status, 201);
	const run = await admitted.json() as { id: string; version: number };
	const archivedResponse = await app.request(`/api/runs/${run.id}/archive`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ expectedVersion: run.version, reason: 'Retire this route fixture.' }),
	});
	assert.equal(archivedResponse.status, 200);
	const archived = await archivedResponse.json() as { version: number; archive?: { reason: string } };
	assert.equal(archived.archive?.reason, 'Retire this route fixture.');
	const board = await (await app.request('/api/operator-board')).json() as { cards: Array<{ id: string; lane: string; phase: string }> };
	const card = board.cards.find(({ id }) => id === run.id);
	assert.equal(card?.lane, 'history');
	assert.equal(card?.phase, 'archived');

	const restoredResponse = await app.request(`/api/runs/${run.id}/restore`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ expectedVersion: archived.version, reason: 'Restore this route fixture.' }),
	});
	assert.equal(restoredResponse.status, 200);
	assert.equal((await restoredResponse.json() as { archive?: unknown }).archive, undefined);
});
