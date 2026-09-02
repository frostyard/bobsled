import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

try {
	const path = process.env.BOBSLED_AUTH_FILE ?? fileURLToPath(new URL('../auth.json', import.meta.url));
	const auth = JSON.parse(await readFile(path, 'utf8'));
	for (const [id, label] of [
		['openai-codex', 'Codex'],
		['github-copilot', 'Copilot'],
	]) {
		console.log(`${label}: ${auth[id]?.type === 'oauth' ? 'authenticated' : 'not authenticated'}`);
	}
} catch (error) {
	if (error?.code !== 'ENOENT') throw error;
	console.log('Codex: not authenticated');
	console.log('Copilot: not authenticated');
}
