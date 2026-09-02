import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_WALKED_ENTRIES = 20_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

function contained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function safePath(rootPath: string, requested = '.'): Promise<{ root: string; path: string }> {
	const root = await realpath(resolve(rootPath));
	const candidate = resolve(root, requested);
	if (!contained(root, candidate)) throw new Error('Repository path escapes the read-only review root');
	const path = await realpath(candidate);
	if (!contained(root, path)) throw new Error('Repository path resolves outside the read-only review root');
	return { root, path };
}

export async function listReviewRepository(rootPath: string, requested = '.', depth = 2): Promise<string[]> {
	const { root, path } = await safePath(rootPath, requested);
	const output: string[] = [];
	let walked = 0;
	async function walk(directory: string, remaining: number): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			walked += 1;
			if (walked > MAX_WALKED_ENTRIES) throw new Error('Repository listing exceeded its bounded entry limit');
			const absolute = resolve(directory, entry.name);
			const display = relative(root, absolute) || '.';
			if (entry.isSymbolicLink()) { output.push(`${display}@`); continue; }
			if (entry.isDirectory()) {
				output.push(`${display}/`);
				if (remaining > 1) await walk(absolute, remaining - 1);
			} else output.push(display);
		}
	}
	const stat = await lstat(path);
	if (stat.isDirectory()) await walk(path, Math.max(1, Math.min(depth, 5)));
	else output.push(relative(root, path));
	return output;
}

export interface RepositorySearchMatch { path: string; line: number; text: string }

export async function searchReviewRepository(rootPath: string, query: string, requested = '.', maxResults = 50): Promise<RepositorySearchMatch[]> {
	const { root, path } = await safePath(rootPath, requested);
	const needle = query.toLocaleLowerCase();
	if (needle.length === 0) throw new Error('Search query cannot be empty');
	const matches: RepositorySearchMatch[] = [];
	let walked = 0;
	const limit = Math.max(1, Math.min(maxResults, 100));
	async function inspect(candidate: string): Promise<void> {
		if (matches.length >= limit) return;
		walked += 1;
		if (walked > MAX_WALKED_ENTRIES) throw new Error('Repository search exceeded its bounded entry limit');
		const stat = await lstat(candidate);
		if (stat.isSymbolicLink()) return;
		if (stat.isDirectory()) {
			for (const entry of await readdir(candidate)) await inspect(resolve(candidate, entry));
			return;
		}
		if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return;
		const content = await readFile(candidate);
		if (content.includes(0)) return;
		for (const [index, line] of content.toString('utf8').split('\n').entries()) {
			if (line.toLocaleLowerCase().includes(needle)) matches.push({ path: relative(root, candidate), line: index + 1, text: line.slice(0, 1_000) });
			if (matches.length >= limit) return;
		}
	}
	await inspect(path);
	return matches;
}
