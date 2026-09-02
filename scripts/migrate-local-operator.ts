import { LegacyPrincipalMigration } from '../src/control-plane/legacy-principal-migration.ts';

const confirmed = process.argv.slice(2).includes('--confirm-single-active-github-user');
const migration = new LegacyPrincipalMigration();

try {
	const result = migration.migrate(confirmed);
	console.log(JSON.stringify({
		status: 'completed',
		target: 'sole-active-github-principal',
		runsTransferred: result.runsTransferred,
		issueActionsTransferred: result.issueActionsTransferred,
		publicationsTransferred: result.publicationsTransferred,
	}));
} finally {
	migration.close();
}
