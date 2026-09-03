export interface ControlPlaneIdentity {
	provider: 'github' | 'local';
	login?: string;
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function controlPlaneHtml(identity: ControlPlaneIdentity): string {
	const identityLabel = identity.provider === 'github' ? `@${identity.login ?? 'unknown'}` : 'Local operator';
	const identityProvider = identity.provider === 'github' ? 'GitHub' : 'Trusted local';
	return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bobsled Factory</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:#0e1210; color:#e7eadf; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at 20% 0,#253328 0,transparent 32rem),#0e1210; }
    main { width:min(1680px,calc(100% - 32px)); margin:0 auto; padding:34px 0 80px; }
    header { display:flex; align-items:end; justify-content:space-between; gap:24px; margin-bottom:30px; }
    h1 { margin:0; font-size:clamp(2rem,6vw,4.5rem); line-height:.9; letter-spacing:-.07em; }
    h1 span,.status { color:#d5ff55; }
    .eyebrow { color:#9ba893; text-transform:uppercase; letter-spacing:.16em; font-size:.76rem; }
    .header-context { display:grid; justify-items:end; gap:9px; }
    .operator-chip { display:flex; align-items:center; gap:9px; border:1px solid #465148; border-radius:999px; padding:7px 10px; background:#151b17; font-size:.76rem; }
    .operator-chip::before { content:''; width:8px; height:8px; border-radius:50%; background:#6ee7b7; box-shadow:0 0 0 3px #6ee7b722; }
    .operator-provider { color:#8f9b90; text-transform:uppercase; letter-spacing:.08em; font-size:.64rem; }
    .authority-status { margin:-16px 0 18px; border:1px solid #465148; padding:9px 12px; color:#9ba893; font-size:.72rem; }
    .authority-status.within-policy { border-color:#6ee7b7; color:#8ff0c8; }
    .authority-status.exceeds-policy { border-color:#ff887a; color:#ff9b8f; }
    .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,.8fr); gap:18px; }
    .conversation-workspace { display:grid; grid-template-columns:minmax(280px,.8fr) minmax(320px,1.2fr); gap:16px; }
    .chat-log { display:grid; gap:9px; max-height:420px; overflow:auto; margin:12px 0; }
    .chat-turn { border:1px solid #343c36; border-left:3px solid #5fc8ff; background:#0d110f; padding:11px; white-space:pre-wrap; }
    .chat-turn.assistant { border-left-color:#d5ff55; }
    .chat-turn small { display:block; color:#8f9b90; margin-bottom:6px; text-transform:uppercase; }
    .brief-block { border:1px solid #343c36; padding:11px; margin-bottom:9px; }
    .brief-block strong { display:block; color:#d5ff55; margin-bottom:6px; }
    .brief-block p,.brief-block ul { margin:0; white-space:pre-wrap; }
    .panel { border:1px solid #374039; background:rgba(20,25,22,.94); padding:20px; box-shadow:0 18px 60px #0006; }
    .ledger { margin-top:18px; }
    .board-panel { padding:0; overflow:hidden; }
    .board-heading { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px 20px; border-bottom:1px solid #374039; }
    .board-heading h2 { margin:0; }
    .board-guide { margin:12px 16px 0; border:1px solid #343c36; background:#0d110f; }
    .board-guide > summary { cursor:pointer; padding:11px 13px; color:#d5ff55; font-size:.76rem; font-weight:700; }
    .lane-guide-grid { display:grid; grid-template-columns:repeat(6,minmax(170px,1fr)); gap:8px; padding:0 12px 12px; overflow-x:auto; }
    .lane-guide-card { min-width:170px; border:1px solid #303a33; padding:9px; color:#9ea99d; font-size:.7rem; line-height:1.45; }
    .lane-guide-card strong { display:block; color:#e7eadf; margin-bottom:4px; }
    .board-filters { display:flex; gap:9px; flex:1; justify-content:flex-end; }
    .board-filters input { max-width:420px; }
    .board-filters select { width:auto; min-width:190px; }
    .board { display:grid; grid-template-columns:repeat(5,minmax(260px,1fr)); gap:12px; padding:16px; overflow-x:auto; align-items:start; }
    .lane { min-width:260px; background:#0d110f99; border:1px solid #2e3731; border-radius:8px; }
    .lane-header { display:flex; align-items:center; justify-content:space-between; padding:12px 13px; border-bottom:1px solid #2e3731; text-transform:uppercase; letter-spacing:.09em; font-size:.76rem; }
    .lane-header span:first-child::before { content:''; display:inline-block; width:8px; height:8px; border-radius:50%; background:#718077; margin-right:8px; }
    .lane[data-lane=ready] .lane-header span:first-child::before { background:#d5ff55; }
    .lane[data-lane=working] .lane-header span:first-child::before { background:#5fc8ff; }
    .lane[data-lane=review] .lane-header span:first-child::before { background:#bc8cff; }
    .lane[data-lane=delivery] .lane-header span:first-child::before { background:#6ee7b7; }
    .lane[data-lane=attention] .lane-header span:first-child::before { background:#ff887a; }
    .lane-count { color:#899588; border:1px solid #3b453e; border-radius:999px; padding:2px 7px; }
    .lane-cards { display:grid; gap:10px; padding:10px; min-height:90px; }
    .run-card { border:1px solid #3a443d; border-radius:7px; padding:13px; background:#151b17; cursor:pointer; transition:border-color .15s,transform .15s; }
    .run-card:hover,.run-card:focus-visible { border-color:#d5ff55; transform:translateY(-1px); outline:none; }
    .run-card.current { border-color:#d5ff55; box-shadow:0 0 0 1px #d5ff5544; }
    .card-top,.card-metrics { display:flex; gap:7px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .repo-chip,.phase-chip { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:#9eaaa0; }
    .phase-chip { border:1px solid #455047; padding:3px 6px; }
    .run-card h3 { font-size:.96rem; line-height:1.35; margin:11px 0 7px; }
    .card-summary { color:#aab4a7; font-size:.76rem; line-height:1.45; margin:0 0 11px; }
    .card-metrics { justify-content:flex-start; color:#8e9a8c; font-size:.7rem; border-top:1px solid #2f3832; padding-top:9px; }
    .card-attention { color:#ff9b8f; border-left:2px solid #ff887a; padding-left:8px; margin:9px 0; font-size:.74rem; }
    .run-card .toolbar { margin:11px 0 0; }
    .run-card button { padding:7px 9px; font-size:.72rem; }
    button.danger { border-color:#ff887a; color:#ff9b8f; background:transparent; }
    .lane-empty { color:#697568; font-size:.72rem; padding:10px 4px; }
    .history { margin:0 16px 16px; border:1px solid #343c36; }
    .history > summary { cursor:pointer; padding:12px 14px; color:#9ba893; }
    .history-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:10px; padding:10px; }
    .drawer-scrim { position:fixed; inset:0; background:#0009; z-index:50; display:none; }
    .drawer-scrim.open { display:block; }
    .drawer { position:absolute; right:0; top:0; bottom:0; width:min(720px,94vw); background:#111613; border-left:1px solid #4a574d; box-shadow:-30px 0 80px #0009; display:flex; flex-direction:column; }
    .drawer-head { display:flex; align-items:start; justify-content:space-between; gap:20px; padding:20px; border-bottom:1px solid #374039; }
    .drawer-head h2 { margin:5px 0 0; color:#eef2e8; text-transform:none; letter-spacing:0; font-size:1.25rem; }
    .icon-button { padding:6px 9px; min-width:38px; }
    .drawer-body { overflow:auto; padding:20px; flex:1; }
    .drawer-section { border-bottom:1px solid #313a34; padding:0 0 18px; margin:0 0 18px; }
    .drawer-section h3 { margin:0 0 10px; }
    .drawer-section p,.drawer-section pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    .drawer-actions { padding:13px 20px; border-top:1px solid #374039; background:#0d110f; }
    .timeline { display:grid; gap:8px; }
    .timeline-item { border-left:2px solid #465148; padding-left:10px; font-size:.76rem; }
    h2 { margin:0 0 16px; font-size:.9rem; text-transform:uppercase; letter-spacing:.12em; color:#b8c3b3; }
    label { display:grid; gap:7px; margin:13px 0; color:#aeb8aa; font-size:.8rem; }
    input,select,textarea,button { font:inherit; }
    input,select,textarea { width:100%; border:1px solid #48524a; color:#f4f6ed; background:#0d110f; padding:11px; }
    textarea { min-height:140px; resize:vertical; }
    button { border:1px solid #d5ff55; background:#d5ff55; color:#11160f; padding:10px 13px; cursor:pointer; font-weight:700; }
    button.secondary { color:#d5ff55; background:transparent; }
    button:disabled { opacity:.5; cursor:wait; }
    .toolbar { display:flex; flex-wrap:wrap; gap:9px; margin:14px 0; }
    .items { display:grid; gap:9px; margin-top:14px; }
    .item { border:1px solid #343c36; padding:13px; background:#111613; }
    .item.current { border-color:#d5ff55; box-shadow:0 0 0 1px #d5ff5544; }
    .item strong { display:block; margin-bottom:7px; }
    .item small { color:#929d8e; }
    details.review { margin-top:14px; border:1px solid #48524a; background:#0d110f; }
    details.review > summary { cursor:pointer; padding:11px 13px; color:#d5ff55; font-weight:700; }
    .review-body { padding:0 13px 13px; }
    .review-body h3,.review-body h4 { margin:14px 0 8px; }
    .finding { margin-top:10px; border-left:3px solid #758073; padding:9px 11px; background:#151b17; }
    .finding.blocking { border-left-color:#ff887a; }
    .finding p { margin:7px 0; white-space:pre-wrap; }
    .finding .recommendation { color:#d5ff55; }
    .evidence-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin:10px 0; }
    .evidence-cell { border:1px solid #343c36; padding:9px; overflow-wrap:anywhere; }
    .next-action { margin-top:12px; border:1px solid #d5ff55; padding:11px; }
    .notice { margin:0 0 14px; border:1px solid #d5ff55; padding:11px; background:#1b2319; color:#d5ff55; font-weight:700; }
    .compact-list { margin:7px 0; padding-left:22px; }
    .result { min-height:240px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .badge { display:inline-block; border:1px solid #596658; padding:4px 7px; margin:0 6px 8px 0; font-size:.72rem; text-transform:uppercase; }
    .error { color:#ff887a; }
    footer { margin-top:18px; color:#778276; font-size:.72rem; }
    @media(max-width:900px){ .grid,.conversation-workspace{grid-template-columns:1fr} header{align-items:start;flex-direction:column}.header-context{justify-items:start} .board-heading{align-items:stretch;flex-direction:column}.board-filters{justify-content:stretch}.board-filters input{max-width:none}.board{grid-template-columns:repeat(5,82vw)} }
  </style>
</head>
<body>
<main>
  <header><div><div class="eyebrow">Frostyard engineering control plane</div><h1>BOB<span>SLED</span></h1></div><div class="header-context"><div class="eyebrow">M4-B · controlled publication</div><div class="operator-chip" aria-label="Authenticated operator"><span class="operator-provider">${escapeHtml(identityProvider)}</span><strong>${escapeHtml(identityLabel)}</strong></div></div></header>
  <div id="authority-status" class="authority-status">GitHub App authority · loading latest verified installation snapshot…</div>
  <div class="grid">
    <section class="panel">
      <h2>Work intake</h2>
      <label>Repository<select id="repo"></select></label>
      <div class="toolbar"><button class="secondary" id="issues">Load open issues</button><button class="secondary" id="fixtures">Load dry-run fixtures</button></div>
      <div id="items" class="items"></div>
      <form id="manual">
        <label>Manual task title<input id="title" maxlength="500" required placeholder="Describe one bounded change"></label>
        <label>Details<textarea id="body" maxlength="50000" placeholder="Context, desired behavior, constraints, acceptance criteria"></textarea></label>
        <div class="toolbar"><button id="submit">Dry-run triage</button><button type="button" class="secondary" id="start-conversation">Refine in chat</button></div>
      </form>
    </section>
    <section class="panel" id="decision-panel">
      <h2>Current triage decision</h2>
      <div id="result" class="result"><span class="eyebrow">Select a fixture, issue, or enter a task.</span></div>
    </section>
  </div>
  <section class="panel ledger" id="conversation-panel">
    <div class="board-heading"><div><div class="eyebrow">Principal-owned · one repository</div><h2>Conversational intake</h2></div><div id="conversation-status" class="eyebrow">No active conversation</div></div>
    <div class="conversation-workspace">
      <div><div id="conversation-title" class="notice">Choose “Refine in chat” on a task or issue.</div><div id="chat-log" class="chat-log"></div><form id="chat-form"><label>Clarification or correction<textarea id="chat-message" maxlength="20000" placeholder="Add context, answer a question, or correct the live brief"></textarea></label><div class="toolbar"><button id="chat-submit">Revise brief once</button><button type="button" id="chat-finalize">Finalize brief</button><button type="button" class="danger" id="chat-cancel">Cancel conversation</button></div></form></div>
      <div><h2>Live structured brief</h2><div id="live-brief" class="result"><span class="eyebrow">The schema-valid brief will appear here.</span></div></div>
    </div>
  </section>
  <section class="panel ledger board-panel">
    <div class="board-heading"><div><div class="eyebrow">Durable run ledger</div><h2>Factory board</h2></div><div class="board-filters"><input id="board-search" type="search" placeholder="Search runs"><select id="board-repo"><option value="">All repositories</option></select><button class="secondary" id="refresh-runs">Refresh</button></div></div>
    <details class="board-guide"><summary>How lane assignment works</summary><div class="lane-guide-grid">
      <div class="lane-guide-card"><strong>Ready</strong>Admitted run is pending authorization; no later attempt, review, or publication state exists.</div>
      <div class="lane-guide-card"><strong>Working</strong>Implementation attempt is queued/running, including preparation and trusted gates.</div>
      <div class="lane-guide-card"><strong>Review</strong>Adversarial review, remediation, or post-remediation verification is queued/running.</div>
      <div class="lane-guide-card"><strong>Delivery</strong>Review is approved, or draft publication/check processing is active or ready for a human.</div>
      <div class="lane-guide-card"><strong>Attention</strong>A human decision or recovery is required after a policy block, failure, or missing review.</div>
      <div class="lane-guide-card"><strong>History</strong>Run was cancelled or trusted verification proved no change was required.</div>
    </div></details>
    <div id="runs" class="board">
      <section class="lane" data-lane="ready"><div class="lane-header"><span>Ready</span><span class="lane-count">0</span></div><div class="lane-cards"></div></section>
      <section class="lane" data-lane="working"><div class="lane-header"><span>Working</span><span class="lane-count">0</span></div><div class="lane-cards"></div></section>
      <section class="lane" data-lane="review"><div class="lane-header"><span>Review</span><span class="lane-count">0</span></div><div class="lane-cards"></div></section>
      <section class="lane" data-lane="delivery"><div class="lane-header"><span>Delivery</span><span class="lane-count">0</span></div><div class="lane-cards"></div></section>
      <section class="lane" data-lane="attention"><div class="lane-header"><span>Attention</span><span class="lane-count">0</span></div><div class="lane-cards"></div></section>
    </div>
    <details class="history" id="history"><summary>History · <span id="history-count">0</span></summary><div id="history-grid" class="history-grid"></div></details>
  </section>
  <div class="drawer-scrim" id="drawer-scrim"><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div class="drawer-head"><div><div id="drawer-eyebrow" class="eyebrow"></div><h2 id="drawer-title"></h2></div><button id="drawer-close" class="secondary icon-button" aria-label="Close details">×</button></div><div id="drawer-body" class="drawer-body"></div><div id="drawer-actions" class="drawer-actions toolbar"></div></aside></div>
  <footer>Draft publication is policy- and App-gated. Bobsled never force-pushes or merges. Model output is advisory; trusted code binds approved patch bytes, computes Git objects, and tracks checks.</footer>
</main>
<script type="module">
const repo = document.querySelector('#repo');
const items = document.querySelector('#items');
const result = document.querySelector('#result');
const submit = document.querySelector('#submit');
const runs = document.querySelector('#runs');
const boardSearch = document.querySelector('#board-search');
const boardRepo = document.querySelector('#board-repo');
const drawerScrim = document.querySelector('#drawer-scrim');
const drawerBody = document.querySelector('#drawer-body');
const drawerActions = document.querySelector('#drawer-actions');
const authorityStatus = document.querySelector('#authority-status');
const conversationPanel = document.querySelector('#conversation-panel');
const conversationStatus = document.querySelector('#conversation-status');
const conversationTitle = document.querySelector('#conversation-title');
const chatLog = document.querySelector('#chat-log');
const liveBrief = document.querySelector('#live-brief');
const chatSubmit = document.querySelector('#chat-submit');
const chatFinalize = document.querySelector('#chat-finalize');
let activeConversation;
let boardCards = [];
let boardPoll;

function browserUuid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') throw new Error('Secure random values are unavailable in this browser.');
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

async function json(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || ('HTTP ' + response.status));
  return value;
}

function showError(error) {
  result.textContent = '';
  const node = document.createElement('span');
  node.className = 'error';
  node.textContent = error instanceof Error ? error.message : String(error);
  result.append(node);
}

function renderItems(values) {
  items.textContent = '';
  if (!values.length) {
    const empty = document.createElement('div'); empty.className = 'eyebrow'; empty.textContent = 'No open issues.'; items.append(empty); return;
  }
  for (const workItem of values) {
    const card = document.createElement('article'); card.className = 'item';
    const title = document.createElement('strong'); title.textContent = workItem.title;
    const meta = document.createElement('small'); meta.textContent = workItem.key + ' · ' + workItem.source;
    const actions = document.createElement('div'); actions.className = 'toolbar';
    const action = document.createElement('button'); action.className = 'secondary'; action.textContent = 'Triage this'; action.addEventListener('click', () => triage(workItem));
    const converse = document.createElement('button'); converse.textContent = 'Refine in chat'; converse.addEventListener('click', () => startConversation(workItem));
    actions.append(converse, action); card.append(title, meta, actions); items.append(card);
  }
}

function initialBrief(workItem) {
  return {version:1,repositoryId:repo.value,objective:workItem.title,context:workItem.body.trim()?[workItem.body.trim()]:[],acceptanceCriteria:[],constraints:[],nonGoals:[],assumptions:[],unresolvedQuestions:['What should be true when this work is complete?']};
}

function appendBriefBlock(label, value) {
  const block = document.createElement('div'); block.className = 'brief-block'; const title = document.createElement('strong'); title.textContent = label; block.append(title);
  if (Array.isArray(value)) { const list = document.createElement('ul'); for (const item of value) { const row = document.createElement('li'); row.textContent = item; list.append(row); } if (!value.length) { const row = document.createElement('li'); row.textContent = 'None yet'; list.append(row); } block.append(list); }
  else { const body = document.createElement('p'); body.textContent = value; block.append(body); }
  liveBrief.append(block);
}

function renderConversation(conversation, revision, shouldScroll=true, snapshot) {
  activeConversation = conversation; conversationStatus.textContent = snapshot ? 'finalized · immutable snapshot ' + snapshot.briefSha256.slice(0,12) : revision ? 'revision ' + revision.status + ' · conversation version ' + conversation.version : conversation.status + ' · version ' + conversation.version; conversationTitle.textContent = conversation.seed.title; chatLog.textContent = ''; liveBrief.textContent = '';
  if (!conversation.turns.length) { const empty = document.createElement('div'); empty.className = 'eyebrow'; empty.textContent = 'Brief initialized. Add the first clarification below.'; chatLog.append(empty); }
  for (const turn of conversation.turns) { const node = document.createElement('div'); node.className = 'chat-turn ' + turn.role; const role = document.createElement('small'); role.textContent = turn.role + ' · turn ' + turn.sequence; const text = document.createElement('div'); text.textContent = turn.text; node.append(role,text); chatLog.append(node); }
  const brief = conversation.currentBrief; appendBriefBlock('Objective',brief.objective); appendBriefBlock('Context',brief.context); appendBriefBlock('Acceptance criteria',brief.acceptanceCriteria); appendBriefBlock('Constraints',brief.constraints); appendBriefBlock('Non-goals',brief.nonGoals); appendBriefBlock('Assumptions',brief.assumptions); appendBriefBlock('Unresolved questions',brief.unresolvedQuestions);
  if (revision && revision.status === 'failed') { const failure=document.createElement('div');failure.className='error';failure.textContent=revision.error||'The claimed revision failed.';chatLog.append(failure); }
  if (snapshot) { const frozen=document.createElement('div');frozen.className='notice';frozen.textContent='Immutable final brief · '+snapshot.sourceTurnCount+' source turns · triage not yet authorized';liveBrief.prepend(frozen); }
  const busy = revision && ['reserved','running'].includes(revision.status); const active = conversation.status === 'active' && !busy; chatSubmit.disabled = !active; chatFinalize.disabled = !active; document.querySelector('#chat-message').disabled = !active; document.querySelector('#chat-cancel').disabled = !active; if(shouldScroll)conversationPanel.scrollIntoView({behavior:'smooth',block:'start'});
}

async function startConversation(workItem) {
  try { renderConversation(await json('/api/intake-conversations',{method:'POST',headers:{'content-type':'application/json','idempotency-key':browserUuid()},body:JSON.stringify({repositoryId:repo.value,seed:workItem,brief:initialBrief(workItem)})})); }
  catch(error){showError(error);}
}

async function reviseConversation(message) {
  if (!activeConversation) return; chatSubmit.disabled = true; conversationStatus.textContent = 'Codex is revising the brief once…';
  try { const payload=await json('/api/intake-conversations/'+activeConversation.id+'/revisions',{method:'POST',headers:{'content-type':'application/json','idempotency-key':browserUuid()},body:JSON.stringify({expectedVersion:activeConversation.version,message})}); renderConversation(payload.conversation,payload.revision); if(payload.revision.status==='failed')throw new Error(payload.revision.error||'Brief revision failed'); if(payload.revision.status==='succeeded')document.querySelector('#chat-message').value=''; }
  catch(error){conversationStatus.textContent='Revision needs attention';showError(error);chatSubmit.disabled=false;}
}

async function loadLatestConversation() {
  const conversations=await json('/api/intake-conversations'); const latest=conversations.find((conversation)=>conversation.status==='active')||conversations[0]; if(latest){const revisions=await json('/api/intake-conversations/'+latest.id+'/revisions');const snapshot=latest.status==='finalized'?await json('/api/intake-conversations/'+latest.id+'/snapshot'):undefined;renderConversation(latest,revisions.at(-1),false,snapshot);}
}

function renderDecision(payload, workItem) {
  result.textContent = '';
  const decision = payload.decision;
  const notice = document.createElement('div'); notice.className = 'notice'; notice.textContent = 'NEW TRIAGE DECISION · NOT YET ADMITTED'; result.append(notice);
  for (const value of [decision.route, decision.risk, decision.eligibleForOneClick ? 'one-click eligible' : 'human lane']) {
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = value; result.append(badge);
  }
  const heading = document.createElement('h3'); heading.textContent = decision.summary; result.append(heading);
  const rationale = document.createElement('p'); rationale.textContent = decision.rationale; result.append(rationale);
  const criteria = document.createElement('div'); criteria.textContent = 'Acceptance criteria:\n• ' + (decision.acceptanceCriteria.join('\n• ') || 'None supplied'); result.append(criteria);
  if (decision.missingInformation.length) {
    const missing = document.createElement('div'); missing.className = 'error'; missing.textContent = '\nMissing information:\n• ' + decision.missingInformation.join('\n• '); result.append(missing);
  }
  const admitButton = document.createElement('button');
  admitButton.className = 'secondary';
  admitButton.textContent = decision.route === 'ready_for_agent' ? 'Admit ready run' : 'Admit for human approval';
  admitButton.addEventListener('click', () => admit(workItem, decision));
  result.append(document.createElement('br'), document.createElement('br'), admitButton);
  document.querySelector('#decision-panel').scrollIntoView({behavior:'smooth', block:'start'});
}

function renderAdmission(run) {
  result.textContent = '';
  const job = run.jobs[0];
  const awaitingHuman = run.status === 'blocked' && job && job.attempts.length === 0;
  const notice = document.createElement('div'); notice.className = 'notice';
  notice.textContent = awaitingHuman ? 'RUN ADMITTED · AWAITING HUMAN APPROVAL' : 'RUN ADMITTED · READY FOR GO FIX';
  const heading = document.createElement('h3'); heading.textContent = job ? job.workItemSnapshot.title : run.id;
  const detail = document.createElement('p');
  detail.textContent = awaitingHuman
    ? 'This is a deliberate approval checkpoint, not a terminal failure. Open the highlighted run below and choose Human override.'
    : 'The highlighted run below is ready. Go fix this authorizes the bounded implementation attempt and automatic independent review of any successful changed draft.';
  const id = document.createElement('small'); id.textContent = run.id;
  const show = document.createElement('button'); show.className = 'secondary'; show.textContent = 'Show admitted run';
  show.addEventListener('click', () => {
    const card = Array.from(runs.querySelectorAll('[data-run-id]')).find((node) => node.dataset.runId === run.id);
    if (card) card.scrollIntoView({behavior:'smooth', block:'center'});
  });
  result.append(notice, heading, detail, id, document.createElement('br'), document.createElement('br'), show);
}

async function admit(workItem, triageDecision, supersedesRunId) {
  try {
    const payload = { repositoryId:repo.value, workItem, triageDecision };
    if (supersedesRunId) payload.supersedesRunId = supersedesRunId;
    const admitted = await json('/api/runs', { method:'POST', headers:{'content-type':'application/json','idempotency-key':browserUuid()}, body:JSON.stringify(payload) });
    await loadRuns();
    const card = Array.from(runs.querySelectorAll('[data-run-id]')).find((node) => node.dataset.runId === admitted.id);
    if (card) card.classList.add('current');
    renderAdmission(admitted);
    document.querySelector('#decision-panel').scrollIntoView({behavior:'smooth', block:'start'});
  } catch (error) { showError(error); }
}

async function runAction(run, action) {
  const defaultReason = action === 'override' ? 'Human reviewed the model concern and authorizes the next bounded step.' : 'Operator cancelled this run.';
  const reason = window.prompt('Reason (recorded in the audit log):', defaultReason);
  if (!reason) return;
  try {
    await json('/api/runs/' + run.id + '/' + action, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({reason, expectedVersion:run.version}) });
    await loadRuns();
  } catch (error) { showError(error); }
}

async function executeRun(run) {
	const reason = window.prompt('Go fix this authorization (recorded in the audit log):', 'Operator authorizes one bounded local-only implementation attempt followed automatically by mandatory independent review and at most one remediation round.');
	if (!reason) return;
	result.textContent = 'Creating an isolated worktree and running the bounded implementation worker; any successful changed draft will proceed automatically into adversarial review…';
  try {
    const completed = await json('/api/runs/' + run.id + '/execute', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({reason, expectedVersion:run.version}),
    });
		const job = completed.jobs[0];
		const review = job && job.reviews && job.reviews.at(-1);
		const attempt = job && job.attempts.at(-1);
		result.textContent = review
			? 'Implementation and automatic adversarial review settled.\n\n' + JSON.stringify(review.operatorView || review.outcome, null, 2)
			: attempt && attempt.outcome ? JSON.stringify(attempt.outcome, null, 2) : 'Execution settled without outcome evidence.';
    await loadRuns();
  } catch (error) { showError(error); }
}

async function manualReviewRun(run) {
  const reason = window.prompt('Review recovery authorization (recorded in the audit log):', 'Operator starts mandatory review recovery for a historical successful patch that did not enter automatic review.');
  if (!reason) return;
  result.textContent = 'Starting review recovery…';
  try {
    const completed = await json('/api/runs/' + run.id + '/review', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({reason, expectedVersion:run.version}),
    });
    result.textContent = 'Review recovery settled. Open the run card for evidence.';
    await loadRuns();
    const card = boardCards.find((value) => value.id === completed.id); if (card) openDrawer(card);
  } catch (error) { showError(error); }
}

async function preparePublication(run) {
  const reason = window.prompt('Draft publication intent (recorded durably):', 'Operator prepares the approved patch for a draft pull request; repository policy remains authoritative.');
  if (!reason) return;
  try {
    const publication = await json('/api/publications', { method:'POST', headers:{'content-type':'application/json','idempotency-key':browserUuid()}, body:JSON.stringify({runId:run.id, expectedVersion:run.version, reason}) });
    result.textContent = JSON.stringify(publication, null, 2);
    await loadRuns();
  } catch (error) { showError(error); }
}

async function publicationAction(publication, action) {
  try {
    const completed = await json('/api/publications/' + publication.id + '/' + action, { method:'POST' });
    result.textContent = JSON.stringify(completed, null, 2);
    await loadRuns();
  } catch (error) { showError(error); }
}

async function publicationRecoveryAction(card, action) {
  const recovery = card.publicationRecovery;
  const defaults = {
    replay_publication: 'Operator authorizes a zero-model replay of the exact approved patch against the current default branch and current quality gates.',
    review_publication_replay: 'Operator authorizes one fresh read-only adversarial review of the validated replay; the model call cannot be retried after dispatch.',
    promote_publication_replay: 'Operator creates a new immutable draft publication attempt from the freshly approved replay.',
    resolve_publication_supersession: 'Operator records that the later merged pull request delivered this task; the stale publication and failed replay remain immutable.',
  };
  const reason = window.prompt('Recovery authorization (recorded durably):', defaults[action]);
  if (!reason) return;
  let url;
  if (action === 'replay_publication') url = recovery && recovery.rebase && recovery.rebase.status === 'pending'
    ? '/api/publication-recoveries/replays/' + recovery.rebase.id + '/execute' : '/api/publication-recoveries/replays';
  if (action === 'review_publication_replay' && recovery && recovery.rebase) url = recovery.review && recovery.review.status === 'pending'
    ? '/api/publication-recoveries/reviews/' + recovery.review.id + '/execute' : '/api/publication-recoveries/replays/' + recovery.rebase.id + '/reviews';
  if (action === 'promote_publication_replay' && recovery && recovery.review) url = '/api/publication-recoveries/reviews/' + recovery.review.id + '/promote';
  if (action === 'resolve_publication_supersession' && recovery && recovery.supersedingCandidate) url = '/api/publication-recoveries/resolutions';
  if (!url) return showError(new Error('Publication recovery evidence is incomplete. Refresh the board before retrying.'));
  result.textContent = action === 'review_publication_replay' ? 'Running one fresh adversarial review…' : 'Applying the trusted publication recovery transition…';
  try {
    const resuming = url.endsWith('/execute');
    const body = action === 'resolve_publication_supersession'
      ? { sourcePublicationId: card.publication.id, supersedingPublicationId: recovery.supersedingCandidate.publicationId, reason }
      : action === 'replay_publication' && !resuming ? { sourcePublicationId: card.publication.id, reason } : { reason };
    const completed = await json(url, { method:'POST', headers:{'content-type':'application/json','idempotency-key':browserUuid()}, body:JSON.stringify(body) });
    result.textContent = JSON.stringify(completed, null, 2); await loadRuns();
  } catch (error) { showError(error); }
}

function appendList(parent, heading, values) {
  if (!values || !values.length) return;
  const title = document.createElement('h4'); title.textContent = heading; parent.append(title);
  const list = document.createElement('ul'); list.className = 'compact-list';
  for (const value of values) { const item = document.createElement('li'); item.textContent = value; list.append(item); }
  parent.append(list);
}

function appendReviewReport(parent, heading, report) {
  if (!report) return;
  const title = document.createElement('h3'); title.textContent = heading; parent.append(title);
  for (const value of [report.verdict, report.findings.filter((finding) => finding.blocking).length + ' blocking', report.findings.length + ' findings']) {
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = value; parent.append(badge);
  }
  const summary = document.createElement('p'); summary.textContent = report.summary; parent.append(summary);
  for (const finding of report.findings) {
    const node = document.createElement('article'); node.className = 'finding' + (finding.blocking ? ' blocking' : '');
    const findingTitle = document.createElement('strong');
    findingTitle.textContent = finding.id + ' · ' + finding.severity + ' · ' + finding.category + (finding.blocking ? ' · BLOCKING' : '');
    const location = document.createElement('small'); location.textContent = finding.path ? finding.path + (finding.line ? ':' + finding.line : '') : 'No path supplied';
    const findingSummary = document.createElement('p'); findingSummary.textContent = finding.summary;
    const evidence = document.createElement('p'); evidence.textContent = 'Evidence: ' + finding.evidence;
    const remediation = document.createElement('p'); remediation.className = 'recommendation'; remediation.textContent = 'Recommended change: ' + finding.remediation;
    node.append(findingTitle, location, findingSummary, evidence, remediation); parent.append(node);
  }
  appendList(parent, 'Residual risks', report.residualRisks);
  appendList(parent, 'Claims checked', report.testedClaims);
}

function stageRevisedTask(run, review) {
  const job = run.jobs[0];
  if (!job) return;
  const report = review.operatorView && review.operatorView.primaryReport;
  const findings = report ? report.findings.filter((finding) => finding.blocking) : [];
  const guidance = findings.map((finding) => '- ' + finding.summary + '\n  Required: ' + finding.remediation).join('\n');
  document.querySelector('#title').value = job.workItemSnapshot.title;
  document.querySelector('#body').value = job.workItemSnapshot.body + (guidance ? '\n\nAdversarial review findings to address:\n' + guidance : '');
  result.textContent = '';
  const notice = document.createElement('div'); notice.className = 'notice'; notice.textContent = 'REVISED TASK STAGED · NOT YET TRIAGED';
  const instruction = document.createElement('p'); instruction.textContent = 'Edit the populated task, then click Dry-run triage. The resulting decision will replace this message and scroll into view.';
  result.append(notice, instruction);
  document.querySelector('#manual').scrollIntoView({behavior:'smooth', block:'start'});
  document.querySelector('#body').focus();
}

function renderReviewDetails(card, run, review) {
  const view = review.operatorView;
  if (!view) return;
  const details = document.createElement('details'); details.className = 'review'; details.open = review.status === 'blocked' || review.status === 'failed';
  const summary = document.createElement('summary');
  const report = view.primaryReport;
  summary.textContent = 'Historical review ' + review.number + ' · ' + review.status + (report ? ' · ' + report.verdict + ' · ' + report.findings.length + ' findings' : '');
  const body = document.createElement('div'); body.className = 'review-body';
  if (view.error) { const error = document.createElement('p'); error.className = 'error'; error.textContent = view.error; body.append(error); }
  appendReviewReport(body, view.finalReport ? 'Final adversarial verdict' : 'Adversarial verdict', report);
  if (view.remediation) {
    const remediationTitle = document.createElement('h3'); remediationTitle.textContent = 'Automated remediation performed';
    const remediationSummary = document.createElement('p'); remediationSummary.textContent = view.remediation.summary;
    body.append(remediationTitle, remediationSummary);
    appendList(body, 'Changed paths', view.remediation.changedPaths);
    appendList(body, 'Remediation tests', view.remediation.testsRun);
  }
  if (view.initialReport && view.finalReport) {
    const initial = document.createElement('details');
    const initialSummary = document.createElement('summary'); initialSummary.textContent = 'Show initial review (' + view.initialReport.findings.length + ' findings)';
    const initialBody = document.createElement('div'); initialBody.className = 'review-body'; appendReviewReport(initialBody, 'Initial adversarial verdict', view.initialReport);
    initial.append(initialSummary, initialBody); body.append(initial);
  }
  if (view.evidence) {
    const evidenceTitle = document.createElement('h3'); evidenceTitle.textContent = 'Trusted final evidence'; body.append(evidenceTitle);
    const grid = document.createElement('div'); grid.className = 'evidence-grid';
    const cells = [
      ['Patch', view.evidence.filesChanged + ' files · ' + view.evidence.diffLines + ' lines'],
      ['HEAD', view.evidence.headMoved ? 'MOVED' : 'unchanged'],
      ['Protected paths', String(view.evidence.protectedPaths.length)],
      ['Policy violations', String(view.evidence.policyViolations.length)],
      ['Digest', view.evidence.diffSha256],
    ];
    for (const entry of cells) { const cell = document.createElement('div'); cell.className = 'evidence-cell'; const label = document.createElement('small'); label.textContent = entry[0]; const value = document.createElement('div'); value.textContent = entry[1]; cell.append(label, value); grid.append(cell); }
    body.append(grid);
    appendList(body, 'Changed paths', view.evidence.changedPaths);
    appendList(body, 'Quality gates', view.evidence.gates.map((gate) => gate.id + ': ' + gate.status));
    appendList(body, 'Policy violations', view.evidence.policyViolations);
  }
  const next = document.createElement('div'); next.className = 'next-action';
  const nextTitle = document.createElement('strong'); nextTitle.textContent = 'Next safe action: ' + view.nextAction.label;
  const guidance = document.createElement('p'); guidance.textContent = view.nextAction.guidance; next.append(nextTitle, guidance); body.append(next);
  if (view.nextAction.kind === 'start_revised_run') {
    const revise = document.createElement('button'); revise.className = 'secondary'; revise.textContent = 'Revise task from findings'; revise.addEventListener('click', () => stageRevisedTask(run, review)); body.append(revise);
  }
  details.append(summary, body); card.append(details);
}

function formatAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  return Math.floor(seconds / 86400) + 'd';
}

function actionButton(card, action) {
  const button = document.createElement('button');
  button.textContent = action.label;
  if (action.emphasis !== 'primary') button.className = action.emphasis === 'danger' ? 'danger' : 'secondary';
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const run = card.run; const job = run.jobs[0]; const publication = card.publication;
    if (action.kind === 'go_fix') return executeRun(run);
    if (action.kind === 'human_override') return runAction(run, 'override');
    if (action.kind === 'cancel') return runAction(run, 'cancel');
    if (action.kind === 'supersede') return admit(job.workItemSnapshot, job.triageDecision, run.id);
    if (action.kind === 'manual_review') return manualReviewRun(run);
    if (action.kind === 'revise_task') { closeDrawer(); return stageRevisedTask(run, job.reviews.at(-1)); }
    if (action.kind === 'prepare_publication') return preparePublication(run);
    if (action.kind === 'publish_publication' && publication) return publicationAction(publication, 'execute');
    if (action.kind === 'refresh_checks' && publication) return publicationAction(publication, 'refresh-checks');
    if (['replay_publication','review_publication_replay','promote_publication_replay','resolve_publication_supersession'].includes(action.kind)) return publicationRecoveryAction(card, action.kind);
    if (action.kind === 'open_pull_request' && action.url) window.open(action.url, '_blank', 'noopener,noreferrer');
  });
  return button;
}

function renderCard(card) {
  const node = document.createElement('article'); node.className = 'run-card'; node.dataset.runId = card.id; node.tabIndex = 0;
  const top = document.createElement('div'); top.className = 'card-top';
  const repository = document.createElement('span'); repository.className = 'repo-chip'; repository.textContent = card.repositoryId;
  const phase = document.createElement('span'); phase.className = 'phase-chip'; phase.textContent = card.phase;
  top.append(repository, phase);
  const title = document.createElement('h3'); title.textContent = card.title;
  const summary = document.createElement('p'); summary.className = 'card-summary'; summary.textContent = card.summary;
  node.append(top, title, summary);
  if (card.attention) { const attention = document.createElement('div'); attention.className = 'card-attention'; attention.textContent = card.attention; node.append(attention); }
  const metricValues = [];
  if (card.metrics.filesChanged !== undefined) metricValues.push(card.metrics.filesChanged + ' files · ' + card.metrics.diffLines + ' lines');
  if (card.metrics.gatesTotal !== undefined) metricValues.push(card.metrics.gatesPassed + '/' + card.metrics.gatesTotal + ' gates');
  if (card.metrics.findings !== undefined) metricValues.push(card.metrics.blockingFindings + ' blocking · ' + card.metrics.findings + ' findings');
  if (card.metrics.checksTotal !== undefined) metricValues.push(card.metrics.checksPassed + '/' + card.metrics.checksTotal + ' checks');
  if (card.metrics.workerTasksTotal !== undefined) metricValues.push(card.metrics.activeWorkers + ' active · ' + card.metrics.workerTasksSucceeded + '/' + card.metrics.workerTasksTotal + ' worker tasks');
  metricValues.push(formatAge(card.updatedAt));
  const metrics = document.createElement('div'); metrics.className = 'card-metrics';
  for (const value of metricValues) { const item = document.createElement('span'); item.textContent = value; metrics.append(item); }
  node.append(metrics);
  const actions = document.createElement('div'); actions.className = 'toolbar';
  for (const value of card.actions) actions.append(actionButton(card, value));
  if (!card.actions.length) { const details = document.createElement('button'); details.className = 'secondary'; details.textContent = 'Details'; details.addEventListener('click', (event) => { event.stopPropagation(); openDrawer(card); }); actions.append(details); }
  node.append(actions);
  node.addEventListener('click', () => openDrawer(card));
  node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(card); } });
  return node;
}

function drawerSection(titleText) {
  const section = document.createElement('section'); section.className = 'drawer-section';
  const title = document.createElement('h3'); title.textContent = titleText; section.append(title); drawerBody.append(section); return section;
}

function openDrawer(card) {
  const run = card.run; const job = run.jobs[0]; const attempt = job.attempts.at(-1); const review = job.reviews.at(-1); const publication = card.publication;
  document.querySelector('#drawer-eyebrow').textContent = card.repositoryId + ' · ' + card.workItemKey + ' · ' + card.phase;
  document.querySelector('#drawer-title').textContent = card.title;
  drawerBody.textContent = ''; drawerActions.textContent = '';
  const overview = drawerSection('Current state');
  const summary = document.createElement('p'); summary.textContent = card.summary; overview.append(summary);
  for (const value of [card.lane, card.phase, run.status, 'v' + run.version]) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = value; overview.append(badge); }
  if (card.attention) { const warning = document.createElement('p'); warning.className = 'error'; warning.textContent = card.attention; overview.append(warning); }
  const task = drawerSection('Task'); const body = document.createElement('p'); body.textContent = job.workItemSnapshot.body || 'No task details supplied.'; task.append(body);
  if (job.triageDecision) {
    const triage = drawerSection('Triage decision');
    const triageSummary = document.createElement('p'); triageSummary.textContent = job.triageDecision.summary + '\n\n' + job.triageDecision.rationale; triage.append(triageSummary);
    appendList(triage, 'Acceptance criteria', job.triageDecision.acceptanceCriteria); appendList(triage, 'Missing information', job.triageDecision.missingInformation);
  }
  if (attempt) {
    const implementation = drawerSection('Implementation attempt ' + attempt.number);
    const worker = attempt.outcome && attempt.outcome.worker && attempt.outcome.worker.result;
    const implementationSummary = document.createElement('p'); implementationSummary.textContent = (worker && worker.summary) || ('Attempt status: ' + attempt.status); implementation.append(implementationSummary);
    if (worker) { appendList(implementation, 'Worker-reported changed paths', worker.changedPaths); appendList(implementation, 'Focused checks', worker.testsRun); appendList(implementation, 'Notes', worker.notes); }
  }
  if (card.multiWorker) {
    const fanout = drawerSection('Multi-worker plan');
    const fanoutSummary = document.createElement('p'); fanoutSummary.textContent = card.multiWorker.summary; fanout.append(fanoutSummary);
    const budget = card.multiWorker.budget;
    appendList(fanout, 'Budget usage', [
      'Concurrency: ' + budget.concurrentUsed + '/' + budget.concurrentMax,
      'Attempts: ' + budget.attemptsUsed + '/' + budget.attemptsMax,
      'Codex calls: ' + budget.openaiCodexCallsUsed + '/' + budget.openaiCodexCallsMax,
      'Copilot calls: ' + budget.githubCopilotCallsUsed + '/' + budget.githubCopilotCallsMax,
      ...(budget.deadlineAt ? ['Deadline: ' + new Date(budget.deadlineAt).toLocaleString()] : []),
    ]);
    appendList(fanout, 'Worker tasks', card.multiWorker.tasks.map((task) => task.title + ' · ' + task.state + (task.reason ? ' · ' + task.reason : '')));
    appendList(fanout, 'Blocking evidence', card.multiWorker.reasons);
  }
  if (review) { const reviewSection = drawerSection('Independent review'); renderReviewDetails(reviewSection, run, review); }
  if (publication) {
    const delivery = drawerSection('Draft publication');
    const publicationSummary = document.createElement('p'); publicationSummary.textContent = publication.status + (publication.blockedReason ? '\n' + publication.blockedReason : '') + (publication.error ? '\n' + publication.error : ''); delivery.append(publicationSummary);
    appendList(delivery, 'Required checks', publication.requiredCheckNames);
    appendList(delivery, 'Observed checks', publication.checks.map((check) => check.name + ': ' + check.status + (check.conclusion ? ' / ' + check.conclusion : '')));
  }
  if (card.publicationRecovery) {
    const recovery = drawerSection('Stale-base recovery');
    const rebase = card.publicationRecovery.rebase; const replayReview = card.publicationRecovery.review;
    const summary = document.createElement('p');
    summary.textContent = rebase ? 'Replay: ' + rebase.status + (rebase.detail ? '\n' + rebase.detail : '') : 'Replay has not started.';
    recovery.append(summary);
    if (rebase) appendList(recovery, 'Replay evidence', [
      'Model calls: 0',
      'Changed paths: ' + rebase.replayedChangedPaths.length,
      'Gates: ' + rebase.gates.filter((gate) => gate.status === 'passed').length + '/' + rebase.gates.length,
      ...(rebase.blockReason ? ['Block reason: ' + rebase.blockReason] : []),
    ]);
    if (replayReview) appendList(recovery, 'Fresh review', [
      'Status: ' + replayReview.status,
      'Model calls: ' + replayReview.modelCalls,
      ...(replayReview.report ? ['Verdict: ' + replayReview.report.verdict, replayReview.report.summary] : []),
      ...(replayReview.blockReason ? ['Block reason: ' + replayReview.blockReason] : []),
    ]);
    if (card.publicationRecovery.resolution) appendList(recovery, 'Terminal resolution', [
      'Disposition: superseded by a later merged publication',
      'Model calls: 0',
      'GitHub mutations: 0',
      'Reason: ' + card.publicationRecovery.resolution.reason,
    ]);
  }
  const timeline = drawerSection('Audit timeline'); timeline.classList.add('timeline');
  for (const event of run.audit.slice().reverse()) { const item = document.createElement('div'); item.className = 'timeline-item'; item.textContent = event.type + ' · ' + event.actorId + ' · ' + new Date(event.createdAt).toLocaleString(); timeline.append(item); }
  for (const value of card.actions) drawerActions.append(actionButton(card, value));
  drawerScrim.classList.add('open'); document.body.style.overflow = 'hidden'; document.querySelector('#drawer-close').focus();
}

function closeDrawer() { drawerScrim.classList.remove('open'); document.body.style.overflow = ''; }

function renderRuns() {
  const query = boardSearch.value.trim().toLocaleLowerCase(); const repository = boardRepo.value;
  const visible = boardCards.filter((card) => (!repository || card.repositoryId === repository) && (!query || (card.title + ' ' + card.workItemKey + ' ' + card.repositoryId + ' ' + card.phase).toLocaleLowerCase().includes(query)));
  for (const lane of runs.querySelectorAll('.lane')) {
    const laneCards = visible.filter((card) => card.lane === lane.dataset.lane); const container = lane.querySelector('.lane-cards'); container.textContent = ''; lane.querySelector('.lane-count').textContent = String(laneCards.length);
    if (!laneCards.length) { const empty = document.createElement('div'); empty.className = 'lane-empty'; empty.textContent = 'No work in this lane.'; container.append(empty); }
    else for (const card of laneCards) container.append(renderCard(card));
  }
  const history = visible.filter((card) => card.lane === 'history'); document.querySelector('#history-count').textContent = String(history.length);
  const historyGrid = document.querySelector('#history-grid'); historyGrid.textContent = ''; for (const card of history) historyGrid.append(renderCard(card));
}

async function loadRuns() {
  try {
    const board = await json('/api/operator-board'); boardCards = board.cards; renderRuns();
    clearTimeout(boardPoll);
    if (boardCards.some((card) => card.lane === 'working' || card.lane === 'review' || (card.publication && ['running','published','checks_pending'].includes(card.publication.status)))) boardPoll = setTimeout(loadRuns, 5000);
  } catch (error) { showError(error); }
}

async function loadAuthority() {
  try {
    const audit = await json('/api/github-app/authority');
    authorityStatus.classList.remove('within-policy', 'exceeds-policy');
    if (audit.status === 'unobserved') { authorityStatus.textContent = 'GitHub App authority · no verified installation snapshot observed yet.'; return; }
    if (audit.status === 'within_policy') {
      authorityStatus.classList.add('within-policy');
      authorityStatus.textContent = 'GitHub App authority · observed permissions are within the declared capability ceiling.';
      return;
    }
    authorityStatus.classList.add('exceeds-policy');
    const names = audit.excessPermissions.map((permission) => permission.name).join(', ');
    authorityStatus.textContent = 'GitHub App authority needs attention · permissions beyond the declared capability ceiling: ' + names + '.';
  } catch {
    authorityStatus.classList.add('exceeds-policy');
    authorityStatus.textContent = 'GitHub App authority audit unavailable.';
  }
}

async function triage(workItem) {
  submit.disabled = true; result.textContent = 'Triage agent is reasoning…';
  try {
    const payload = await json('/api/triage', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({repositoryId:repo.value, workItem}) });
    renderDecision(payload, workItem);
  } catch (error) { showError(error); }
  finally { submit.disabled = false; }
}

document.querySelector('#issues').addEventListener('click', async () => {
  try { renderItems(await json('/api/repositories/' + repo.value + '/issues')); } catch (error) { showError(error); }
});
document.querySelector('#fixtures').addEventListener('click', async () => {
  try { renderItems(await json('/api/repositories/' + repo.value + '/fixtures')); } catch (error) { showError(error); }
});
document.querySelector('#manual').addEventListener('submit', (event) => {
  event.preventDefault();
  triage({source:'manual', key:'manual:' + browserUuid(), title:document.querySelector('#title').value, body:document.querySelector('#body').value, labels:[]});
});
document.querySelector('#start-conversation').addEventListener('click',()=>{const form=document.querySelector('#manual');if(!form.reportValidity())return;startConversation({source:'manual',key:'manual:'+browserUuid(),title:document.querySelector('#title').value,body:document.querySelector('#body').value,labels:[]});});
document.querySelector('#chat-form').addEventListener('submit',(event)=>{event.preventDefault();const message=document.querySelector('#chat-message').value.trim();if(message)reviseConversation(message);});
document.querySelector('#chat-cancel').addEventListener('click',async()=>{if(!activeConversation)return;const reason=window.prompt('Cancellation reason (recorded durably):','Operator chose to stop refining this brief.');if(!reason)return;try{renderConversation(await json('/api/intake-conversations/'+activeConversation.id+'/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:activeConversation.version,reason})}));}catch(error){showError(error);}});
chatFinalize.addEventListener('click',async()=>{if(!activeConversation)return;const reason=window.prompt('Finalization reason (recorded durably):','Operator confirmed this brief is ready for independent triage.');if(!reason)return;try{const payload=await json('/api/intake-conversations/'+activeConversation.id+'/finalize',{method:'POST',headers:{'content-type':'application/json','idempotency-key':browserUuid()},body:JSON.stringify({expectedVersion:activeConversation.version,reason})});renderConversation(payload.conversation,undefined,true,payload.snapshot);}catch(error){showError(error);}});
document.querySelector('#refresh-runs').addEventListener('click', loadRuns);
boardSearch.addEventListener('input', renderRuns);
boardRepo.addEventListener('change', renderRuns);
document.querySelector('#drawer-close').addEventListener('click', closeDrawer);
drawerScrim.addEventListener('click', (event) => { if (event.target === drawerScrim) closeDrawer(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drawerScrim.classList.contains('open')) closeDrawer(); });

try {
  const repositories = await json('/api/repositories');
  for (const value of repositories) {
    const option = document.createElement('option'); option.value = value.id; option.textContent = value.displayName + ' · ' + value.id; repo.append(option);
    const filterOption = document.createElement('option'); filterOption.value = value.id; filterOption.textContent = value.displayName + ' · ' + value.id; boardRepo.append(filterOption);
  }
  document.querySelector('#fixtures').click();
  await Promise.all([loadRuns(), loadAuthority(), loadLatestConversation()]);
} catch (error) { showError(error); }
</script>
</body>
</html>`;
}
