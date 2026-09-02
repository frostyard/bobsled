import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('local runtime keeps state outside the repository and preserves explicit overrides', () => {
	const root = mkdtempSync(join(tmpdir(), 'bobsled-local-runtime-'));
	const configurationHome = join(root, 'configuration');
	const dataHome = join(root, 'data');
	const environment = { ...process.env };
	for (const name of [
		'BOBSLED_AUTH_FILE',
		'BOBSLED_DATA_DIR',
		'BOBSLED_WORKSPACE_DIR',
		'BOBSLED_CLIX_SOURCE_PATH',
		'BOBSLED_ENV_FILE',
	]) delete environment[name];
	environment.XDG_CONFIG_HOME = configurationHome;
	environment.XDG_DATA_HOME = dataHome;
	environment.BOBSLED_DATA_DIR = join(root, 'explicit-data');

	mkdirSync(join(configurationHome, 'bobsled'), { recursive: true });
	writeFileSync(join(configurationHome, 'bobsled', 'runtime.env'), 'BOBSLED_CODEX_MODEL=fixture-model\n');

	try {
		const output = execFileSync(process.execPath, [
			'scripts/with-local-runtime.mjs',
			process.execPath,
			'-e',
			'console.log(JSON.stringify({auth:process.env.BOBSLED_AUTH_FILE,data:process.env.BOBSLED_DATA_DIR,workspaces:process.env.BOBSLED_WORKSPACE_DIR,source:process.env.BOBSLED_CLIX_SOURCE_PATH,model:process.env.BOBSLED_CODEX_MODEL}))',
		], { cwd: process.cwd(), encoding: 'utf8', env: environment });
		const result = JSON.parse(output) as Record<string, string>;

		assert.equal(result.auth, join(configurationHome, 'bobsled', 'auth.json'));
		assert.equal(result.data, join(root, 'explicit-data'));
		assert.equal(result.workspaces, join(dataHome, 'bobsled', 'workspaces'));
		assert.equal(result.source, join(dataHome, 'bobsled', 'workspaces', 'clix'));
		assert.equal(result.model, 'fixture-model');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
