import type { AuthResult, Provider } from '@earendil-works/pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { setProvider } from '@flue/runtime';
import { AuthFileStore, resolveOAuthCredential } from './auth-file.ts';
import './control-plane/observability.ts';

const authStore = new AuthFileStore();

function subscriptionProvider<T extends Provider>(provider: T): T {
	const oauth = provider.auth.oauth;
	if (!oauth) throw new Error(`${provider.id} does not expose Pi OAuth`);

	return {
		...provider,
		auth: {
			apiKey: {
				name: `${provider.name} subscription (Pi OAuth)`,
				async resolve(): Promise<AuthResult> {
					return resolveOAuthCredential(authStore, provider.id, provider.name, oauth);
				},
			},
		},
	} as T;
}

setProvider(subscriptionProvider(openaiCodexProvider()));
setProvider(subscriptionProvider(githubCopilotProvider()));
