// Every user-facing display string that is not produced by the board
// projection lives here. Lane ids are the durable contract and never change;
// the names below are only what the operator reads.

export interface LaneCopy {
	id: 'ready' | 'working' | 'review' | 'delivery' | 'attention' | 'history';
	name: string;
	definition: string;
	empty: string;
}

export const LANES: readonly LaneCopy[] = [
	{
		id: 'ready',
		name: 'Ready',
		definition: 'Waiting for you to say go.',
		empty: 'Nothing waiting on you.',
	},
	{
		id: 'working',
		name: 'Working',
		definition: 'Codex is writing code. Nothing for you to do.',
		empty: 'Nobody is working right now.',
	},
	{
		id: 'review',
		name: 'Checking',
		definition: 'A second model is reading the change cold. Also automatic.',
		empty: 'Nothing is being reviewed.',
	},
	{
		id: 'delivery',
		name: 'Shipping',
		definition: 'A draft PR, or nearly. Merging is still yours.',
		empty: 'Nothing is on its way out.',
	},
	{
		id: 'attention',
		name: 'Needs you',
		definition: 'Something stopped and only you can decide what happens next.',
		empty: 'Nothing is stuck.',
	},
];

export const HISTORY_LANE: LaneCopy = {
	id: 'history',
	name: 'Done',
	definition: 'Merged, closed, dropped, or nothing needed changing.',
	empty: 'Nothing finished yet.',
};

// The two columns of every authorization sheet. Each entry is keyed by the
// board action kind it authorizes.
export interface AuthorityCopy {
	title: string;
	confirm: string;
	grants: readonly string[];
	denies: readonly string[];
	placeholder: string;
	note?: string;
}

