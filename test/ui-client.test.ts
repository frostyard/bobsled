import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { controlPlaneHtml } from '../src/control-plane/ui/index.ts';

/**
 * The operator interface ships as one module script, so nothing else in the
 * suite executes it. These tests boot that script against a minimal DOM and
 * a stubbed API to catch what a syntax check cannot: a surface that throws on
 * load, a lane that never renders, an action that skips its authorization.
 */

interface StubNode {
	tagName: string;
	children: StubNode[];
	parent?: StubNode;
	attributes: Record<string, string>;
	listeners: Record<string, ((event: unknown) => void)[]>;
	textContent: string;
	className: string;
	value: string;
	disabled: boolean;
	hidden: boolean;
	dataset: Record<string, string>;
	querySelector(selector: string): StubNode | undefined;
	querySelectorAll(selector: string): StubNode[];
	dispatch(type: string, event?: Record<string, unknown>): void;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	append(...items: (StubNode | string)[]): void;
	[key: string]: unknown;
}

function createNode(tagName: string): StubNode {
	const node = {
		tagName: tagName.toLowerCase(),
		children: [] as StubNode[],
		attributes: {} as Record<string, string>,
		listeners: {} as Record<string, ((event: unknown) => void)[]>,
		className: '',
		style: {},
		dataset: {} as Record<string, string>,
		value: '',
		disabled: false,
		hidden: false,
		checked: false,
		scrollTop: 0,
		scrollHeight: 0,
	} as unknown as StubNode;

	Object.defineProperty(node, 'textContent', {
		get(): string { return node.children.map((child) => child.textContent).join(''); },
		set(value: string) { node.children = value === '' ? [] : [textNode(String(value))]; },
	});
	Object.defineProperty(node, 'innerHTML', {
		get(): string { return node.textContent; },
		// Only ever used for the wordmark; treating markup as text is enough.
		set(value: string) { node.children = [textNode(String(value).replace(/<[^>]*>/g, ''))]; },
	});
	Object.defineProperty(node, 'firstChild', { get: () => node.children[0] });
	Object.defineProperty(node, 'lastChild', { get: () => node.children[node.children.length - 1] });
	Object.defineProperty(node, 'childElementCount', { get: () => node.children.filter((child) => child.tagName !== '#text').length });

	node.setAttribute = (name: string, value: string) => {
		node.attributes[name] = String(value);
		if (name === 'class') node.className = String(value);
		if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(value);
		if (name === 'hidden') node.hidden = true;
	};
	node.getAttribute = (name: string) => (name === 'class' ? node.className : node.attributes[name] ?? null);
	node.removeAttribute = (name: string) => { delete node.attributes[name]; if (name === 'hidden') node.hidden = false; };
	node.toggleAttribute = (name: string, force?: boolean) => { if (force) node.setAttribute(name, ''); else node.removeAttribute(name); };
	node.append = (...items: (StubNode | string)[]) => {
		for (const item of items) {
			const child = typeof item === 'string' ? textNode(item) : item;
			child.parent = node;
			node.children.push(child);
		}
	};
	node.prepend = (...items: StubNode[]) => { for (const item of items.reverse()) { item.parent = node; node.children.unshift(item); } };
	node.remove = () => {
		if (!node.parent) return;
		node.parent.children = node.parent.children.filter((child) => child !== node);
		node.parent = undefined;
	};
	node.addEventListener = (type: string, handler: (event: unknown) => void) => {
		(node.listeners[type] ??= []).push(handler);
	};
	node.removeEventListener = () => {};
	node.dispatch = (type: string, event: Record<string, unknown> = {}) => {
		for (const handler of node.listeners[type] ?? []) handler({ preventDefault() {}, stopPropagation() {}, target: node, ...event });
	};
	node.focus = () => {};
	node.closest = () => undefined;
	node.querySelector = (selector: string) => query(node, selector)[0];
	node.querySelectorAll = (selector: string) => query(node, selector);
	node.showModal = () => { node.dataset.open = 'true'; };
	node.close = () => { node.dataset.open = 'false'; node.dispatch('close'); };
	node.scrollIntoView = () => {};
	return node;
}

