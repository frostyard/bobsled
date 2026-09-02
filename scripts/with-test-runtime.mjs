import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'bobsled-test-runtime-'));
const [command, ...arguments_] = process.argv.slice(2);

if (!command) {
	rmSync(root, { recursive: true, force: true });
	console.error('Usage: node scripts/with-test-runtime.mjs <command> [arguments...]');
	process.exitCode = 2;
} else {
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	const localBin = join(process.cwd(), 'node_modules', '.bin');
	const child = spawn(command, arguments_, {
		stdio: 'inherit',
		env: {
			...process.env,
			PATH: `${localBin}${delimiter}${process.env.PATH ?? ''}`,
			BOBSLED_AUTH_FILE: join(root, 'configuration', 'auth.json'),
			BOBSLED_DATA_DIR: join(root, 'data'),
			BOBSLED_WORKSPACE_DIR: join(root, 'workspaces'),
			BOBSLED_CLIX_SOURCE_PATH: join(root, 'sources', 'clix'),
		},
	});
	child.once('error', (error) => {
		cleanup();
		console.error(error.message);
		process.exitCode = 1;
	});
	child.once('exit', (code, signal) => {
		cleanup();
		if (signal) process.kill(process.pid, signal);
		else process.exitCode = code ?? 1;
	});
}
