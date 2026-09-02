import { createReadTool, SandboxOperationUnsupportedError, type Sandbox, type SandboxFactory } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

function contained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function unsupported(operation: string): never {
	throw new SandboxOperationUnsupportedError({ operation, provider: 'bobsled-read-only-repository', options: [] });
}

/**
 * A path-jailed, exec-less Flue sandbox. The model receives only Flue's
 * standard read tool; repository listing and search are separate bounded
 * application tools in the reviewer agent.
 */
export function readOnlyRepository(rootPath: string): SandboxFactory {
	const root = resolve(rootPath);
	const baseFactory = local({
		cwd: root,
		env: {
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
			SSH_AUTH_SOCK: undefined,
			GIT_ASKPASS: undefined,
		},
	});
	return {
		async createSandbox(options): Promise<Sandbox> {
			const base = await baseFactory.createSandbox(options);
			const canonicalRoot = await realpath(root);
			const lexical = (path: string) => {
				const candidate = resolve(canonicalRoot, path);
				if (!contained(canonicalRoot, candidate)) throw new Error('Repository path escapes the read-only review root');
				return candidate;
			};
			const readable = async (path: string) => {
				const candidate = lexical(path);
				const canonical = await realpath(candidate);
				if (!contained(canonicalRoot, canonical)) throw new Error('Repository path resolves outside the read-only review root');
				return canonical;
			};
			return {
				cwd: canonicalRoot,
				resolvePath: lexical,
				exec: async () => unsupported('shell execution'),
				readFile: async (path) => base.readFile(await readable(path)),
				readFileBuffer: async (path) => base.readFileBuffer(await readable(path)),
				stat: async (path) => base.stat(await readable(path)),
				readdir: async (path) => base.readdir(await readable(path)),
				exists: async (path) => {
					try { return await base.exists(await readable(path)); }
					catch { return false; }
				},
				writeFile: async () => unsupported('file writes'),
				mkdir: async () => unsupported('directory creation'),
				rm: async () => unsupported('file removal'),
			};
		},
		tools: (sandbox) => [createReadTool(sandbox)],
	};
}