function textNode(value: string): StubNode {
	const node = { tagName: '#text', children: [], attributes: {}, listeners: {}, className: '' } as unknown as StubNode;
	Object.defineProperty(node, 'textContent', { get: () => value, set: () => {} });
	node.append = () => {};
	node.remove = () => { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); };
	return node;
}

function matches(node: StubNode, compound: string): boolean {
	if (node.tagName === '#text') return false;
	for (const part of compound.match(/(^[a-z]+|#[\w-]+|\.[\w-]+|\[[^\]]+\])/g) ?? []) {
		if (part.startsWith('#')) { if (node.attributes.id !== part.slice(1)) return false; }
		else if (part.startsWith('.')) { if (!node.className.split(/\s+/).includes(part.slice(1))) return false; }
		else if (part.startsWith('[')) {
			const [name, value] = part.slice(1, -1).split('=');
			if (!(name in node.attributes)) return false;
			if (value !== undefined && node.attributes[name] !== value.replace(/^["']|["']$/g, '')) return false;
		} else if (node.tagName !== part) return false;
	}
	return true;
}

function query(root: StubNode, selector: string): StubNode[] {
	const results: StubNode[] = [];
	for (const alternative of selector.split(',')) {
		const compounds = alternative.trim().split(/\s+/);
		let current = [root];
		for (const compound of compounds) {
			const next: StubNode[] = [];
			for (const node of current) collect(node, compound, next);
			current = next;
		}
		for (const node of current) if (!results.includes(node)) results.push(node);
	}
	return results;
}

function collect(node: StubNode, compound: string, into: StubNode[]): void {
	for (const child of node.children) {
		if (matches(child, compound)) into.push(child);
		collect(child, compound, into);
	}
}

interface Harness {
	document: StubNode;
	calls: { url: string; method: string; body: unknown }[];
	flush(): Promise<void>;
	sheet(): StubNode | undefined;
}

async function boot(routes: Record<string, unknown>, path = '/'): Promise<Harness> {
	const html = controlPlaneHtml({ provider: 'local' });
	const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script, 'expected the operator module script');

	const root = createNode('body');
	root.setAttribute('id', '#document');
	for (const [id, tag] of [['app', 'div'], ['surface', 'div'], ['topbar', 'div'], ['toasts', 'div'], ['sheet', 'dialog']] as const) {
		const node = createNode(tag);
		node.setAttribute('id', id);
		root.append(node);
	}
	const calls: Harness['calls'] = [];
	const store = new Map<string, string>();

	const context: Record<string, unknown> = {
		console,
		setTimeout: () => 0,
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
		localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
		sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		location: { pathname: path, search: '', assign: () => {} },
		history: { pushState() {}, replaceState() {} },
		document: Object.assign(root, {
			createElement: createNode,
			addEventListener: () => {},
			title: '',
		}),
		fetch: async (url: string, options: { method?: string; body?: string } = {}) => {
			calls.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
			const key = (options.method ?? 'GET') + ' ' + url.split('?')[0];
			const value = routes[key] ?? routes[url.split('?')[0]];
			if (value === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not stubbed: ' + key }) };
			return { ok: true, status: 200, text: async () => JSON.stringify(value) };
		},
	};
	context.addEventListener = () => {};
	context.window = context;
	context.globalThis = context;
	vm.createContext(context);
	new vm.Script(`(async () => {${script}})()`).runInContext(context);
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));

	return {
		document: root,
		calls,
		flush: async () => { for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve)); },
		sheet: () => root.querySelector('#sheet'),
	};
}

const repositories = [{ id: 'frostyard/clix', displayName: 'clix', readOnly: true }];

function card(overrides: Record<string, unknown> = {}) {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		repositoryId: 'frostyard/clix', workItemKey: 'clix#214',
		title: 'Normalize exit codes when the config file is missing',
		lane: 'ready', phase: 'waiting on you',
		summary: 'One attempt, then it gets reviewed automatically.',
		updatedAt: new Date().toISOString(),
		metrics: {},
		actions: [{ kind: 'go_fix', label: 'Start work', emphasis: 'primary' }],
		run: { id: '11111111-1111-4111-8111-111111111111', status: 'pending', version: 3, audit: [], jobs: [{ id: 'job', repositoryId: 'frostyard/clix', workItemSnapshot: { key: 'clix#214', title: 'x', body: 'y' }, attempts: [], reviews: [], triageDecision: { route: 'ready_for_agent', risk: 'low', summary: 's', rationale: 'r', acceptanceCriteria: [], missingInformation: [] } }] },
		...overrides,
	};
}

