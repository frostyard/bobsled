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
