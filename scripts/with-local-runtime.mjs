import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';

const configurationHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const configurationDirectory = join(configurationHome, 'bobsled');
const dataDirectory = join(dataHome, 'bobsled');
const environmentFile = process.env.BOBSLED_ENV_FILE ?? join(configurationDirectory, 'runtime.env');

if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

process.env.BOBSLED_AUTH_FILE ??= join(configurationDirectory, 'auth.json');
process.env.BOBSLED_DATA_DIR ??= join(dataDirectory, 'data');
process.env.BOBSLED_WORKSPACE_DIR ??= join(dataDirectory, 'workspaces');
process.env.BOBSLED_CLIX_SOURCE_PATH ??= join(dataDirectory, 'workspaces', 'clix');

const [command, ...arguments_] = process.argv.slice(2);
if (!command) {
	console.error('Usage: node scripts/with-local-runtime.mjs <command> [arguments...]');
	process.exitCode = 2;
} else {
	const localBin = join(process.cwd(), 'node_modules', '.bin');
	const child = spawn(command, arguments_, {
		stdio: 'inherit',
		env: {
			...process.env,
			PATH: `${localBin}${delimiter}${process.env.PATH ?? ''}`,
		},
	});
	child.once('error', (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	child.once('exit', (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exitCode = code ?? 1;
	});
}
