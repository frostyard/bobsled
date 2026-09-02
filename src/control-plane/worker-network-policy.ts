import type { WorkerNetworkPolicy } from './contracts.ts';

export function workerNetworkInstruction(policy: WorkerNetworkPolicy): string {
	if (policy.mode === 'none') {
		return 'Do not use the network. Do not fetch or pull repository remotes.';
	}
	return [
		'Outbound network access is authorized only through credential-free package or module tooling for public dependency version discovery and resolution required by this task.',
		'Do not use general-purpose network clients, access arbitrary services, fetch or pull repository remotes, transmit repository content, or use network access for any unrelated purpose.',
	].join(' ');
}
