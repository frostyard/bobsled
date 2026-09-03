import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
	evaluateMultiRepositoryMemberExecutionPreflight,
	MultiRepositoryMemberExecutionPreflightResultSchema,
	type MultiRepositoryMemberExecutionWorkspaceInspection,
} from './multi-repository-member-execution-preflight-contracts.ts';
import {
	MultiRepositoryMemberExecutionReservationStore,
	type MultiRepositoryMemberExecutionClaim,
} from './multi-repository-member-execution-reservation-store.ts';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;

export type MultiRepositoryMemberExecutionWorkspaceInspector = (workspacePath: string) => Promise<MultiRepositoryMemberExecutionWorkspaceInspection>;

function nulList(value: string): string[] {
	return value.split('\0').filter(Boolean);
}

async function git(workspacePath: string, args: string[]): Promise<string> {
	const result = await execFileAsync('git', args, {
		cwd: workspacePath, timeout: 60_000, maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' },
	});
	return result.stdout;
}

export const inspectMultiRepositoryMemberExecutionWorkspace: MultiRepositoryMemberExecutionWorkspaceInspector = async (workspacePath) => {
	const root = await realpath(workspacePath);
	const topLevel = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
	if (topLevel !== root) throw new Error('Prepared member workspace must be the Git worktree root');
	const [headCommit, unstaged, staged, untracked] = await Promise.all([
		git(root, ['rev-parse', 'HEAD']),
		git(root, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']),
		git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD', '--']),
		git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
	]);
	return {
		headCommit: headCommit.trim(),
		dirtyPaths: [...new Set([...nulList(unstaged), ...nulList(staged), ...nulList(untracked)])].sort(),
	};
};

export class MultiRepositoryMemberExecutionPreflightService {
	constructor(
		private readonly store: MultiRepositoryMemberExecutionReservationStore,
		private readonly inspector: MultiRepositoryMemberExecutionWorkspaceInspector = inspectMultiRepositoryMemberExecutionWorkspace,
	) {}

	async run(reservationId: string, ownerId: string): Promise<MultiRepositoryMemberExecutionClaim> {
		let reservation;
		try {
			reservation = this.store.get(reservationId, { id: ownerId });
		} catch (error) {
			throw error;
		}
		if (reservation.preflight) return { reservation, newlyClaimed: false };
		if (reservation.status !== 'reserved' || reservation.workerCalls !== 0) {
			throw new Error('Member execution reservation is not awaiting preflight');
		}
		let result;
		try {
			result = evaluateMultiRepositoryMemberExecutionPreflight(
				reservationId, reservation.baseCommit, await this.inspector(reservation.workspacePath),
			);
		} catch (error) {
			result = v.parse(MultiRepositoryMemberExecutionPreflightResultSchema, {
				reservationId, status: 'blocked', violations: ['inspection_failed'],
				detail: (error instanceof Error ? error.message : 'Prepared member workspace inspection failed').slice(0, 10_000),
				modelDispatchClaimed: false,
			});
		}
		return this.store.recordPreflightAndClaim(reservationId, { id: ownerId }, result);
	}
}
