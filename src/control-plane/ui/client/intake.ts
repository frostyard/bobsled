export const intakeSource = String.raw`
/* ---------- intake ---------- */
// Four steps: pick a task, talk it through, lock it in, queue it up.
// Locking runs the independent check straight away -- you see the verdict
// before anything is queued, and queueing stays a separate decision.

const intake = {
  conversation: undefined,
  revision: undefined,
  snapshot: undefined,
  triage: undefined,
  admission: undefined,
  source: 'issues',
  items: [],
  selected: undefined,
  busy: false,
};

function stepStates() {
  const conversation = intake.conversation;
  const locked = Boolean(intake.snapshot);
  const checked = Boolean(intake.triage && intake.triage.status === 'succeeded');
  const queued = Boolean(intake.admission);
  return [
    { n: 1, name: 'Pick a task', state: conversation ? 'done' : 'now' },
    { n: 2, name: 'Talk it through', state: !conversation ? 'todo' : locked ? 'done' : 'now' },
    { n: 3, name: 'Lock it in', state: !locked ? 'todo' : checked ? 'done' : 'now' },
    { n: 4, name: 'Queue it up', state: queued ? 'done' : checked ? 'now' : 'todo' },
  ];
}

async function intakeSurface(surface) {
  setTopbar([
    el('div', { class: 'crumbs' }, [el('b', { text: 'Intake' }), el('span', { id: 'intake-crumb', text: '' })]),
    el('div', { class: 'stat spacer', id: 'intake-turns', text: 'no conversation yet' }),
    el('div', { class: 'stat', text: 'each reply costs one Codex call' }),
  ]);

  const stepper = el('div', { class: 'stepper', id: 'stepper' });
  const triptych = el('div', { class: 'triptych' }, [
    el('div', { class: 'col-pane', id: 'pane-source' }),
    el('div', { class: 'col-pane', id: 'pane-chat' }),
    el('div', { class: 'col-pane', id: 'pane-brief' }),
  ]);
  surface.append(stepper, triptych);

  await loadLatestConversation();
  const draft = new URLSearchParams(location.search).get('draft');
  if (draft) applyDraft();
  paintIntake();
  return undefined;
}

function applyDraft() {
  const raw = sessionStorage.getItem('bobsled.draft');
  if (!raw) return;
  sessionStorage.removeItem('bobsled.draft');
  try {
    const draft = JSON.parse(raw);
    intake.source = 'manual';
    intake.draft = draft;
    if (draft.repositoryId) setScope(draft.repositoryId);
  } catch { /* a malformed draft is not worth an error surface */ }
}

async function loadLatestConversation() {
  try {
    const conversations = await json('/api/intake-conversations');
    const latest = conversations.find((entry) => entry.status === 'active') || conversations[0];
    if (!latest) return;
    intake.conversation = latest;
    const revisions = await json('/api/intake-conversations/' + latest.id + '/revisions');
    intake.revision = revisions.slice(-1)[0];
    if (latest.status === 'finalized') {
      intake.snapshot = await json('/api/intake-conversations/' + latest.id + '/snapshot');
      intake.triage = await json('/api/intake-conversations/' + latest.id + '/snapshot/triage');
      if (intake.triage) intake.admission = await json('/api/intake-conversations/' + latest.id + '/snapshot/admission');
    }
  } catch (error) { fail(error); }
}

function paintIntake() {
  paintStepper();
  paintSourcePane();
  paintChatPane();
  paintBriefPane();
  const crumb = document.querySelector('#intake-crumb');
  if (crumb) crumb.textContent = intake.conversation ? ' · ' + intake.conversation.seed.key : '';
  const turns = document.querySelector('#intake-turns');
  if (turns) turns.textContent = intake.conversation ? intake.conversation.turns.length + ' messages so far' : 'no conversation yet';
}

function paintStepper() {
  const stepper = clear(document.querySelector('#stepper'));
  const steps = stepStates();
  steps.forEach((step, index) => {
    stepper.append(el('div', { class: 'step', 'data-state': step.state }, [
      el('b', { text: step.state === 'done' ? '✓' : String(step.n) }),
      el('span', { text: step.name }),
    ]));
    if (index < steps.length - 1) stepper.append(el('span', { class: 'step-sep', text: '›' }));
  });
}

/* ---------- source pane ---------- */

function paintSourcePane() {
  const pane = clear(document.querySelector('#pane-source'));

  // A brief is bound to exactly one repository for its whole life, so the
  // choice has to be made on purpose rather than defaulted to whichever
  // repository happens to be first.
  if (!state.scope) {
    pane.append(
      el('div', { class: 'pane-head' }, [el('h2', { text: 'Where it came from' })]),
      el('div', { class: 'pane-body' }, [
        el('div', { class: 'gate-note' }, [
          el('b', { text: 'Pick one repository first. ' }),
          el('span', { text: 'A brief belongs to a single repository from the moment it starts, and that cannot change later.' }),
        ]),
        el('div', { style: 'display:grid;gap:6px' }, state.repositories.map((repository) => el('button', {
          class: 'srcitem', type: 'button', onclick: () => { setScope(repository.id); paintIntake(); },
        }, [
          el('strong', { text: repository.displayName || repository.id }),
          el('em', { text: repository.id + (repository.readOnly ? ' · read only' : '') }),
        ]))),
      ]),
    );
    return;
  }

  const seg = el('div', { class: 'seg' }, [
    el('button', { type: 'button', text: 'Open issues', 'aria-pressed': String(intake.source === 'issues'), onclick: () => { intake.source = 'issues'; loadIssues(); } }),
    el('button', { type: 'button', text: 'Just type it', 'aria-pressed': String(intake.source === 'manual'), onclick: () => { intake.source = 'manual'; paintSourcePane(); } }),
  ]);
  const body = el('div', { class: 'pane-body' }, [seg]);
  pane.append(
    el('div', { class: 'pane-head' }, [el('h2', { text: 'Where it came from' })]),
    body,
  );

  if (intake.source === 'manual') {
    const draft = intake.draft || {};
    const title = el('input', { type: 'text', id: 'manual-title', maxlength: '500', placeholder: 'One sentence: what should change?', value: draft.title || '' });
    const detail = el('textarea', { id: 'manual-body', maxlength: '50000', rows: '7', placeholder: 'Anything that helps: current behaviour, what you want instead, constraints.' }, []);
    detail.value = draft.body || '';
    body.append(
      el('label', { class: 'fieldlabel', for: 'manual-title', text: 'The task' }), title,
      el('label', { class: 'fieldlabel', for: 'manual-body', text: 'Details' }), detail,
      el('div', { class: 'inline-error', id: 'source-error', role: 'alert' }),
      el('div', { class: 'btnrow' }, [
        el('button', { class: 'btn primary', text: 'Talk it through', onclick: () => startFromManual(title.value, detail.value) }),
      ]),
    );
    return;
  }

  body.append(el('div', { class: 'inline-error', id: 'source-error', role: 'alert' }));
  const holder = el('div', { style: 'display:grid;gap:8px' });
  body.append(holder);
  if (!intake.items.length) {
    holder.append(el('div', { class: 'lane-empty', text: 'Load the open issues for this repository.' }));
    body.append(el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Load open issues', onclick: loadIssues })]));
    return;
  }
  for (const item of intake.items) {
    holder.append(el('button', {
      class: 'srcitem', type: 'button',
      'aria-current': String(Boolean(intake.selected && intake.selected.key === item.key)),
      onclick: () => { intake.selected = item; startFromItem(item); },
    }, [
      el('strong', { text: item.title }),
      el('em', { text: item.key + (item.labels && item.labels.length ? ' · ' + item.labels.join(', ') : '') }),
    ]));
  }
}

async function loadIssues() {
  intake.source = 'issues';
  const scope = state.scope;
  if (!scope) return;
  paintSourcePane();
  try {
    intake.items = await json('/api/repositories/' + scope + '/issues');
    paintSourcePane();
  } catch (error) { fail(error, document.querySelector('#source-error')); }
}

function initialBrief(workItem, repositoryId) {
  const body = (workItem.body || '').trim();
  return {
    version: 1, repositoryId: repositoryId,
    objective: workItem.title,
    context: body ? [body] : [],
    acceptanceCriteria: [], constraints: [], nonGoals: [], assumptions: [],
    unresolvedQuestions: ['What should be true when this is done?'],
  };
}

async function startFromItem(item) {
  await startConversation(item);
}

async function startFromManual(title, body) {
  const slot = document.querySelector('#source-error');
  if (!title.trim()) { fail(new Error('Give it a one-line title first.'), slot); return; }
  await startConversation({ source: 'manual', key: 'manual:' + browserUuid(), title: title.trim(), body: body, labels: [] });
}

async function startConversation(workItem) {
  const scope = state.scope;
  if (!scope) { fail(new Error('Pick a repository first.'), document.querySelector('#source-error')); return; }
  try {
    const conversation = await post('/api/intake-conversations', {
      repositoryId: scope, seed: workItem, brief: initialBrief(workItem, scope),
    });
    intake.conversation = conversation;
    intake.revision = undefined; intake.snapshot = undefined; intake.triage = undefined; intake.admission = undefined;
    intake.draft = undefined;
    paintIntake();
    const box = document.querySelector('#chat-message');
    if (box) box.focus();
  } catch (error) { fail(error, document.querySelector('#source-error')); }
}

/* ---------- conversation pane ---------- */

function paintChatPane() {
  const pane = clear(document.querySelector('#pane-chat'));
  const conversation = intake.conversation;
  pane.append(el('div', { class: 'pane-head' }, [
    el('h2', { text: 'Working it out' }),
    el('span', { class: 'pane-note', text: 'nothing here is edited or deleted' }),
  ]));

  if (!conversation) {
    pane.append(el('div', { class: 'center-note' }, [
      el('h2', { text: 'Pick an issue, or write the task yourself.' }),
      el('p', { text: 'Bobsled will ask questions until the brief is specific enough to hand off.' }),
    ]));
    return;
  }

  const body = el('div', { class: 'pane-body' });
  if (!conversation.turns.length) {
    body.append(el('div', { class: 'lane-empty', text: 'Say what you want and Bobsled will start asking.' }));
  }
  for (const turn of conversation.turns) {
    body.append(el('div', { class: 'turn', 'data-role': turn.role }, [
      el('label', { text: turn.role === 'operator' ? 'You' : 'Bobsled' }),
      el('p', { text: turn.text }),
    ]));
  }
  if (intake.revision && intake.revision.status === 'failed') {
    body.append(el('div', { class: 'inline-error' }, [
      el('b', { text: 'That reply did not go through.' }),
      el('span', { text: intake.revision.error || 'The model call failed. Your message was kept.' }),
    ]));
  }
  pane.append(body);

  const errorSlot = el('div', { class: 'inline-error', id: 'chat-error', role: 'alert' });
  const composer = el('div', { class: 'composer' });
  const working = intake.busy || (intake.revision && ['reserved', 'running'].includes(intake.revision.status));
  const open = conversation.status === 'active' && !working;

  if (conversation.status === 'active') {
    const box = el('textarea', { id: 'chat-message', maxlength: '20000', placeholder: 'Answer that, add context, or correct anything it got wrong…' });
    box.disabled = !open;
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendRevision(box.value); }
    });
    composer.append(errorSlot, box, el('div', { class: 'btnrow' }, [
      button('Send', 'primary', !open, () => sendRevision(box.value)),
      button('Lock it in', '', !open, lockBrief),
      el('span', { class: 'spacer' }),
      button('Stop working on this', 'ghost', !open, cancelConversation),
    ]));
    if (working) composer.append(el('div', { class: 'lane-empty', text: 'Bobsled is thinking…' }));
  } else if (conversation.status === 'finalized') {
    composer.append(errorSlot, el('div', { class: 'gate-note' }, [
      el('b', { text: 'This brief is locked. ' }),
      el('span', { text: 'The conversation is closed. If something is wrong, start a correction — the locked brief stays as it is and a fresh one carries it forward.' }),
    ]), el('div', { class: 'btnrow' }, [
      button('Start a correction', '', Boolean(intake.admission), startCorrection),
      button('Start something new', 'ghost', false, () => { intake.conversation = undefined; intake.snapshot = undefined; intake.triage = undefined; intake.admission = undefined; paintIntake(); }),
    ]));
  } else {
    composer.append(el('div', { class: 'lane-empty', text: 'This conversation was stopped.' }), el('div', { class: 'btnrow' }, [
      button('Start something new', 'primary', false, () => { intake.conversation = undefined; intake.snapshot = undefined; intake.triage = undefined; intake.admission = undefined; paintIntake(); }),
    ]));
  }
  pane.append(composer);
}

function button(text, kind, disabled, onclick) {
  const node = el('button', { class: 'btn' + (kind ? ' ' + kind : ''), text: text, onclick: onclick });
  node.disabled = Boolean(disabled);
  return node;
}

async function sendRevision(text) {
  const conversation = intake.conversation;
  const trimmed = (text || '').trim();
  if (!conversation || !trimmed) return;
  intake.busy = true; paintChatPane();
  try {
    const payload = await post('/api/intake-conversations/' + conversation.id + '/revisions', {
      expectedVersion: conversation.version, message: trimmed,
    });
    intake.conversation = payload.conversation;
    intake.revision = payload.revision;
    intake.busy = false;
    paintIntake();
    if (payload.revision.status === 'failed') fail(new Error(payload.revision.error || 'The reply failed.'), document.querySelector('#chat-error'));
  } catch (error) {
    intake.busy = false; paintIntake();
    fail(error, document.querySelector('#chat-error'));
  }
}

/* ---------- lock, check, queue ---------- */

async function lockBrief() {
  const conversation = intake.conversation;
  if (!conversation) return;
  const decision = await authorize('intake_finalize', {
    subject: conversation.seed.key + ' · ' + conversation.currentBrief.objective,
    bound: [
      ['Still open', String(conversation.currentBrief.unresolvedQuestions.length) + ' questions'],
      ['Done when', String(conversation.currentBrief.acceptanceCriteria.length) + ' criteria'],
      ['Costs', '1 Codex call'],
    ],
  });
  if (!decision.ok) return;

  intake.busy = true; paintChatPane();
  const busy = toast('Locking it in…', { tone: 'busy', detail: 'Then it goes straight to an independent check.' });
  try {
    const payload = await post('/api/intake-conversations/' + conversation.id + '/finalize', {
      expectedVersion: conversation.version, reason: decision.reason,
    });
    intake.conversation = payload.conversation;
    intake.snapshot = payload.snapshot;
    paintIntake();
    // The handoff: locking is not a dead end. The check runs immediately and
    // you read its verdict before deciding whether to queue anything.
    intake.triage = await post('/api/intake-conversations/' + conversation.id + '/snapshot/triage', {});
    intake.busy = false;
    paintIntake();
    if (intake.triage.status === 'succeeded') toast('Checked.', { detail: 'Read what it decided, then queue it if you agree.' });
    else toast('The check did not finish.', { tone: 'bad', detail: intake.triage.error || 'You can try it again.' });
  } catch (error) {
    intake.busy = false; paintIntake();
    fail(error, document.querySelector('#chat-error'));
  } finally { busy.remove(); }
}

async function retryCheck() {
  const conversation = intake.conversation;
  if (!conversation) return;
  intake.busy = true; paintBriefPane();
  try {
    intake.triage = await post('/api/intake-conversations/' + conversation.id + '/snapshot/triage', {});
    intake.busy = false; paintIntake();
  } catch (error) { intake.busy = false; paintIntake(); fail(error, document.querySelector('#brief-error')); }
}

async function queueRun() {
  const conversation = intake.conversation;
  const decision = intake.triage && intake.triage.result && intake.triage.result.decision;
  if (!conversation || !decision) return;
  const confirmed = await authorize('intake_admit', {
    subject: conversation.seed.key + ' · ' + decision.summary,
    bound: [
      ['Verdict', decision.route === 'ready_for_agent' ? 'clear to hand off' : 'wants your sign-off'],
      ['Risk', decision.risk],
    ],
  });
  if (!confirmed.ok) return;
  intake.busy = true; paintBriefPane();
  try {
    const payload = await post('/api/intake-conversations/' + conversation.id + '/snapshot/admission', {});
    intake.admission = payload.admission;
    intake.busy = false;
    paintIntake();
    await loadBoardQuietly();
    toast('Queued it up.', { detail: 'It is waiting in Ready. Starting it is still up to you.', action: 'Open the run', href: '/runs/' + payload.run.id });
  } catch (error) { intake.busy = false; paintIntake(); fail(error, document.querySelector('#brief-error')); }
}

async function startCorrection() {
  const conversation = intake.conversation;
  if (!conversation) return;
  const decision = await authorize('intake_correct', { subject: conversation.seed.key + ' · ' + conversation.currentBrief.objective });
  if (!decision.ok) return;
  try {
    const corrected = await post('/api/intake-conversations/' + conversation.id + '/corrections', { reason: decision.reason });
    intake.conversation = corrected;
    intake.revision = undefined; intake.snapshot = undefined; intake.triage = undefined; intake.admission = undefined;
    paintIntake();
    const box = document.querySelector('#chat-message');
    if (box) box.focus();
    toast('Started a correction.', { detail: 'The locked brief is untouched. This one carries it forward.' });
  } catch (error) { fail(error, document.querySelector('#chat-error')); }
}

async function cancelConversation() {
  const conversation = intake.conversation;
  if (!conversation) return;
  const decision = await authorize('intake_cancel', { subject: conversation.seed.key + ' · ' + conversation.currentBrief.objective });
  if (!decision.ok) return;
  try {
    intake.conversation = await post('/api/intake-conversations/' + conversation.id + '/cancel', {
      expectedVersion: conversation.version, reason: decision.reason,
    }, false);
    paintIntake();
  } catch (error) { fail(error, document.querySelector('#chat-error')); }
}

/* ---------- brief pane ---------- */

function paintBriefPane() {
  const pane = clear(document.querySelector('#pane-brief'));
  const conversation = intake.conversation;
  const brief = conversation && conversation.currentBrief;
  const open = brief ? brief.unresolvedQuestions.length : 0;

  pane.append(el('div', { class: 'pane-head' }, [
    el('h2', { text: 'What we have agreed' }),
    brief ? el('span', { class: 'pane-note', style: open ? 'color:var(--warn)' : '', text: open ? (open === 1 ? '1 thing still open' : open + ' things still open') : 'nothing left open' }) : null,
  ]));

  if (!brief) {
    pane.append(el('div', { class: 'pane-body' }, [el('div', { class: 'lane-empty', text: 'The brief builds up here as you talk.' })]));
    return;
  }

  const body = el('div', { class: 'pane-body' });
  body.append(el('div', { class: 'inline-error', id: 'brief-error', role: 'alert' }));

  if (conversation.supersession) {
    body.append(el('div', { class: 'gate-note' }, [
      el('b', { text: 'This is a correction. ' }),
      el('span', { text: 'The brief it came from stays locked and unchanged.' }),
    ]));
  }

  for (const field of COPY.BRIEF_FIELDS) {
    const value = brief[field.key];
    if (field.kind === 'text') {
      body.append(el('div', { class: 'briefblock' }, [el('label', { text: field.label }), el('p', { text: value || '—' })]));
    } else {
      body.append(el('div', { class: 'briefblock' }, [
        el('label', {}, [el('span', { text: field.label }), el('i', { text: String(value.length) })]),
        value.length ? el('ul', {}, value.map((entry) => el('li', { text: entry }))) : el('p', { text: 'Nothing yet.' }),
      ]));
    }
  }

  if (!intake.snapshot) {
    body.append(el('div', { class: 'gate-note' }, [
      el('b', { text: 'Locking it in ends the conversation ' }),
      el('span', { text: 'and sends the brief straight to an independent check. You see what it decides before anything is queued.' }),
    ]));
  } else {
    body.append(el('div', { class: 'subhead', text: 'Locked · ' + intake.snapshot.sourceTurnCount + ' messages · ' + intake.snapshot.briefSha256.slice(0, 12) }));
  }

  const triage = intake.triage;
  if (triage && triage.status === 'succeeded' && triage.result) {
    const decision = triage.result.decision;
    body.append(el('div', { class: 'verdict', 'data-route': decision.route }, [
      el('div', { class: 'tags' }, [
        el('span', { class: 'tag ' + (decision.route === 'ready_for_agent' ? 'ok' : 'warn'), text: decision.route === 'ready_for_agent' ? 'Clear enough to hand off' : 'Wants your sign-off' }),
        el('span', { class: 'tag', text: decision.risk + ' risk' }),
      ]),
      el('h3', { text: decision.summary }),
      el('p', { class: 'prose', text: decision.rationale }),
      decision.missingInformation.length ? el('div', {}, [
        el('div', { class: 'subhead', text: 'Still missing' }),
        el('ul', { class: 'plainlist' }, decision.missingInformation.map((entry) => el('li', { text: entry }))),
      ]) : null,
    ]));
    if (intake.admission) {
      body.append(el('div', { class: 'btnrow' }, [
        el('button', { class: 'btn primary', text: 'Open the run', onclick: () => navigate('/runs/' + intake.admission.runId) }),
      ]));
    } else {
      body.append(el('div', { class: 'btnrow' }, [button('Queue it up', 'primary', intake.busy, queueRun)]));
    }
  } else if (triage && triage.status === 'blocked') {
    body.append(el('div', { class: 'inline-error' }, [
      el('b', { text: 'The check could not run.' }),
      el('span', { text: triage.error || 'Repository policy changed before it started.' }),
    ]));
    body.append(el('div', { class: 'btnrow' }, [button('Try the check again', 'primary', intake.busy, retryCheck)]));
  } else if (triage && triage.status === 'failed') {
    body.append(el('div', { class: 'inline-error' }, [
      el('b', { text: 'The check failed.' }),
      el('span', { text: triage.error || 'Its one call is spent. A correction starts a fresh brief you can check again.' }),
    ]));
  }

  pane.append(body);
}
`;
