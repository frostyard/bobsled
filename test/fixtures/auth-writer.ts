import type { OAuthCredential } from '@earendil-works/pi-ai';
import { AuthFileStore } from '../../src/auth-file.ts';

const [path, providerId, access, delayText] = process.argv.slice(2);
if (!path || !providerId || !access) process.exit(2);

const store = new AuthFileStore(path);
await store.transaction(async (auth) => {
	await new Promise((resolve) => setTimeout(resolve, Number(delayText ?? 0)));
	auth[providerId] = {
		type: 'oauth',
		access,
		refresh: `refresh-${access}`,
		expires: Date.now() + 60_000,
	} satisfies OAuthCredential;
	return { result: undefined, write: true };
});
