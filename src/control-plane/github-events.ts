import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;
const acceptedEvents = new Set(['ping', 'installation', 'installation_repositories', 'issues', 'issue_comment']);

const WebhookEnvelopeSchema = v.looseObject({
	action: v.optional(v.string()),
	installation: v.optional(v.looseObject({
		id: v.pipe(v.number(), v.integer(), v.minValue(1)),
		account: v.optional(v.looseObject({ login: v.string(), type: v.optional(v.string()) })),
		permissions: v.optional(v.record(v.string(), v.string())),
		events: v.optional(v.array(v.string())),
		repository_selection: v.optional(v.string()),
		suspended_at: v.optional(v.nullable(v.string())),
	})),
	repository: v.optional(v.looseObject({
		id: v.pipe(v.number(), v.integer(), v.minValue(1)),
		full_name: v.string(),
	})),
});

export class WebhookConflictError extends Error {}
export class WebhookPayloadError extends Error {}
export class WebhookForbiddenError extends Error {}

export interface RecordVerifiedWebhookInput {
	deliveryId: string;
	eventName: string;
	payload: Uint8Array;
	decodedPayload: unknown;
}

export interface RecordedWebhook {
	deliveryId: string;
	eventName: string;
	action?: string;
	status: 'accepted' | 'ignored';
	duplicate: boolean;
	installationId?: number;
	repositoryId?: number;
	repositoryFullName?: string;
	payloadSha256: string;
	receivedAt: string;
}

export interface WebhookMetrics {
	total: number;
	accepted: number;
	ignored: number;
	installationSnapshots: number;
	lastReceivedAt?: string;
}

export interface GitHubInstallationSnapshot {
	repositorySelection?: string;
	permissions: Record<string, string>;
	recordedAt: string;
}

interface DeliveryRow {
	delivery_id: string;
	event_name: string;
	action: string | null;
	status: 'accepted' | 'ignored';
	installation_id: number | null;
	repository_id: number | null;
	repository_full_name: string | null;
	payload_sha256: string;
	received_at: string;
}

function asRecorded(row: DeliveryRow, duplicate: boolean): RecordedWebhook {
	return {
		deliveryId: row.delivery_id,
		eventName: row.event_name,
		action: row.action ?? undefined,
		status: row.status,
		duplicate,
		installationId: row.installation_id ?? undefined,
		repositoryId: row.repository_id ?? undefined,
		repositoryFullName: row.repository_full_name ?? undefined,
		payloadSha256: row.payload_sha256,
		receivedAt: row.received_at,
	};
}