test('the board boots and renders every lane with its name and definition', async () => {
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/operator-board': { generatedAt: new Date().toISOString(), cards: [card()] },
	});
	const lanes = harness.document.querySelectorAll('.lane');
	assert.equal(lanes.length, 5);
	const text = harness.document.textContent;
	for (const name of ['Ready', 'Working', 'Checking', 'Shipping', 'Needs you']) assert.ok(text.includes(name), 'missing lane ' + name);
	assert.ok(text.includes('Waiting for you to say go.'), 'lane definitions must be visible, not collapsed');
	assert.ok(text.includes('Normalize exit codes'), 'the card should render');
	assert.ok(text.includes('Start work'), 'the card should offer its action');
});

test('an empty lane says what being empty means', async () => {
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/operator-board': { generatedAt: new Date().toISOString(), cards: [] },
	});
	assert.ok(harness.document.textContent.includes('Nothing is stuck.'));
	assert.ok(harness.document.textContent.includes('Nothing waiting on you.'));
});

test('the Access surface shows repository alignment and bounded drift findings', async () => {
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/github-app/authority': { status: 'within_policy', excessPermissions: [] },
		'/api/github-app/status': { configured: true, webhooks: { total: 4 } },
		'/api/observability/status': { total: 12, storedBytes: 1024 },
		'/api/operations/fleet': { organization: { workload: { pendingRuns: 2, activeRuns: 1, activeAttempts: 1, activeReviews: 0, activePublications: 0 }, concurrencyLimitConfigured: true, enforcementMode: 'disabled', capacityPolicy: { version: 2, maxActiveWorkflows: 4, providerConcurrentCalls: { openaiCodex: 2, githubCopilot: 1 } }, capacityUsage: { activeWorkflows: 1, providerCalls: { openaiCodex: 1, githubCopilot: 0 }, wouldExceedPolicyClaims: 0, expiredClaims: 0, ambiguousClaims: 0 }, multiWorkerQuota: { activePlans: 1, activeAttempts: 1, workerAttempts: { used: 2, declared: 4 }, subscriptionCalls: { openaiCodex: { used: 1, declared: 3 }, githubCopilot: { used: 0, declared: 1 } } } }, observability: { retentionMode: 'indefinite' }, repositories: [] },
		'/api/repositories/drift': [{
			repositoryId: 'frostyard/clix', status: 'drifted', checkedAt: new Date().toISOString(),
			policyDigest: 'a'.repeat(64),
			policy: { enabled: true, readOnly: true, executionEnabled: true, reviewEnabled: true, publicationEnabled: false, multiWorkerEnabled: false },
			findings: [{ kind: 'default_branch', expected: 'main', observed: 'trunk' }],
		}],
	}, '/access');

	assert.match(harness.document.textContent, /frostyard\/clix/);
	assert.match(harness.document.textContent, /read only · v1 · drift found · default branch/);
	assert.match(harness.document.textContent, /Check repository drift/);
	assert.match(harness.document.textContent, /Find installed repositories/);
	assert.match(harness.document.textContent, /Fleet capacity/);
	assert.match(harness.document.textContent, /Organization ceiling4 workflows/);
	assert.match(harness.document.textContent, /Enforcementobserve only/);
	assert.match(harness.document.textContent, /Update limits/);
	assert.match(harness.document.textContent, /Worker attempts2 \/ 4/);
	assert.equal(harness.calls.some(({ url }) => url === '/api/repositories/drift'), true);
});

