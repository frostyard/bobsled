import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface GitHubAppEnvironment {
	BOBSLED_GITHUB_APP_ID?: string;
	BOBSLED_GITHUB_INSTALLATION_ID?: string;
	BOBSLED_GITHUB_PRIVATE_KEY?: string;
	BOBSLED_GITHUB_PRIVATE_KEY_FILE?: string;
	BOBSLED_GITHUB_WEBHOOK_SECRET?: string;
}

export type PrivateKeyReader = (path: string) => string;

/** A configured file is authoritative: unreadable files fail closed instead of falling back to inline key material. */
export function resolveGitHubPrivateKey(
	environment: GitHubAppEnvironment = process.env,
	read: PrivateKeyReader = (path) => readFileSync(path, 'utf8'),
): string | undefined {
	if (environment.BOBSLED_GITHUB_PRIVATE_KEY_FILE) {
		try {
			return read(environment.BOBSLED_GITHUB_PRIVATE_KEY_FILE).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	return environment.BOBSLED_GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || undefined;
}

export interface GitHubAppStatus {
	appIdConfigured: boolean;
	installationIdConfigured: boolean;
	privateKeyConfigured: boolean;
	webhookSecretConfigured: boolean;
	readyForApi: boolean;
	readyForWebhooks: boolean;
}

/** Reports presence only. Credential values must never cross this boundary. */
export function githubAppStatus(environment: GitHubAppEnvironment = process.env, read?: PrivateKeyReader): GitHubAppStatus {
	const status = {
		appIdConfigured: Boolean(environment.BOBSLED_GITHUB_APP_ID),
		installationIdConfigured: Boolean(environment.BOBSLED_GITHUB_INSTALLATION_ID),
		privateKeyConfigured: Boolean(resolveGitHubPrivateKey(environment, read)),
		webhookSecretConfigured: Boolean(environment.BOBSLED_GITHUB_WEBHOOK_SECRET),
	};
	return {
		...status,
		readyForApi: status.appIdConfigured && status.installationIdConfigured && status.privateKeyConfigured,
		readyForWebhooks: status.webhookSecretConfigured,
	};
}

/** Verifies GitHub's X-Hub-Signature-256 over the exact unmodified request bytes. */
export function verifyGitHubWebhook(payload: Uint8Array, signatureHeader: string | undefined, secret: string): boolean {
	if (!signatureHeader || !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader) || !secret) return false;
	const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
	const actualBytes = Buffer.from(signatureHeader, 'utf8');
	const expectedBytes = Buffer.from(expected, 'utf8');
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