export const AUTHORITY: Record<string, AuthorityCopy> = {
	enroll_repository: {
		title: 'Enroll this repository?', confirm: 'Enroll repository',
		grants: ['Import the versioned .bobsled/repository.json policy', 'Make the repository available according to that policy'],
		denies: ['Start work, spend a model call, or write to GitHub', 'Grant anything not declared by the repository policy', 'Merge or deploy'],
		placeholder: 'Why this repository belongs in Bobsled.',
	},
	enable_repository: {
		title: 'Enable this repository?', confirm: 'Enable repository',
		grants: ['Re-read the current GitHub identity and repository-owned policy', 'Allow new work only under the newly recorded policy version'],
		denies: ['Restore stale policy authority', 'Start work, spend a model call, or write to GitHub', 'Merge or deploy'],
		placeholder: 'Why new work may resume.',
	},
	disable_repository: {
		title: 'Disable this repository?', confirm: 'Disable repository',
		grants: ['Block new intake and authority for this repository', 'Keep all existing history and policy versions'],
		denies: ['Delete evidence or close GitHub work', 'Cancel already-running external side effects', 'Remove the GitHub App installation'],
		placeholder: 'Why new work should stop.',
	},
	go_fix: {
		title: 'Start work on this?',
		confirm: 'Start work',
		grants: [
			'Work in a throwaway copy of the repo',
			'Take one shot at the change — no retries',
			'Run your types, tests, and lint',
			'Have a second model review whatever it writes',
			'Fix its own mistakes once, if that review finds any',
		],
		denies: [
			'Push anything, anywhere',
			'Touch GitHub at all',
			'Open a PR — you will be asked again for that',
			'Merge or deploy, ever',
			'Reach the network while it works',
		],
		placeholder: 'Optional. “Looks straightforward” is a fine answer.',
	},
	human_override: {
		title: 'Approve this anyway?',
		confirm: 'Approve anyway',
		grants: [
			'Clear the flag that is holding this back',
			'Let it move to Ready, where you still have to start it',
		],
		denies: [
			'Start the work — that is a separate decision',
			'Change the task or the triage that flagged it',
			'Touch GitHub at all',
		],
		placeholder: 'Why you are overriding the flag.',
		note: 'Something in triage thought you should look first. You are saying you have.',
	},
	cancel: {
		title: 'Drop this run?',
		confirm: 'Drop it',
		grants: [
			'Stop this run for good',
			'Keep everything it already produced, unchanged',
		],
		denies: [
			'Delete any history — the record stays',
			'Undo anything already pushed to GitHub',
		],
		placeholder: 'Why you are dropping it.',
		note: 'You can start a fresh run from the same task afterwards.',
	},
	archive: {
		title: 'Archive this run?',
		confirm: 'Archive it',
		grants: [
			'Move this terminal run out of Needs you and into Done',
			'Stop browser notifications for this run',
			'Keep every task, attempt, review, artifact, and publication unchanged',
		],
		denies: [
			'Delete or rewrite any evidence',
			'Cancel active work, touch GitHub, or spend a model call',
		],
		placeholder: 'Optional. Why this no longer needs your attention.',
		note: 'You can restore it later from Done.',
	},
	restore: {
		title: 'Restore this run to the board?',
		confirm: 'Restore it',
		grants: [
			'Remove the archive overlay and show the run in its current workflow lane',
		],
		denies: [
			'Restart work, retry a model call, or change any evidence',
			'Touch GitHub',
		],
		placeholder: 'Optional. Why this needs attention again.',
	},
	supersede: {
		title: 'Try again with changes?',
		confirm: 'Queue a new run',
		grants: [
			'Queue a new run from the same task',
			'Link it to this one so the history stays connected',
		],
		denies: [
			'Start the new run — it lands in Ready and waits for you',
			'Change or remove the old run',
		],
		placeholder: 'What is different this time.',
	},
	manual_review: {
		title: 'Run the review this one missed?',
		confirm: 'Run the review',
		grants: [
			'Have a second model read the existing change',
			'Rerun your tests against it',
		],
		denies: [
			'Change the code in any way',
			'Open a PR or touch GitHub',
		],
		placeholder: 'Optional.',
		note: 'This finished before reviews were automatic. New work is reviewed on its own.',
	},
	prepare_publication: {
		title: 'Prepare a draft PR?',
		confirm: 'Prepare it',
		grants: [
			'Bind the reviewed change to a draft pull request, ready to open',
			'Record exactly which bytes were approved',
		],
		denies: [
			'Open anything on GitHub yet — that is the next, separate step',
			'Push to main or any existing branch',
			'Merge or deploy',
		],
		placeholder: 'Optional.',
	},
	publish_publication: {
		title: 'Open this on GitHub?',
		confirm: 'Open it on GitHub',
		grants: [
			'Push one new branch that does not exist yet',
			'Open one draft pull request from it',
			'Track the checks GitHub reports back',
		],
		denies: [
			'Force-push, or touch main or any existing branch',
			'Merge, close, or deploy anything',
			'Change a single byte of the approved change',
		],
		placeholder: 'Optional.',
		note: 'This is the first thing in the whole run that reaches GitHub.',
	},
	replay_publication: {
		title: 'Rebuild this on the latest main?',
		confirm: 'Rebuild it',
		grants: [
			'Replay the exact same change on the current main',
			'Rerun your tests against the result',
		],
		denies: [
			'Ask a model for anything — this costs no calls',
			'Change what the original change did',
			'Touch GitHub at all',
		],
		placeholder: 'Optional.',
		note: 'main moved since this was written. Same change, current base.',
	},
	review_publication_replay: {
		title: 'Review the rebuilt change?',
		confirm: 'Review it',
		grants: [
			'Have a second model read the rebuilt change once, cold',
		],
		denies: [
			'Retry — once this call is spent, its answer stands',
			'Change the code',
			'Touch GitHub at all',
		],
		placeholder: 'Optional.',
		note: 'One call, no retries. If it says no, the way forward is a new run.',
	},
	promote_publication_replay: {
		title: 'Prepare a draft PR from the rebuild?',
		confirm: 'Prepare it',
		grants: [
			'Bind the rebuilt, re-reviewed change to a fresh draft pull request',
		],
		denies: [
			'Open anything on GitHub yet',
			'Change or remove the attempt this replaced',
		],
		placeholder: 'Optional.',
	},
	resolve_publication_supersession: {
		title: 'Mark this as already shipped?',
		confirm: 'Mark it shipped',
		grants: [
			'Record that a pull request you merged later covered this task',
			'Link the two so the history makes sense',
		],
		denies: [
			'Change either pull request',
			'Ask a model for anything, or touch GitHub',
		],
		placeholder: 'Optional.',
		note: 'Nothing is deleted. The old attempt stays exactly as it is.',
	},
	intake_finalize: {
		title: 'Lock this brief in?',
		confirm: 'Lock it in and check',
		grants: [
			'Freeze the brief exactly as it reads now',
			'Send it straight to an independent check',
		],
		denies: [
			'Queue any work — you see the verdict first',
			'Start writing code, or touch GitHub',
		],
		placeholder: 'Optional.',
		note: 'The conversation ends here. You can still correct it afterwards, which starts a new brief.',
	},
	intake_admit: {
		title: 'Queue this up?',
		confirm: 'Queue it up',
		grants: [
			'Put this on the board as a run, ready to start',
		],
		denies: [
			'Start the work — it waits in Ready for you',
			'Touch GitHub at all',
		],
		placeholder: 'Optional.',
	},
	intake_correct: {
		title: 'Correct this after locking?',
		confirm: 'Start a correction',
		grants: [
			'Open a fresh brief that carries this one forward',
			'Keep the locked brief intact as history',
		],
		denies: [
			'Change the locked brief — it stays exactly as it is',
			'Queue work from the old brief once you correct it',
		],
		placeholder: 'What needs correcting.',
	},
	intake_cancel: {
		title: 'Stop working on this brief?',
		confirm: 'Stop',
		grants: [
			'End this conversation for good',
		],
		denies: [
			'Delete what you have written — the turns stay',
		],
		placeholder: 'Why you are stopping.',
	},
};

// Stage rail on the run page. Each maps to durable evidence, not to a lane.
export const STAGES = [
	{ id: 'triage', name: 'Checked' },
	{ id: 'implement', name: 'Built' },
	{ id: 'review', name: 'Second opinion' },
	{ id: 'publish', name: 'Ship' },
	{ id: 'merged', name: 'Merged' },
] as const;

export const SURFACES = [
	{ id: 'board', path: '/', name: 'Board' },
	{ id: 'intake', path: '/intake', name: 'Intake' },
	{ id: 'change-sets', path: '/change-sets', name: 'Change sets' },
	{ id: 'access', path: '/access', name: 'Access' },
	{ id: 'activity', path: '/activity', name: 'Activity' },
] as const;

export const BRIEF_FIELDS = [
	{ key: 'objective', label: 'The goal', kind: 'text' },
	{ key: 'context', label: 'Background', kind: 'list' },
	{ key: 'acceptanceCriteria', label: 'Done when', kind: 'list' },
	{ key: 'constraints', label: 'Ground rules', kind: 'list' },
	{ key: 'nonGoals', label: 'Out of scope', kind: 'list' },
	{ key: 'assumptions', label: 'Assuming', kind: 'list' },
	{ key: 'unresolvedQuestions', label: 'Still open', kind: 'list' },
] as const;

export const FOOTER = 'Bobsled opens draft PRs. It never pushes to main, never merges, never deploys.';