test('expired capacity claims require explicit ambiguity recovery', async () => {
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/github-app/authority': { status: 'within_policy', excessPermissions: [] },
		'/api/operations/fleet': { organization: { workload: { pendingRuns: 0, activeRuns: 0, activeAttempts: 0, activeReviews: 0, activePublications: 0 }, concurrencyLimitConfigured: true, enforcementMode: 'disabled', capacityPolicy: { version: 1, maxActiveWorkflows: 4, providerConcurrentCalls: { openaiCodex: 2, githubCopilot: 1 } }, capacityUsage: { activeWorkflows: 1, providerCalls: { openaiCodex: 1, githubCopilot: 0 }, wouldExceedPolicyClaims: 0, expiredClaims: 1, ambiguousClaims: 0 }, multiWorkerQuota: { activePlans: 0, activeAttempts: 0, workerAttempts: { used: 0, declared: 0 }, subscriptionCalls: { openaiCodex: { used: 0, declared: 0 }, githubCopilot: { used: 0, declared: 0 } } } }, observability: { retentionMode: 'indefinite' }, repositories: [] },
		'/api/repositories/drift': [], '/api/repository-enrollments': [],
	}, '/access');
	const button = harness.document.querySelectorAll('.btn').find((node) => node.textContent === 'Reconcile expired claims');
	assert.ok(button);
	button.dispatch('click'); await harness.flush();
	assert.equal(harness.sheet()?.dataset.open,'true');
	assert.match(harness.sheet()!.textContent,/cannot authorize a second provider call/);
	assert.equal(harness.calls.some(({url}) => url === '/api/operations/capacity-claims/recover-expired'),false);
});

test('capacity enforcement requires a separate explicit authorization sheet',async()=>{
	const harness=await boot({
		'/api/repositories':repositories,
		'/api/github-app/authority':{status:'within_policy',excessPermissions:[]},
		'/api/operations/fleet':{organization:{workload:{pendingRuns:0,activeRuns:0,activeAttempts:0,activeReviews:0,activePublications:0},concurrencyLimitConfigured:true,enforcementMode:'disabled',capacityPolicy:{version:1,maxActiveWorkflows:4,providerConcurrentCalls:{openaiCodex:2,githubCopilot:1}},capacityUsage:{activeWorkflows:0,providerCalls:{openaiCodex:0,githubCopilot:0},wouldExceedPolicyClaims:0,expiredClaims:0,ambiguousClaims:0},multiWorkerQuota:{activePlans:0,activeAttempts:0,workerAttempts:{used:0,declared:0},subscriptionCalls:{openaiCodex:{used:0,declared:0},githubCopilot:{used:0,declared:0}}}},observability:{retentionMode:'indefinite'},repositories:[]},
		'/api/repositories/drift':[],'/api/repository-enrollments':[],
	},'/access');
	const button=harness.document.querySelectorAll('.btn').find((node)=>node.textContent==='Enable enforcement');assert.ok(button);button.dispatch('click');await harness.flush();
	assert.equal(harness.sheet()?.dataset.open,'true');assert.match(harness.sheet()!.textContent,/Reject new provider claims atomically/);assert.match(harness.sheet()!.textContent,/still cannot do/i);
	assert.equal(harness.calls.some(({url})=>url==='/api/operations/capacity-enforcement'),false);
});

