import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryContractSchema, RepositoryPolicySnapshotSchema } from './contracts.ts';

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const WorkloadSchema = v.object({ pendingRuns: CountSchema, activeRuns: CountSchema, activeAttempts: CountSchema, activeReviews: CountSchema, activePublications: CountSchema });
const MultiWorkerQuotaSchema = v.object({ activePlans: CountSchema, activeAttempts: CountSchema, workerAttempts: v.object({ used: CountSchema, declared: CountSchema }), subscriptionCalls: v.object({ openaiCodex: v.object({ used: CountSchema, declared: CountSchema }), githubCopilot: v.object({ used: CountSchema, declared: CountSchema }) }) });
export const FleetOperationsViewSchema = v.object({
	generatedAt: v.string(),
	organization: v.object({ workload: WorkloadSchema, concurrencyLimitConfigured: v.literal(false), multiWorkerQuota: MultiWorkerQuotaSchema }),
	repositories: v.array(v.object({ repositoryId: RepositoryContractSchema.entries.id, enabled: v.boolean(), workload: WorkloadSchema, multiWorkerQuota: MultiWorkerQuotaSchema })),
	observability: v.object({ events: CountSchema, storedBytes: CountSchema, oldestObservedAt: v.optional(v.string()), lastObservedAt: v.optional(v.string()), retentionMode: v.literal('indefinite') }),
});
export type FleetOperationsView = v.InferOutput<typeof FleetOperationsViewSchema>;

const zeroWorkload = () => ({ pendingRuns: 0, activeRuns: 0, activeAttempts: 0, activeReviews: 0, activePublications: 0 });
const zeroQuota = () => ({ activePlans: 0, activeAttempts: 0, workerAttempts: { used: 0, declared: 0 }, subscriptionCalls: { openaiCodex: { used: 0, declared: 0 }, githubCopilot: { used: 0, declared: 0 } } });

interface WorkloadRow { repository_id: string; pending_runs: number; active_runs: number; active_attempts: number; active_reviews: number; active_publications: number }
interface BudgetRow { repository_id: string; policy_json: string; attempts_used: number; active_attempts: number; codex_used: number; copilot_used: number }

