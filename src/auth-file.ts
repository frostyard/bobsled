import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AuthResult, Credential, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { lock } from 'proper-lockfile';

export const DEFAULT_AUTH_FILE = resolve(process.env.BOBSLED_AUTH_FILE ?? 'auth.json');
export const REFRESH_WINDOW_MS = 60_000;

export type AuthFile = Record<string, Credential>;

type TransactionResult<T> = { result: T; write?: boolean };

export class AuthFileStore {
	readonly path: string;

	constructor(path = DEFAULT_AUTH_FILE) {
		this.path = resolve(path);
	}

	async read(): Promise<AuthFile> {
		try {
			return JSON.parse(await readFile(this.path, 'utf8')) as AuthFile;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
			throw new Error(`Could not read Pi credentials at ${this.path}`, { cause: error });
		}
	}

	async transaction<T>(operation: (auth: AuthFile) => Promise<TransactionResult<T>>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true });
		const release = await lock(this.path, {
			realpath: false,
			stale: 30_000,
			update: 10_000,
			retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
		});

		try {
			const auth = await this.read();
			try {
				await chmod(this.path, 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			const outcome = await operation(auth);
			if (outcome.write) await this.write(auth);
			return outcome.result;
		} finally {
			await release();
		}
	}

	async merge(providerId: string, credential: Credential): Promise<void> {
		await this.transaction(async (auth) => {
			auth[providerId] = credential;
			return { result: undefined, write: true };
		});
	}

	private async write(auth: AuthFile): Promise<void> {
		const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
		await rename(temporary, this.path);
	}
}

export async function resolveOAuthCredential(
	store: AuthFileStore,
	providerId: string,
	providerName: string,
	oauth: Pick<OAuthAuth, 'refresh' | 'toAuth'>,
	now = Date.now(),
): Promise<AuthResult> {
	return store.transaction(async (auth) => {
		const saved = auth[providerId];
		if (!saved || saved.type !== 'oauth') {
			throw new Error(
				`No ${providerName} OAuth credential found. Run the matching npm run auth:* command from the bobsled directory.`,
			);
		}

		let credential: OAuthCredential = saved;
		let refreshed = false;
		if (credential.expires <= now + REFRESH_WINDOW_MS) {
			credential = await oauth.refresh(credential);
			auth[providerId] = credential;
			refreshed = true;
		}

		return {
			result: {
				auth: await oauth.toAuth(credential),
				source: `Pi OAuth (${store.path})`,
			},
			write: refreshed,
		};
	});
}