test('a durable action opens the authorization sheet and does not fire until it is confirmed', async () => {
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/operator-board': { generatedAt: new Date().toISOString(), cards: [card()] },
	});
	const start = harness.document.querySelectorAll('.card .btn').find((node) => node.textContent === 'Start work');
	assert.ok(start, 'expected the Start work button');
	start.dispatch('click');
	await harness.flush();

	const sheet = harness.sheet();
	assert.equal(sheet?.dataset.open, 'true', 'the sheet must open');
	const sheetText = sheet!.textContent;
	assert.ok(sheetText.includes('Start work on this?'));
	assert.ok(sheetText.includes('What this lets it do'));
	assert.ok(sheetText.includes('What it still cannot do'));
	assert.ok(sheetText.includes('Touch GitHub at all'), 'the sheet must state what it cannot do');
	assert.equal(harness.calls.filter((call) => call.url.includes('/execute')).length, 0, 'nothing may run before confirmation');

	sheet!.querySelectorAll('.btn').find((node) => node.textContent === 'Never mind')!.dispatch('click');
	await harness.flush();
	assert.equal(harness.calls.filter((call) => call.url.includes('/execute')).length, 0, 'dismissing must not run anything');
});

test('confirming sends the reason the operator typed', async () => {
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/operator-board': { generatedAt: new Date().toISOString(), cards: [card()] },
		'POST /api/runs/11111111-1111-4111-8111-111111111111/execute': { id: '11111111-1111-4111-8111-111111111111', jobs: [] },
	});
	harness.document.querySelectorAll('.card .btn').find((node) => node.textContent === 'Start work')!.dispatch('click');
	await harness.flush();
	const sheet = harness.sheet()!;
	const reason = sheet.querySelector('#sheet-reason')!;
	reason.value = 'LGTM';
	sheet.querySelectorAll('.btn').find((node) => node.textContent === 'Start work')!.dispatch('click');
	await harness.flush();

	const executed = harness.calls.find((call) => call.url.includes('/execute'));
	assert.ok(executed, 'confirming must run the action');
	assert.equal((executed.body as { reason: string }).reason, 'LGTM');
	assert.equal((executed.body as { expectedVersion: number }).expectedVersion, 3);
});

test('archiving a terminal card is explicit and posts the optimistic run version', async () => {
	const archived = card({
		lane: 'attention', phase: 'review said no',
		actions: [{ kind: 'archive', label: 'Archive', emphasis: 'secondary' }],
		run: { ...card().run, status: 'blocked', version: 7 },
	});
	const harness = await boot({
		'/api/repositories': repositories,
		'/api/operator-board': { generatedAt: new Date().toISOString(), cards: [archived] },
		'POST /api/runs/11111111-1111-4111-8111-111111111111/archive': { ...archived.run, version: 8 },
	});
	harness.document.querySelectorAll('.card .btn').find((node) => node.textContent === 'Archive')!.dispatch('click');
	await harness.flush();
	assert.equal(harness.calls.filter(({ url }) => url.endsWith('/archive')).length, 0, 'archive must wait for explicit confirmation');
	const sheet = harness.sheet()!;
	assert.ok(sheet.textContent.includes('Stop browser notifications for this run'));
	sheet.querySelectorAll('.btn').find((node) => node.textContent === 'Archive it')!.dispatch('click');
	await harness.flush();
	const request = harness.calls.find(({ url }) => url.endsWith('/archive'))!;
	assert.deepEqual(request.body, { reason: 'Archive this run — no note given.', expectedVersion: 7 });
});

test('an unknown address explains itself instead of rendering an empty board', async () => {
	const harness = await boot({ '/api/repositories': repositories }, '/nonsense');
	assert.ok(harness.document.textContent.includes('There is nothing at this address.'));
});

test('a failing board reports it inline rather than silently emptying the page', async () => {
	const harness = await boot({ '/api/repositories': repositories });
	assert.ok(harness.document.textContent.includes('That did not work.'), 'the board error slot should explain the failure');
});
