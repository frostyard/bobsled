import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { REQUIRED_GITHUB_ORGANIZATION, type OperatorAuthConfiguration } from './operator-auth.ts';

const GITHUB_API_VERSION = '2026-03-10';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const TokenResponseSchema = v.object({ access_token: v.string() });
const UserSchema = v.object({ id: v.pipe(v.number(), v.integer(), v.minValue(1)), login: v.string() });
const MembershipSchema = v.object({
	state: v.picklist(['active', 'pending']),
	role: v.string(),
	organization: v.object({ login: v.string() }),
});

export interface OperatorPrincipal {
	id: string;
	login: string;
	githubUserId: number;
	organization: typeof REQUIRED_GITHUB_ORGANIZATION;
	organizationRole: string;
}

export interface BeginGitHubLoginResult {
	authorizeUrl: string;
	state: string;
}

export interface CompleteGitHubLoginInput {
	code: string;
	state: string;
	stateCookie: string;
	configuration: OperatorAuthConfiguration;
	fetch?: typeof fetch;
}

export interface CompleteGitHubLoginResult {
	principal: OperatorPrincipal;
	sessionCookie: string;
}

export class OperatorAuthError extends Error {}
export class OperatorAuthForbiddenError extends OperatorAuthError {}
export class OperatorAuthUpstreamError extends OperatorAuthError {}

interface OAuthStateRow {
	verifier_encrypted: string;
	expires_at: string;
	consumed_at: string | null;
}

interface SessionRow {
	github_user_id: number;
	github_login: string;
	organization_role: string;
	expires_at: string;
	revoked_at: string | null;
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

function digest(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function equal(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function encryptionKey(secret: string): Buffer {
	return createHash('sha256').update(`bobsled:oauth-state:${secret}`).digest();
}

function encrypt(value: string, secret: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), ciphertext].map(base64url).join('.');
}

function decrypt(value: string, secret: string): string {
	const [ivValue, tagValue, ciphertextValue] = value.split('.');
	if (!ivValue || !tagValue || !ciphertextValue) throw new OperatorAuthError('OAuth state could not be decrypted');
	const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivValue, 'base64url'));
	decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
}

function signedSessionCookie(token: string, secret: string): string {
	const signature = createHmac('sha256', secret).update(token).digest('base64url');
	return `${token}.${signature}`;
}

function verifiedSessionToken(cookie: string, secret: string): string | undefined {
	const split = cookie.lastIndexOf('.');
	if (split < 1) return undefined;
	const token = cookie.slice(0, split);
	const signature = cookie.slice(split + 1);
	const expected = createHmac('sha256', secret).update(token).digest('base64url');
	return equal(signature, expected) ? token : undefined;
}

