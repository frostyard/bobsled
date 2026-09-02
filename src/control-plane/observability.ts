import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serialize } from 'node:v8';
import { observe, type FlueEventContext, type FlueObservation } from '@flue/runtime';
import Database from 'better-sqlite3';
import { dataPath } from '../paths.ts';

export interface ObservationMetrics {
	total: number;
	storedBytes: number;
	processes: number;
	lastObservedAt?: string;
	byType: Record<string, number>;
}

interface ObservationContext {
	id: string;
	agentName?: string;
	request?: {
		method: string;
		url: string;
	};
}

interface QueuedObservation {
	observation: FlueObservation;
	context: ObservationContext;
	recordedAt: string;
}

interface ObservationCountRow {
	type: string;
	count: number;
}

/**
 * Makes a stable diagnostic JSON projection while preserving values JSON normally
 * loses. The authoritative payload is also retained as a Node V8 serialization.
 */
export function observationJson(value: unknown): string {
	const seen = new WeakMap<object, string>();
	const encode = (item: unknown, path: string): unknown => {
		if (item === undefined) return { $type: 'undefined' };
		if (typeof item === 'bigint') return { $type: 'bigint', value: item.toString() };
		if (typeof item === 'number' && !Number.isFinite(item)) return { $type: 'number', value: String(item) };
		if (typeof item === 'symbol') return { $type: 'symbol', value: item.description };
		if (typeof item === 'function') return { $type: 'function', name: item.name };
		if (item === null || typeof item !== 'object') return item;
		const existing = seen.get(item);
		if (existing) return { $ref: existing };
		seen.set(item, path);
		if (item instanceof Date) return { $type: 'date', value: item.toISOString() };
		if (item instanceof Uint8Array) return { $type: 'bytes', encoding: 'base64', value: Buffer.from(item).toString('base64') };
		if (item instanceof Error) {
			return {
				$type: 'error',
				name: item.name,
				message: item.message,
				stack: item.stack,
				cause: encode(item.cause, `${path}.cause`),
			};
		}
		if (item instanceof Map) {
			return { $type: 'map', entries: [...item.entries()].map(([key, entry], index) => [encode(key, `${path}.entries[${index}].key`), encode(entry, `${path}.entries[${index}].value`)]) };
		}
		if (item instanceof Set) return { $type: 'set', values: [...item].map((entry, index) => encode(entry, `${path}.values[${index}]`)) };
		if (Array.isArray(item)) return item.map((entry, index) => encode(entry, `${path}[${index}]`));
		return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, encode(entry, `${path}.${key}`)]));
	};
	return JSON.stringify(encode(value, '$'));
}

function safeRequest(request: Request | undefined): ObservationContext['request'] {
	if (!request) return undefined;
	try {
		const url = new URL(request.url);
		return { method: request.method, url: `${url.origin}${url.pathname}` };
	} catch {
		return { method: request.method, url: '<unparseable>' };
	}
}