export class GitHubEventStore {
	readonly #db: Database.Database;
	readonly #now: () => Date;

	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new Database(path);
		if (path !== ':memory:') chmodSync(path, 0o600);
		this.#db.pragma('foreign_keys = ON');
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('busy_timeout = 5000');
		this.#now = now;
		this.#migrate();
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
				delivery_id TEXT PRIMARY KEY,
				event_name TEXT NOT NULL,
				action TEXT,
				status TEXT NOT NULL,
				installation_id INTEGER,
				repository_id INTEGER,
				repository_full_name TEXT,
				payload_sha256 TEXT NOT NULL,
				payload_blob BLOB,
				received_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS github_installation_snapshots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				delivery_id TEXT NOT NULL,
				installation_id INTEGER NOT NULL,
				account_login TEXT,
				account_type TEXT,
				repository_selection TEXT,
				permissions_json TEXT NOT NULL,
				events_json TEXT NOT NULL,
				suspended_at TEXT,
				recorded_at TEXT NOT NULL,
				UNIQUE(delivery_id, installation_id),
				FOREIGN KEY(delivery_id) REFERENCES github_webhook_deliveries(delivery_id)
			);
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
		`);
		const columns = this.#db.pragma('table_info(github_webhook_deliveries)') as Array<{ name: string }>;
		if (!columns.some(({ name }) => name === 'payload_blob')) {
			this.#db.exec('ALTER TABLE github_webhook_deliveries ADD COLUMN payload_blob BLOB');
		}
		this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'))").run();
	}

	recordVerified(input: RecordVerifiedWebhookInput): RecordedWebhook {
		if (input.payload.byteLength > MAX_WEBHOOK_BYTES) throw new WebhookPayloadError('Webhook payload exceeds 5 MiB');
		if (!input.deliveryId || input.deliveryId.length > 200) throw new WebhookPayloadError('Missing or invalid X-GitHub-Delivery header');
		if (!input.eventName || !/^[a-z0-9_]{1,100}$/.test(input.eventName)) throw new WebhookPayloadError('Missing or invalid X-GitHub-Event header');
		const deliveryId = input.deliveryId;
		const eventName = input.eventName;

		const parsed = v.safeParse(WebhookEnvelopeSchema, input.decodedPayload);
		if (!parsed.success) throw new WebhookPayloadError('Webhook body does not match the GitHub event envelope');
		const envelope = parsed.output;
		const installationOwner = envelope.installation?.account?.login;
		if (installationOwner && installationOwner.toLowerCase() !== 'frostyard') {
			throw new WebhookForbiddenError('GitHub App installation is outside the frostyard organization');
		}
		if (envelope.repository && !envelope.repository.full_name.toLowerCase().startsWith('frostyard/')) {
			throw new WebhookForbiddenError('Webhook repository is outside the frostyard organization');
		}
		const digest = createHash('sha256').update(input.payload).digest('hex');
		const timestamp = this.#now().toISOString();
		const status = acceptedEvents.has(eventName) ? 'accepted' : 'ignored';

		return this.#db.transaction(() => {
			const existing = this.#db.prepare('SELECT * FROM github_webhook_deliveries WHERE delivery_id = ?').get(deliveryId) as DeliveryRow | undefined;
			if (existing) {
				if (existing.payload_sha256 !== digest || existing.event_name !== eventName) {
					throw new WebhookConflictError('GitHub delivery ID was reused with different content');
				}
				return asRecorded(existing, true);
			}

			const row: DeliveryRow = {
				delivery_id: deliveryId,
				event_name: eventName,
				action: envelope.action ?? null,
				status,
				installation_id: envelope.installation?.id ?? null,
				repository_id: envelope.repository?.id ?? null,
				repository_full_name: envelope.repository?.full_name ?? null,
				payload_sha256: digest,
				received_at: timestamp,
			};
			this.#db.prepare(`INSERT INTO github_webhook_deliveries
				(delivery_id, event_name, action, status, installation_id, repository_id, repository_full_name, payload_sha256, payload_blob, received_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(row.delivery_id, row.event_name, row.action, row.status, row.installation_id, row.repository_id, row.repository_full_name, row.payload_sha256, Buffer.from(input.payload), row.received_at);

			if (envelope.installation?.permissions) {
				this.#db.prepare(`INSERT INTO github_installation_snapshots
					(delivery_id, installation_id, account_login, account_type, repository_selection, permissions_json, events_json, suspended_at, recorded_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(
						row.delivery_id,
						envelope.installation.id,
						envelope.installation.account?.login ?? null,
						envelope.installation.account?.type ?? null,
						envelope.installation.repository_selection ?? null,
						JSON.stringify(envelope.installation.permissions),
						JSON.stringify(envelope.installation.events ?? []),
						envelope.installation.suspended_at ?? null,
						timestamp,
					);
			}

			return asRecorded(row, false);
		})();
	}

	readExactPayload(deliveryId: string): Uint8Array | undefined {
		const row = this.#db.prepare('SELECT payload_blob FROM github_webhook_deliveries WHERE delivery_id = ?')
			.get(deliveryId) as { payload_blob: Buffer | null } | undefined;
		return row?.payload_blob ? new Uint8Array(row.payload_blob) : undefined;
	}

	latestInstallationSnapshot(): GitHubInstallationSnapshot | undefined {
		const row = this.#db.prepare(`SELECT repository_selection, permissions_json, recorded_at
			FROM github_installation_snapshots ORDER BY id DESC LIMIT 1`).get() as {
			repository_selection: string | null;
			permissions_json: string;
			recorded_at: string;
		} | undefined;
		if (!row) return undefined;
		let permissions: unknown;
		try {
			permissions = JSON.parse(row.permissions_json);
		} catch {
			permissions = {};
		}
		const boundedPermissions = permissions && typeof permissions === 'object' && !Array.isArray(permissions)
			? Object.fromEntries(Object.entries(permissions).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
			: {};
		return {
			repositorySelection: row.repository_selection ?? undefined,
			permissions: boundedPermissions,
			recordedAt: row.recorded_at,
		};
	}

	metrics(): WebhookMetrics {
		const deliveries = this.#db.prepare(`SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
			SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored,
			MAX(received_at) AS last_received_at
			FROM github_webhook_deliveries`).get() as { total: number; accepted: number | null; ignored: number | null; last_received_at: string | null };
		const snapshots = this.#db.prepare('SELECT COUNT(*) AS count FROM github_installation_snapshots').get() as { count: number };
		return {
			total: deliveries.total,
			accepted: deliveries.accepted ?? 0,
			ignored: deliveries.ignored ?? 0,
			installationSnapshots: snapshots.count,
			lastReceivedAt: deliveries.last_received_at ?? undefined,
		};
	}
}

export const githubEventStore = new GitHubEventStore();