async function jsonResponse(response: Response, label: string): Promise<unknown> {
	if (!response.ok) throw new OperatorAuthUpstreamError(`${label} failed with HTTP ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw new OperatorAuthUpstreamError(`${label} returned invalid JSON`);
	}
}

export class OperatorSessionStore {
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
			CREATE TABLE IF NOT EXISTS operator_oauth_states (
				state_sha256 TEXT PRIMARY KEY, verifier_encrypted TEXT NOT NULL,
				created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
			);
			CREATE TABLE IF NOT EXISTS operator_sessions (
				token_sha256 TEXT PRIMARY KEY, github_user_id INTEGER NOT NULL, github_login TEXT NOT NULL,
				organization TEXT NOT NULL, organization_role TEXT NOT NULL,
				created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT
			);
			CREATE INDEX IF NOT EXISTS operator_sessions_user_idx ON operator_sessions(github_user_id, expires_at);
			INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'));
		`);
	}

	begin(configuration: OperatorAuthConfiguration): BeginGitHubLoginResult {
		const now = this.#now();
		const state = base64url(randomBytes(32));
		const verifier = base64url(randomBytes(48));
		const challenge = base64url(createHash('sha256').update(verifier).digest());
		this.#cleanup(now);
		this.#db.prepare(`INSERT INTO operator_oauth_states
			(state_sha256, verifier_encrypted, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)`).run(
			digest(state), encrypt(verifier, configuration.sessionSecret), now.toISOString(),
			new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
		);
		const authorize = new URL('https://github.com/login/oauth/authorize');
		authorize.searchParams.set('client_id', configuration.clientId);
		authorize.searchParams.set('redirect_uri', configuration.callbackUrl);
		authorize.searchParams.set('state', state);
		authorize.searchParams.set('code_challenge', challenge);
		authorize.searchParams.set('code_challenge_method', 'S256');
		authorize.searchParams.set('allow_signup', 'false');
		authorize.searchParams.set('prompt', 'select_account');
		return { authorizeUrl: authorize.toString(), state };
	}

	async complete(input: CompleteGitHubLoginInput): Promise<CompleteGitHubLoginResult> {
		if (!input.code || !input.state || !equal(input.state, input.stateCookie)) {
			throw new OperatorAuthError('OAuth callback state is missing or does not match');
		}
		const now = this.#now();
		const stateHash = digest(input.state);
		const row = this.#db.prepare('SELECT verifier_encrypted, expires_at, consumed_at FROM operator_oauth_states WHERE state_sha256 = ?').get(stateHash) as OAuthStateRow | undefined;
		if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now.getTime()) {
			throw new OperatorAuthError('OAuth callback state is expired or already used');
		}
		const consumed = this.#db.prepare('UPDATE operator_oauth_states SET consumed_at = ? WHERE state_sha256 = ? AND consumed_at IS NULL').run(now.toISOString(), stateHash);
		if (consumed.changes !== 1) throw new OperatorAuthError('OAuth callback state is already used');
		const verifier = decrypt(row.verifier_encrypted, input.configuration.sessionSecret);
		this.#db.prepare('DELETE FROM operator_oauth_states WHERE state_sha256 = ?').run(stateHash);
		const request = input.fetch ?? fetch;
		const tokenResponse = await request('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: input.configuration.clientId, client_secret: input.configuration.clientSecret,
				code: input.code, redirect_uri: input.configuration.callbackUrl, code_verifier: verifier,
			}),
		});
		const token = v.parse(TokenResponseSchema, await jsonResponse(tokenResponse, 'GitHub token exchange')).access_token;
		const headers = {
			accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
			'x-github-api-version': GITHUB_API_VERSION, 'user-agent': 'bobsled-control-plane',
		};
		const [userResponse, membershipResponse] = await Promise.all([
			request('https://api.github.com/user', { headers }),
			request(`https://api.github.com/user/memberships/orgs/${REQUIRED_GITHUB_ORGANIZATION}`, { headers }),
		]);
		const user = v.parse(UserSchema, await jsonResponse(userResponse, 'GitHub user lookup'));
		if (membershipResponse.status === 403 || membershipResponse.status === 404) {
			throw new OperatorAuthForbiddenError(`Active ${REQUIRED_GITHUB_ORGANIZATION} membership is required`);
		}
		const membership = v.parse(MembershipSchema, await jsonResponse(membershipResponse, 'GitHub organization membership lookup'));
		if (membership.state !== 'active' || membership.organization.login.toLowerCase() !== REQUIRED_GITHUB_ORGANIZATION) {
			throw new OperatorAuthForbiddenError(`Active ${REQUIRED_GITHUB_ORGANIZATION} membership is required`);
		}
		const principal: OperatorPrincipal = {
			id: `github:${user.id}`, login: user.login, githubUserId: user.id,
			organization: REQUIRED_GITHUB_ORGANIZATION, organizationRole: membership.role,
		};
		return { principal, sessionCookie: this.#createSession(principal, input.configuration.sessionSecret, now) };
	}

	resolve(cookie: string | undefined, sessionSecret: string): OperatorPrincipal | undefined {
		if (!cookie) return undefined;
		const token = verifiedSessionToken(cookie, sessionSecret);
		if (!token) return undefined;
		const now = this.#now();
		const row = this.#db.prepare(`SELECT github_user_id, github_login, organization_role, expires_at, revoked_at
			FROM operator_sessions WHERE token_sha256 = ? AND organization = ?`).get(digest(token), REQUIRED_GITHUB_ORGANIZATION) as SessionRow | undefined;
		if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= now.getTime()) return undefined;
		this.#db.prepare('UPDATE operator_sessions SET last_seen_at = ? WHERE token_sha256 = ?').run(now.toISOString(), digest(token));
		return {
			id: `github:${row.github_user_id}`, login: row.github_login, githubUserId: row.github_user_id,
			organization: REQUIRED_GITHUB_ORGANIZATION, organizationRole: row.organization_role,
		};
	}

	revoke(cookie: string | undefined, sessionSecret: string): void {
		if (!cookie) return;
		const token = verifiedSessionToken(cookie, sessionSecret);
		if (!token) return;
		this.#db.prepare('UPDATE operator_sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL')
			.run(this.#now().toISOString(), digest(token));
	}

	#createSession(principal: OperatorPrincipal, sessionSecret: string, now: Date): string {
		const token = base64url(randomBytes(32));
		this.#db.prepare(`INSERT INTO operator_sessions
			(token_sha256, github_user_id, github_login, organization, organization_role, created_at, expires_at, last_seen_at, revoked_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
			digest(token), principal.githubUserId, principal.login, principal.organization, principal.organizationRole,
			now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString(), now.toISOString(),
		);
		return signedSessionCookie(token, sessionSecret);
	}

	#cleanup(now: Date): void {
		this.#db.prepare('DELETE FROM operator_oauth_states WHERE expires_at < ? OR consumed_at IS NOT NULL').run(now.toISOString());
		this.#db.prepare('DELETE FROM operator_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now.toISOString());
	}
}

export const operatorSessionStore = new OperatorSessionStore();
