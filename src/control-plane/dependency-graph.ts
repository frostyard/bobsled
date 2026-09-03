export interface DependencyNode {
	id: string;
	dependsOn: string[];
}

export function dependencyNodeIdsAreUnique(nodes: DependencyNode[]): boolean {
	const ids = nodes.map(({ id }) => id);
	return new Set(ids).size === ids.length;
}

export function dependencyEdgesAreUnique(nodes: DependencyNode[]): boolean {
	return nodes.every(({ dependsOn }) => new Set(dependsOn).size === dependsOn.length);
}

export function dependencyTargetsExist(nodes: DependencyNode[]): boolean {
	const ids = new Set(nodes.map(({ id }) => id));
	return nodes.every(({ dependsOn }) => dependsOn.every((dependency) => ids.has(dependency)));
}

export function dependencyGraphExcludesSelfEdges(nodes: DependencyNode[]): boolean {
	return nodes.every(({ id, dependsOn }) => !dependsOn.includes(id));
}

export function dependencyGraphIsAcyclic(nodes: DependencyNode[]): boolean {
	const dependencies = new Map(nodes.map(({ id, dependsOn }) => [id, dependsOn]));
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

	return nodes.every(({ id }) => visit(id));
}

/** Returns deterministic dependency-first layers while preserving declared node order. */
export function dependencyLayersForNodes(nodes: DependencyNode[]): string[][] {
	const remaining = new Map(nodes.map(({ id, dependsOn }) => [id, new Set(dependsOn)]));
	const layers: string[][] = [];

	while (remaining.size > 0) {
		const ready = nodes.map(({ id }) => id).filter((id) => remaining.has(id) && remaining.get(id)?.size === 0);
		if (ready.length === 0) return [];
		layers.push(ready);
		for (const id of ready) remaining.delete(id);
		for (const dependencies of remaining.values()) {
			for (const id of ready) dependencies.delete(id);
		}
	}

	return layers;
}
