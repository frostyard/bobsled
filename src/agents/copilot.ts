'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import '../providers.ts';

export function CopilotAgent() {
	useModel(`github-copilot/${process.env.BOBSLED_COPILOT_MODEL ?? 'claude-opus-5'}`, {
		thinkingLevel: 'high',
	});
	useSandbox(local());
	return [
		'You are the Copilot driver on the bobsled engineering team.',
		'Work directly in the current repository using the sandbox tools.',
		'Focus on pragmatic implementation, code review, and verification. Preserve unrelated changes.',
	].join(' ');
}

CopilotAgent.agentName = 'copilot';