export class FleetOperationsProjector {
	#db: Database.Database | undefined;
	readonly #path: string;
	readonly #now: () => Date;
	constructor(path = dataPath('bobsled.db'), now: () => Date = () => new Date()) { this.#path = path; this.#now = now; }
	close(): void { this.#db?.close(); this.#db = undefined; }

	#database(): Database.Database {
		if (!this.#db) {
			this.#db = new Database(this.#path, { readonly: true, fileMustExist: true });
			this.#db.pragma('busy_timeout = 5000');
		}
		return this.#db;
	}

	project(input: readonly unknown[]): FleetOperationsView {
		const repositories = input.map((repository) => v.parse(RepositoryPolicySnapshotSchema, repository));
		const db = this.#database();
		return db.transaction(() => {
			const workloadRows = db.prepare(`SELECT j.repository_id,
				COUNT(DISTINCT CASE WHEN r.status='pending' THEN r.id END) AS pending_runs,
				COUNT(DISTINCT CASE WHEN r.status='active' THEN r.id END) AS active_runs,
				COUNT(DISTINCT CASE WHEN a.status IN ('queued','running') THEN a.id END) AS active_attempts,
				COUNT(DISTINCT CASE WHEN rv.status IN ('queued','running') THEN rv.id END) AS active_reviews,
				COUNT(DISTINCT CASE WHEN dp.status IN ('pending','running','published','checks_pending') THEN dp.id END) AS active_publications
				FROM jobs j JOIN runs r ON r.id=j.run_id
				LEFT JOIN attempts a ON a.job_id=j.id LEFT JOIN reviews rv ON rv.job_id=j.id LEFT JOIN draft_publications dp ON dp.run_id=r.id
				GROUP BY j.repository_id`).all() as WorkloadRow[];
			const workloadByRepository = new Map(workloadRows.map((row) => [row.repository_id, { pendingRuns: row.pending_runs, activeRuns: row.active_runs, activeAttempts: row.active_attempts, activeReviews: row.active_reviews, activePublications: row.active_publications }]));
			const budgetRows = db.prepare(`SELECT j.repository_id,b.policy_json,
				COUNT(a.id) AS attempts_used,COALESCE(SUM(CASE WHEN a.status IN ('preparing','running') THEN 1 ELSE 0 END),0) AS active_attempts,
				COALESCE(SUM(CASE WHEN a.provider='openai-codex' AND a.model_calls=1 THEN 1 ELSE 0 END),0) AS codex_used,
				COALESCE(SUM(CASE WHEN a.provider='github-copilot' AND a.model_calls=1 THEN 1 ELSE 0 END),0) AS copilot_used
				FROM multi_worker_budgets b JOIN multi_worker_plans p ON p.id=b.plan_id JOIN jobs j ON j.id=p.job_id
				LEFT JOIN multi_worker_budget_attempts a ON a.plan_id=b.plan_id WHERE b.deadline_at>? GROUP BY b.plan_id,j.repository_id,b.policy_json`).all(this.#now().toISOString()) as BudgetRow[];
			const quotaByRepository = new Map<string, ReturnType<typeof zeroQuota>>();
			for (const row of budgetRows) {
				const policy = v.parse(RepositoryContractSchema.entries.multiWorkerPolicy, JSON.parse(row.policy_json));
				const quota = quotaByRepository.get(row.repository_id) ?? zeroQuota();
				quota.activePlans += 1; quota.activeAttempts += row.active_attempts; quota.workerAttempts.used += row.attempts_used; quota.workerAttempts.declared += policy.maxWorkerAttempts;
				quota.subscriptionCalls.openaiCodex.used += row.codex_used; quota.subscriptionCalls.openaiCodex.declared += policy.subscriptionCalls.openaiCodex;
				quota.subscriptionCalls.githubCopilot.used += row.copilot_used; quota.subscriptionCalls.githubCopilot.declared += policy.subscriptionCalls.githubCopilot;
				quotaByRepository.set(row.repository_id, quota);
			}
			const projected = repositories.map((repository) => ({ repositoryId: repository.id, enabled: repository.enabled, workload: workloadByRepository.get(repository.id) ?? zeroWorkload(), multiWorkerQuota: quotaByRepository.get(repository.id) ?? zeroQuota() }));
			const organization = { workload: zeroWorkload(), concurrencyLimitConfigured: false as const, multiWorkerQuota: zeroQuota() };
			for (const repository of projected) {
				for (const key of Object.keys(organization.workload) as Array<keyof typeof organization.workload>) organization.workload[key] += repository.workload[key];
				organization.multiWorkerQuota.activePlans += repository.multiWorkerQuota.activePlans; organization.multiWorkerQuota.activeAttempts += repository.multiWorkerQuota.activeAttempts;
				organization.multiWorkerQuota.workerAttempts.used += repository.multiWorkerQuota.workerAttempts.used; organization.multiWorkerQuota.workerAttempts.declared += repository.multiWorkerQuota.workerAttempts.declared;
				for (const provider of ['openaiCodex','githubCopilot'] as const) { organization.multiWorkerQuota.subscriptionCalls[provider].used += repository.multiWorkerQuota.subscriptionCalls[provider].used; organization.multiWorkerQuota.subscriptionCalls[provider].declared += repository.multiWorkerQuota.subscriptionCalls[provider].declared; }
			}
			const observation = db.prepare('SELECT COUNT(*) AS events,COALESCE(SUM(length(payload_blob)+length(payload_json)),0) AS stored_bytes,MIN(event_timestamp) AS oldest,MAX(event_timestamp) AS latest FROM flue_observations').get() as { events: number; stored_bytes: number; oldest: string | null; latest: string | null };
			return v.parse(FleetOperationsViewSchema, { generatedAt: this.#now().toISOString(), organization, repositories: projected, observability: { events: observation.events, storedBytes: observation.stored_bytes, oldestObservedAt: observation.oldest ?? undefined, lastObservedAt: observation.latest ?? undefined, retentionMode: 'indefinite' } });
		})();
	}
}

export const fleetOperationsProjector = new FleetOperationsProjector();