export class FlueObservationStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;
	readonly #processId: string;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date(), processId: string = randomUUID()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#now = now;
		this.#processId = processId;
		this.#migrate();
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS flue_observations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				process_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				context_agent_name TEXT,
				request_method TEXT,
				request_url TEXT,
				event_version INTEGER NOT NULL,
				event_index INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				event_timestamp TEXT NOT NULL,
				instance_id TEXT,
				submission_id TEXT,
				agent_name TEXT,
				conversation_id TEXT,
				session TEXT,
				parent_session TEXT,
				task_id TEXT,
				harness TEXT,
				operation_id TEXT,
				turn_id TEXT,
				payload_encoding TEXT NOT NULL,
				payload_blob BLOB NOT NULL,
				payload_json TEXT NOT NULL,
				payload_sha256 TEXT NOT NULL,
				recorded_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS flue_observations_submission_idx ON flue_observations(submission_id, id);
			CREATE INDEX IF NOT EXISTS flue_observations_conversation_idx ON flue_observations(conversation_id, id);
			CREATE INDEX IF NOT EXISTS flue_observations_type_time_idx ON flue_observations(event_type, event_timestamp);
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));
		`);
	}

	record(observation: FlueObservation, context: ObservationContext, recordedAt = this.#now().toISOString()): void {
		const payloadJson = observationJson(observation);
		let encoding = 'node:v8';
		let blob: Buffer;
		try {
			blob = serialize(observation);
		} catch {
			// Exotic tool payloads can contain values V8 cannot clone. The extended
			// JSON projection still records those values without poisoning the queue.
			encoding = 'json:extended';
			blob = Buffer.from(payloadJson);
		}
		const correlated = observation as FlueObservation & Record<string, unknown>;
		this.#db.prepare(`INSERT INTO flue_observations (
			process_id, context_id, context_agent_name, request_method, request_url,
			event_version, event_index, event_type, event_timestamp,
			instance_id, submission_id, agent_name, conversation_id, session,
			parent_session, task_id, harness, operation_id, turn_id,
			payload_encoding, payload_blob, payload_json, payload_sha256, recorded_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			this.#processId,
			context.id,
			context.agentName ?? null,
			context.request?.method ?? null,
			context.request?.url ?? null,
			observation.v,
			observation.eventIndex,
			observation.type,
			observation.timestamp,
			correlated.instanceId ?? null,
			correlated.submissionId ?? null,
			correlated.agentName ?? null,
			correlated.conversationId ?? null,
			correlated.session ?? null,
			correlated.parentSession ?? null,
			correlated.taskId ?? null,
			correlated.harness ?? null,
			correlated.operationId ?? null,
			correlated.turnId ?? null,
			encoding,
			blob,
			payloadJson,
			createHash('sha256').update(blob).digest('hex'),
			recordedAt,
		);
	}

	recordBatch(batch: QueuedObservation[]): void {
		this.#db.transaction(() => {
			for (const item of batch) this.record(item.observation, item.context, item.recordedAt);
		})();
	}

	metrics(): ObservationMetrics {
		const totals = this.#db.prepare(`SELECT COUNT(*) AS total,
			COALESCE(SUM(length(payload_blob) + length(payload_json)), 0) AS stored_bytes,
			COUNT(DISTINCT process_id) AS processes,
			MAX(event_timestamp) AS last_observed_at FROM flue_observations`).get() as {
			total: number; stored_bytes: number; processes: number; last_observed_at: string | null;
		};
		const byType = Object.fromEntries((this.#db.prepare('SELECT event_type AS type, COUNT(*) AS count FROM flue_observations GROUP BY event_type ORDER BY event_type').all() as ObservationCountRow[])
			.map(({ type, count }) => [type, count]));
		return {
			total: totals.total,
			storedBytes: totals.stored_bytes,
			processes: totals.processes,
			lastObservedAt: totals.last_observed_at ?? undefined,
			byType,
		};
	}
}

interface ObserverState {
	store: FlueObservationStore;
	queue: QueuedObservation[];
	flushScheduled: boolean;
	unsubscribe: () => void;
	flush: () => void;
}

const stateKey = Symbol.for('bobsled.flue-observer.v1');
const host = globalThis as typeof globalThis & { [stateKey]?: ObserverState };

function installObserver(): ObserverState {
	const store = new FlueObservationStore();
	const state: ObserverState = { store, queue: [], flushScheduled: false, unsubscribe: () => undefined, flush: () => undefined };
	const flush = () => {
		state.flushScheduled = false;
		const batch = state.queue.splice(0);
		if (batch.length === 0) return;
		try {
			store.recordBatch(batch);
		} catch (error) {
			state.queue.unshift(...batch);
			// Never emit through ctx.log here: that would recursively create observations.
			console.error('[bobsled:observability] Failed to persist Flue observation batch', error);
		}
	};
	state.flush = flush;
	state.unsubscribe = observe((observation: FlueObservation, context: FlueEventContext) => {
		state.queue.push({
			observation,
			context: { id: context.id, agentName: context.agentName, request: safeRequest(context.req) },
			recordedAt: new Date().toISOString(),
		});
		if (!state.flushScheduled) {
			state.flushScheduled = true;
			queueMicrotask(flush);
		}
	});
	process.once('beforeExit', flush);
	return state;
}

export const flueObservationStore = host[stateKey]?.store ?? (() => {
	const state = installObserver();
	host[stateKey] = state;
	return state.store;
})();
