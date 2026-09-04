import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FlueObservation } from '@flue/runtime';
import Database from 'better-sqlite3';
import { FlueObservationStore, observationJson } from '../src/control-plane/observability.ts';

test('persists the complete live observation plus queryable correlation fields', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-observability-'));
	const path = join(directory, 'telemetry.db');
	const observation = {
		v: 3,
		eventIndex: 7,
		timestamp: '2026-09-01T12:00:00.000Z',
		type: 'tool_start',
		toolName: 'bash',
		toolCallId: 'tool-1',
		instanceId: 'instance-1',
		conversationId: 'conversation-1',
		turnId: 'turn-1',
		origin: 'model',
		description: 'Run a command',
		args: { command: 'npm test' },
	} as FlueObservation;
	try {
		const store = new FlueObservationStore(path, () => new Date('2026-09-01T12:00:01.000Z'), 'process-1');
		store.record(observation, {
			id: 'instance-1',
			agentName: 'bobsled',
			request: { method: 'POST', url: 'https://factory.example/agents/bobsled' },
		});
		assert.deepEqual(store.metrics(), {
			total: 1,
			storedBytes: store.metrics().storedBytes,
			processes: 1,
			lastObservedAt: '2026-09-01T12:00:00.000Z',
			byType: { tool_start: 1 },
		});
		assert.ok(store.metrics().storedBytes > 0);
		store.close();

		const database = new Database(path, { readonly: true });
		const row = database.prepare('SELECT * FROM flue_observations').get() as Record<string, unknown>;
		assert.equal(row.event_type, 'tool_start');
		assert.equal(row.turn_id, 'turn-1');
		assert.equal(row.payload_encoding, 'node:v8');
		assert.deepEqual(JSON.parse(row.payload_json as string), observation);
		database.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('diagnostic JSON preserves cycles, undefined values, and bigint markers', () => {
	const value: Record<string, unknown> = { missing: undefined, large: 42n };
	value.self = value;
	assert.deepEqual(JSON.parse(observationJson(value)), {
		missing: { $type: 'undefined' },
		large: { $type: 'bigint', value: '42' },
		self: { $ref: '$' },
	});
});

test('reads back one run\'s agent work by conversation prefix without exposing anything else', () => {
	const directory = mkdtempSync(join(tmpdir(), 'bobsled-activity-'));
	const path = join(directory, 'telemetry.db');
	const at = '2026-09-01T12:00:00.000Z';
	const event = (index: number, conversationId: string, extra: Record<string, unknown> = {}) => ({
		v: 3, eventIndex: index, timestamp: at, type: 'tool_start',
		toolName: 'read', toolCallId: 'tool-' + index, instanceId: 'instance-1',
		conversationId, origin: 'model', description: 'Read a file', args: { path: 'src/a.ts' },
		...extra,
	}) as FlueObservation;
	try {
		const store = new FlueObservationStore(path, () => new Date(at), 'process-1');
		const context = { id: 'instance-1', agentName: 'implementation-worker' };
		store.record(event(1, 'implementation-attempt-1'), context);
		store.record(event(2, 'review-review-1-1-abc'), context);
		store.record(event(3, 'remediation-review-1-xyz'), context);
		store.record(event(4, 'implementation-attempt-OTHER'), context);
		// A conversation belonging to an unrelated run must never come back.
		store.record(event(5, 'triage-unrelated'), context);

		const mine = store.activity(['implementation-attempt-1', 'review-review-1-', 'remediation-review-1-']);
		assert.deepEqual(mine.map((entry) => entry.conversationId), [
			'implementation-attempt-1', 'review-review-1-1-abc', 'remediation-review-1-xyz',
		]);
		assert.equal(mine[0]?.type, 'tool_start');
		assert.deepEqual(mine[0]?.payload.args, { path: 'src/a.ts' });

		// Paging by id is how the live view avoids re-reading what it has shown.
		assert.deepEqual(store.activity(['implementation-attempt-1'], mine[0]!.id).length, 0);
		assert.deepEqual(store.activity([]).length, 0);
		// A prefix must not be readable as a LIKE pattern.
		assert.deepEqual(store.activity(['%']).length, 0);
		store.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
