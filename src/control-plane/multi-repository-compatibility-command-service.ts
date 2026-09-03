import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GateResult } from './execution-contracts.ts';
import type { MultiRepositoryCompatibilityManifest } from './multi-repository-compatibility-execution-store.ts';

const MAX_OUTPUT_BYTES = 512 * 1024;

export interface MultiRepositoryCompatibilityCommandContext {
	manifestPath: string;
	manifest: MultiRepositoryCompatibilityManifest;
	targetWorkspacePath: string;
	sandboxHomePath: string;
	toolDataPath: string;
	executablePath: string;
}

export type MultiRepositoryCompatibilityCommandRunner = (
	command: string,
	context: MultiRepositoryCompatibilityCommandContext,
	timeoutMs: number,
) => Promise<Omit<GateResult, 'id' | 'name' | 'command'>>;

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
	if (state.bytes >= MAX_OUTPUT_BYTES) { state.truncated = true; return; }
	const remaining = MAX_OUTPUT_BYTES - state.bytes;
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += Math.min(chunk.byteLength, remaining);
	if (chunk.byteLength > remaining) state.truncated = true;
}

const ISOLATION_SCRIPT = `
set -eu
root="$1"
manifest="$2"
home="$3"
tool_data="$4"
target="$5"
shift 5
mount --bind "$root" "$root"
mount --bind /usr "$root/usr"
mount -o remount,bind,ro "$root/usr"
mount --bind /proc/net/dev "$root/proc/net/dev"
mount -o remount,bind,ro "$root/proc/net/dev"
mount --bind /dev/null "$root/dev/null"
mount --bind /dev/urandom "$root/dev/urandom"
mount --bind "$home" "$root/home/bobsled"
mount --bind "$tool_data" "$root$tool_data"
mount -o remount,bind,ro "$root$tool_data"
mount --bind "$manifest" "$root/manifest.json"
mount -o remount,bind,ro "$root/manifest.json"
for workspace do
	mount --bind "$workspace" "$root$workspace"
	mount -o remount,bind,ro "$root$workspace"
done
mount -o remount,bind,ro "$root"
exec /usr/sbin/chroot "$root" /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /bin/sh -c 'cd "$BOBSLED_COMPATIBILITY_TARGET" && exec /bin/sh -c "$BOBSLED_COMPATIBILITY_COMMAND"'
`;

async function ensureLink(path: string, target: string): Promise<void> {
	if (await lstat(path).then(() => true, () => false)) return;
	await symlink(target, path);
}

async function ensureFile(path: string, mode: number): Promise<void> {
	if (await lstat(path).then(() => true, () => false)) return;
	await writeFile(path, '', { flag: 'wx', mode });
}

export const runIsolatedCompatibilityCommand: MultiRepositoryCompatibilityCommandRunner = async (command, context, timeoutMs) => {
	if (process.platform !== 'linux') throw new Error('Compatibility commands require Linux user, mount, and network namespaces');
	const workspaces = context.manifest.members.map(({ workspacePath }) => resolve(workspacePath));
	if (!workspaces.includes(resolve(context.targetWorkspacePath))) throw new Error('Compatibility target workspace is absent from the authenticated manifest');
	const root = resolve(context.sandboxHomePath, 'rootfs');
	const toolDataPath = resolve(context.toolDataPath);
	await mkdir(resolve(toolDataPath, 'cache'), { recursive: true, mode: 0o700 });
	await Promise.all([
		mkdir(resolve(root, 'usr'), { recursive: true, mode: 0o755 }),
		mkdir(resolve(root, 'proc/net'), { recursive: true, mode: 0o755 }),
		mkdir(resolve(root, 'dev'), { recursive: true, mode: 0o755 }),
		mkdir(resolve(root, 'home/bobsled'), { recursive: true, mode: 0o755 }),
		mkdir(resolve(root, toolDataPath.slice(1)), { recursive: true, mode: 0o755 }),
		...workspaces.map((workspace) => mkdir(resolve(root, workspace.slice(1)), { recursive: true, mode: 0o755 })),
	]);
	await Promise.all([
		ensureLink(resolve(root, 'bin'), 'usr/bin'), ensureLink(resolve(root, 'lib'), 'usr/lib'),
		ensureLink(resolve(root, 'lib64'), 'usr/lib64'), ensureLink(resolve(root, 'sbin'), 'usr/sbin'),
	]);
	await ensureFile(resolve(root, 'dev/null'), 0o666);
	await ensureFile(resolve(root, 'dev/urandom'), 0o444);
	await ensureFile(resolve(root, 'proc/net/dev'), 0o444);
	await ensureFile(resolve(root, 'manifest.json'), 0o444);
	await chmod(root, 0o755);
	const started = Date.now();
	return await new Promise((resolveResult, reject) => {
		const child = spawn('/usr/bin/unshare', [
			'--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '--kill-child', '--',
			'/bin/sh', '-c', ISOLATION_SCRIPT, 'bobsled-compatibility-isolation',
			root, resolve(context.manifestPath), resolve(context.sandboxHomePath), toolDataPath,
			resolve(context.targetWorkspacePath), ...workspaces,
		], {
			cwd: context.targetWorkspacePath,
			env: {
				PATH: `${resolve(toolDataPath, 'shims')}:${resolve(context.targetWorkspacePath, 'node_modules/.bin')}:/usr/local/bin:/usr/bin:/bin`,
				LANG: process.env.LANG ?? 'C.UTF-8', HOME: '/home/bobsled', TMPDIR: '/home/bobsled/tmp',
				MISE_DATA_DIR: toolDataPath, MISE_CACHE_DIR: resolve(toolDataPath, 'cache'), CI: 'true', GIT_TERMINAL_PROMPT: '0',
				BOBSLED_COMPATIBILITY_MANIFEST: '/manifest.json', BOBSLED_COMPATIBILITY_TARGET: resolve(context.targetWorkspacePath),
				BOBSLED_COMPATIBILITY_COMMAND: command,
			},
			stdio: ['ignore', 'pipe', 'pipe'], detached: true,
		});
		const stdout: Buffer[] = []; const stderr: Buffer[] = [];
		const stdoutState = { bytes: 0, truncated: false }; const stderrState = { bytes: 0, truncated: false };
		let timedOut = false;
		child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState));
		child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrState));
		child.once('error', reject);
		const terminate = (signal: NodeJS.Signals) => {
			try { if (child.pid) process.kill(-child.pid, signal); }
			catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
		};
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true; terminate('SIGTERM'); killTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
		}, timeoutMs);
		child.once('close', (exitCode) => {
			clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
			resolveResult({
				status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed', exitCode,
				durationMs: Date.now() - started, stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'), truncated: stdoutState.truncated || stderrState.truncated,
			});
		});
	});
};
