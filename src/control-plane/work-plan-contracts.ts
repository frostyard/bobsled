import * as v from 'valibot';

export const WorkPlanTaskIdSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(64),
	v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Task IDs must be lowercase kebab-case'),
);

export const WorkPlanTaskSchema = v.object({
	id: WorkPlanTaskIdSchema,
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	objective: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	acceptanceCriteria: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
		v.minLength(1),
		v.maxLength(20),
	),
	dependsOn: v.pipe(v.array(WorkPlanTaskIdSchema), v.maxLength(32)),
});

const MultiWorkerPlanObjectSchema = v.object({
	version: v.literal(1),
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	tasks: v.pipe(v.array(WorkPlanTaskSchema), v.minLength(1), v.maxLength(32)),
	assumptions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
	risks: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))), v.maxLength(20)),
});

type MultiWorkerPlanShape = v.InferOutput<typeof MultiWorkerPlanObjectSchema>;

function taskIdsAreUnique(plan: MultiWorkerPlanShape): boolean {
	const ids = plan.tasks.map(({ id }) => id);
	return new Set(ids).size === ids.length;
}

function dependenciesAreUnique(plan: MultiWorkerPlanShape): boolean {
	return plan.tasks.every(({ dependsOn }) => new Set(dependsOn).size === dependsOn.length);
}

function dependenciesExist(plan: MultiWorkerPlanShape): boolean {
	const ids = new Set(plan.tasks.map(({ id }) => id));
	return plan.tasks.every(({ dependsOn }) => dependsOn.every((dependency) => ids.has(dependency)));
}

function excludesSelfDependencies(plan: MultiWorkerPlanShape): boolean {
	return plan.tasks.every(({ id, dependsOn }) => !dependsOn.includes(id));
}

function isAcyclic(plan: MultiWorkerPlanShape): boolean {
	const dependencies = new Map(plan.tasks.map(({ id, dependsOn }) => [id, dependsOn]));
	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(id: string): boolean {
		if (visited.has(id)) return true;
		if (visiting.has(id)) return false;
		visiting.add(id);
		for (const dependency of dependencies.get(id) ?? []) {
			if (!visit(dependency)) return false;
		}
		visiting.delete(id);
		visited.add(id);
		return true;
	}

	return plan.tasks.every(({ id }) => visit(id));
}

export const MultiWorkerPlanSchema = v.pipe(
	MultiWorkerPlanObjectSchema,
	v.check(taskIdsAreUnique, 'Work-plan task IDs must be unique'),
	v.check(dependenciesAreUnique, 'A task cannot repeat a dependency'),
	v.check(dependenciesExist, 'Every dependency must reference a task in the same plan'),
	v.check(excludesSelfDependencies, 'A task cannot depend on itself'),
	v.check(isAcyclic, 'Work-plan dependencies must form an acyclic graph'),
);

export type WorkPlanTask = v.InferOutput<typeof WorkPlanTaskSchema>;
export type MultiWorkerPlan = v.InferOutput<typeof MultiWorkerPlanSchema>;

/**
 * Returns deterministic dependency layers. Tasks in one layer are dependency-ready,
 * but are not yet authorized to run concurrently until file-scope policy is added.
 */
export function dependencyLayers(input: MultiWorkerPlan): string[][] {
	const plan = v.parse(MultiWorkerPlanSchema, input);
	const remaining = new Map(plan.tasks.map(({ id, dependsOn }) => [id, new Set(dependsOn)]));
	const layers: string[][] = [];

	while (remaining.size > 0) {
		const ready = plan.tasks
			.map(({ id }) => id)
			.filter((id) => remaining.has(id) && remaining.get(id)?.size === 0);
		if (ready.length === 0) throw new Error('Validated work plan has no dependency-ready task');
		layers.push(ready);
		for (const id of ready) remaining.delete(id);
		for (const dependencies of remaining.values()) {
			for (const id of ready) dependencies.delete(id);
		}
	}

	return layers;
}
