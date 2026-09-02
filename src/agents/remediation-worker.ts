'use agent';
import { useDataWriter, useInitialData, useModel, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import {
	RemediationInitialDataSchema,
	RemediationResultSchema,
	type RemediationInitialData,
} from '../control-plane/execution-contracts.ts';
import { workerNetworkInstruction } from '../control-plane/worker-network-policy.ts';
import '../providers.ts';

export function RemediationWorker() {
	useModel(`openai-codex/${process.env.BOBSLED_WORKER_MODEL ?? process.env.BOBSLED_CODEX_MODEL ?? 'gpt-5.6-sol'}`, {
		thinkingLevel: 'high',
	});
	const input = useInitialData<RemediationInitialData>();
	if (!input) throw new Error('RemediationWorker requires trusted remediation data');
	useSandbox(local({
		cwd: input.workspacePath,
		env: {
			HOME: input.sandboxHomePath,
			PATH: `${input.toolDataPath}/shims:${input.executablePath}`,
			MISE_DATA_DIR: input.toolDataPath,
			MISE_CACHE_DIR: `${input.toolDataPath}/cache`,
			CI: 'true',
			GIT_TERMINAL_PROMPT: '0',
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
			SSH_AUTH_SOCK: undefined,
			GIT_ASKPASS: undefined,
		},
	}));
	const writeResult = useDataWriter('remediationResult', { schema: RemediationResultSchema });

	useTool({
		name: 'submit_remediation_result',
		description: 'Submit the bounded remediation result exactly once after addressing review findings.',
		input: RemediationResultSchema,
		output: RemediationResultSchema,
		run({ data }) {
			writeResult(data);
			return { output: data, terminate: true };
		},
	});

	return [
		'You are Bobsled\'s bounded remediation worker inside the existing disposable Git worktree.',
		'The review is advisory input from an independent provider; trusted policy and repository gates remain authoritative.',
		'Inspect the repository and address only the concrete review findings. Preserve the original task scope and unrelated files.',
		workerNetworkInstruction(input.repository.executionPolicy.workerNetwork),
		'Do not push, commit, create branches, alter remotes, open pull requests, or modify Git configuration.',
		'Never weaken, remove, skip, or rewrite a quality gate to make work pass.',
		'If a finding is invalid or cannot be safely addressed, list it as unresolved instead of making speculative broad changes.',
		'Call submit_remediation_result exactly once. Trusted code will recompute the patch and rerun all required gates.',
		`Base commit: ${input.baseCommit}`,
		`Repository policy: ${JSON.stringify(input.repository)}`,
		`Work item: ${JSON.stringify(input.workItem)}`,
		`Independent review: ${JSON.stringify(input.review)}`,
	].join('\n\n');
}

RemediationWorker.agentName = 'remediation-worker';
RemediationWorker.initialData = RemediationInitialDataSchema;
RemediationWorker.durability = { maxAttempts: 1, timeoutMs: 20 * 60_000 };
