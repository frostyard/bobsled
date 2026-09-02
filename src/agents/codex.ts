'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import '../providers.ts';

export function CodexAgent() {
	useModel(`openai-codex/${process.env.BOBSLED_CODEX_MODEL ?? 'gpt-5.6-sol'}`, {
		thinkingLevel: 'high',
	});
	useSandbox(local());
	return [
		'You are the Codex driver on the bobsled engineering team.',
		'Work directly in the current repository using the sandbox tools.',
		'Inspect before editing, preserve unrelated changes, test your work, and report exact results.',
	].join(' ');
}

CodexAgent.agentName = 'codex';
