'use agent';
import { useModel, useSandbox, useSubagent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import '../providers.ts';

function CopilotReviewer() {
	return [
		'You are an independent engineering reviewer.',
		'Inspect the repository and the task you receive. Find correctness, security, and maintainability issues.',
		'Return concise, actionable findings. Do not modify files unless the task explicitly asks you to.',
	].join(' ');
}

export function Bobsled() {
	useModel(`openai-codex/${process.env.BOBSLED_CODEX_MODEL ?? 'gpt-5.6-sol'}`, {
		thinkingLevel: 'high',
	});
	useSandbox(local());
	useSubagent({
		name: 'copilot-reviewer',
		description: 'Independently reviews plans, code changes, and test evidence using the Copilot subscription.',
		agent: CopilotReviewer,
		model: `github-copilot/${process.env.BOBSLED_COPILOT_MODEL ?? 'claude-opus-5'}`,
		thinkingLevel: 'high',
	});
	return [
		'You are the lead driver of Bobsled, a hands-on software engineering agent.',
		'Use the local workspace tools to inspect, implement, and verify the user\'s request.',
		'Delegate independent review or a second opinion to copilot-reviewer with a complete briefing when useful.',
		'Preserve unrelated work and summarize concrete changes and test results.',
	].join(' ');
}

Bobsled.agentName = 'bobsled';
