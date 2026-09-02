import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readOnlyRepository } from '../src/control-plane/read-only-repository.ts';
import { listReviewRepository, searchReviewRepository } from '../src/control-plane/review-repository-access.ts';

test('review repository sandbox permits bounded reads but denies escape, exec, and mutation', async () => {
	const parent = mkdtempSync(join(tmpdir(), 'bobsled-read-only-'));
	const repository = join(parent, 'repository');
	const outside = join(parent, 'outside.txt');
	try {
		mkdirSync(repository);
		writeFileSync(join(repository, 'README.md'), '# Safe repository\nneedle\n');
		writeFileSync(outside, 'secret\n');
		symlinkSync(outside, join(repository, 'escape'));
		const factory = readOnlyRepository(repository);
		const sandbox = await factory.createSandbox({ id: 'read-only-test' });
		assert.match(await sandbox.readFile('README.md'), /Safe repository/);
		await assert.rejects(sandbox.readFile('../outside.txt'), /escapes/);
		await assert.rejects(sandbox.readFile('escape'), /outside/);
		await assert.rejects(sandbox.writeFile('README.md', 'mutated'), /does not support/i);
		await assert.rejects(sandbox.exec('true'), /does not support/i);
		assert.deepEqual(factory.tools?.(sandbox, { subagents: {} }).map(({ name }) => name), ['read']);
		assert.deepEqual(await listReviewRepository(repository, '.', 2), ['README.md', 'escape@']);
		assert.deepEqual(await searchReviewRepository(repository, 'needle'), [{ path: 'README.md', line: 2, text: 'needle' }]);
	} finally { rmSync(parent, { recursive: true, force: true }); }
});
