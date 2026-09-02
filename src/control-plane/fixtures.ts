import type { WorkItem } from './contracts.ts';

export const clixFixtures: readonly WorkItem[] = [
	{
		source: 'fixture',
		key: 'fixture:docs-run-context',
		title: 'Document cancellation behavior for RunContext consumers',
		body: 'The README shows RunContext with a timeout but does not explain how cancellation interacts with command errors and JSON error output. Clarify the observable behavior and add a focused documentation example. This is a local dry-run fixture and is not a real GitHub issue.',
		labels: ['documentation'],
		author: 'bobsled-fixture',
	},
	{
		source: 'fixture',
		key: 'fixture:ambiguous-reserved-flag',
		title: 'Change how reserved flag collisions work',
		body: 'Adjust reserved flag collision handling so consumers have more flexibility. No desired behavior, compatibility requirement, or migration plan is supplied. This is a local dry-run fixture and is not a real GitHub issue.',
		labels: ['enhancement'],
		author: 'bobsled-fixture',
	},
];
