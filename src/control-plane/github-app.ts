import { createHmac, timingSafeEqual } from 'node:crypto';

export interface GitHubAppEnvironment {
	BOBSLED_GITHUB_APP_ID?: string;
	BOBSLED_GITHUB_INSTALLATION_ID?: string;
	BOBSLED_GITHUB_PRIVATE_KEY?: string;
	BOBSLED_GITHUB_WEBHOOK_SECRET?: string;
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
export function githubAppStatus(environment: GitHubAppEnvironment = process.env): GitHubAppStatus {
	const status = {
		appIdConfigured: Boolean(environment.BOBSLED_GITHUB_APP_ID),
		installationIdConfigured: Boolean(environment.BOBSLED_GITHUB_INSTALLATION_ID),
		privateKeyConfigured: Boolean(environment.BOBSLED_GITHUB_PRIVATE_KEY),
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
