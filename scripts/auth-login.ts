import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Credential } from '@earendil-works/pi-ai';
import { AuthFileStore } from '../src/auth-file.ts';

const providerId = process.argv[2];
if (providerId !== 'openai-codex' && providerId !== 'github-copilot') {
	console.error('Usage: auth-login.ts <openai-codex|github-copilot>');
	process.exit(2);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'bobsled-pi-auth-'));

try {
	const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
	const piCli = join(dirname(piEntry), 'cli.js');
	const child = spawn(process.execPath, [piCli, 'login', providerId], {
		cwd: temporaryDirectory,
		stdio: 'inherit',
	});
	const exitCode = await new Promise<number>((resolveExit, reject) => {
		child.once('error', reject);
		child.once('exit', (code) => resolveExit(code ?? 1));
	});
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	} else {
		const temporaryAuth = JSON.parse(
			await readFile(join(temporaryDirectory, 'auth.json'), 'utf8'),
		) as Record<string, Credential>;
		const credential = temporaryAuth[providerId];
		if (!credential) throw new Error(`Pi login did not return a ${providerId} credential`);

		await new AuthFileStore().merge(providerId, credential);
		console.log(`\n${providerId} credential merged into the configured Bobsled credential store.`);
	}
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
