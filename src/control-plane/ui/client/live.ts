export const liveSource = String.raw`
/* ---------- live view ---------- */
// Read-only, on purpose. Every bound downstream of a run -- one attempt, one
// review, one remediation, a fingerprint tying an approval to exact bytes --
// assumes nobody reached in while it was running. Stop is the only control.

const TOOL_VERBS = {
  read: 'read', read_file: 'read', readFile: 'read',
  write: 'wrote', write_file: 'wrote', writeFile: 'wrote',
  edit: 'edited', edit_file: 'edited', editFile: 'edited', str_replace: 'edited',
  bash: 'ran', shell: 'ran', exec: 'ran', run: 'ran',
  grep: 'searched', search: 'searched', glob: 'listed', ls: 'listed',
};

function toolLabel(name) { return TOOL_VERBS[name] || name; }

function firstString(args, keys) {
  if (!args || typeof args !== 'object') return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function describeTool(payload) {
  const args = payload.args || {};
  const target = firstString(args, ['path', 'file_path', 'filePath', 'file', 'pattern', 'query', 'command', 'cmd']);
  return { verb: toolLabel(payload.toolName), target: target };
}

function isGateish(payload) {
  const command = firstString(payload.args || {}, ['command', 'cmd']);
  return /\b(npm|pnpm|yarn|node|tsc|vitest|jest|eslint|test|lint|check)\b/.test(command);
}

function streamRow(event) {
  const payload = event.payload || {};
  if (event.type === 'tool_start') {
    const described = describeTool(payload);
    return row(event, 'tool', [el('b', { text: described.verb }), described.target ? el('span', { text: ' ' + described.target }) : null]);
  }
  if (event.type === 'tool') {
    if (!isGateish(payload) && !payload.isError) return undefined;
    const seconds = payload.durationMs ? ' (' + Math.round(payload.durationMs / 100) / 10 + 's)' : '';
    return row(event, 'gate', [
      el('b', { text: payload.toolName }),
      el('span', { text: (payload.isError ? ' failed' : ' finished') + seconds }),
    ], payload.isError);
  }
  if (event.type === 'text' && typeof payload.text === 'string' && payload.text.trim()) {
    return row(event, 'says', [el('em', { text: agentLabel(event) }), el('span', { text: payload.text.trim() })]);
  }
  if (event.type === 'log' && typeof payload.message === 'string') {
    return row(event, 'log', [el('span', { text: payload.message })], payload.level === 'error');
  }
  if (event.type === 'agent_start') return row(event, 'log', [el('b', { text: agentLabel(event) }), el('span', { text: ' started' })]);
  if (event.type === 'agent_end') return row(event, 'log', [el('b', { text: agentLabel(event) }), el('span', { text: ' finished' })]);
  return undefined;
}

function agentLabel(event) {
  const id = event.conversationId || '';
  if (id.startsWith('implementation-')) return 'Codex';
  if (id.startsWith('review-')) return 'Copilot';
  if (id.startsWith('remediation-')) return 'Codex, fixing';
  return event.agentName || 'Agent';
}

function row(event, kind, children, bad) {
  return el('div', { class: 'srow', 'data-kind': kind, 'data-bad': bad ? 'true' : undefined }, [
    el('time', { datetime: event.at, text: clock(event.at) }),
    el('div', { class: 'what' }, children.filter(Boolean)),
  ]);
}

async function liveSurface(surface, params) {
  const runId = params[0];
  if (!state.cards.length) await loadBoardQuietly();
  const card = state.cards.find((entry) => entry.id === runId);
  if (!card) { navigate('/runs/' + runId, { replace: true }); return; }

  setTopbar([
    el('div', { class: 'crumbs' }, [
      el('a', { href: '/', 'data-link': true, text: 'Board' }), el('span', { text: ' › ' }),
      el('a', { href: '/runs/' + runId, 'data-link': true, text: shortRepo(card.repositoryId) }), el('span', { text: ' › ' }),
      el('b', { text: card.title }),
    ]),
    el('div', { class: 'stat spacer', id: 'live-elapsed', text: '—' }),
    el('button', { class: 'btn', text: 'Run details', onclick: () => navigate('/runs/' + runId) }),
  ]);

  const dot = el('span', { class: 'livedot', id: 'live-dot' });
  const label = el('span', { class: 'lbl', id: 'live-label', text: 'Watching' });
  const stopButton = el('button', { class: 'btn danger', text: 'Stop' });
  stopButton.addEventListener('click', async () => {
    const current = state.cards.find((entry) => entry.id === runId) || card;
    const cancel = (current.actions || []).find((entry) => entry.kind === 'cancel');
    await runAction(current, cancel || { kind: 'cancel', label: 'Stop', emphasis: 'danger' });
  });

  const stream = el('div', { class: 'stream', id: 'live-stream', role: 'log', 'aria-live': 'polite', 'aria-label': 'What the agent is doing' });
  const files = el('div', { class: 'pane-body', id: 'live-files' });

  surface.append(
    el('div', { class: 'watchbar' }, [
      dot, label,
      el('span', { class: 'ro', text: 'You are watching, not steering — nothing you do here reaches the agent. To change the outcome, stop it and rewrite the task.' }),
      el('span', { class: 'spacer' }), stopButton,
    ]),
    el('div', { class: 'watchgrid' }, [
      el('div', { class: 'col-pane' }, [stream]),
      el('div', { class: 'col-pane' }, [
        el('div', { class: 'pane-head' }, [el('h2', { text: 'The change so far' }), el('span', { class: 'pane-note', id: 'live-diffstat', text: '' })]),
        files,
      ]),
    ]),
  );

  let after = 0;
  let timer;
  let stopped = false;
  const startedAt = Date.parse(card.updatedAt) || Date.now();
  const seen = new Set();
  paintFiles(seen);

  const tick = async () => {
    if (stopped) return;
    try {
      const payload = await json('/api/runs/' + runId + '/activity?after=' + after);
      for (const event of payload.events) {
        after = Math.max(after, event.id);
        const node = streamRow(event);
        if (!node) continue;
        stream.append(node);
        collectFile(event, seen);
      }
      if (payload.events.length) {
        stream.scrollTop = stream.scrollHeight;
        paintFiles(seen);
      }
      if (!stream.childElementCount) {
        const current = state.cards.find((entry) => entry.id === runId) || card;
        clear(stream).append(el('div', { class: 'center-note' }, [
          el('h2', { text: current.lane === 'ready' ? 'This has not started yet.' : 'Nothing was recorded.' }),
          el('p', { text: current.lane === 'ready' ? 'Start the work and every step it takes will appear here.' : 'Steps appear here as the agent takes them.' }),
        ]));
      }
      const current = state.cards.find((entry) => entry.id === runId) || card;
      const live = ['working', 'review'].includes(current.lane);
      const started = current.lane !== 'ready';
      dot.dataset.idle = String(!live);
      label.textContent = live ? 'Watching ' + agentLabelFor(payload)
        : started ? 'Finished'
        : 'Not started yet';
      stopButton.disabled = !live;
      const elapsed = document.querySelector('#live-elapsed');
      // Elapsed time only means something while work is running; before that,
      // the honest number is how long it has been sitting there.
      if (elapsed) elapsed.textContent = live ? duration(Date.now() - startedAt) : ago(current.updatedAt);
      if (!live && payload.events.length === 0) { stopped = true; return; }
    } catch (error) {
      label.textContent = 'Lost the connection';
      dot.dataset.idle = 'true';
    }
    timer = setTimeout(tick, 1500);
  };
  await tick();

  const boardTimer = setInterval(() => loadBoardQuietly(), 5000);
  return () => { stopped = true; clearTimeout(timer); clearInterval(boardTimer); };
}

function agentLabelFor(payload) {
  const last = payload.events[payload.events.length - 1];
  return last ? agentLabel(last) : 'work';
}

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + 's elapsed';
  return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's elapsed';
}

/* ---------- files touched ---------- */
// Derived from the write and edit calls the agent actually made. This is a
// picture of what it is doing, not the authoritative patch -- that is computed
// by trusted code after the attempt settles, and shown on the run page.

function collectFile(event, seen) {
  if (event.type !== 'tool_start') return;
  const verb = toolLabel(event.payload.toolName);
  if (verb !== 'wrote' && verb !== 'edited') return;
  const path = firstString(event.payload.args || {}, ['path', 'file_path', 'filePath', 'file']);
  if (path) seen.add(path);
}

function paintFiles(seen) {
  const holder = document.querySelector('#live-files');
  if (!holder) return;
  clear(holder);
  const paths = Array.from(seen);
  const stat = document.querySelector('#live-diffstat');
  if (stat) stat.textContent = paths.length ? paths.length + (paths.length === 1 ? ' file touched' : ' files touched') : '';
  if (!paths.length) {
    holder.append(el('div', { class: 'lane-empty', text: 'Nothing written yet.' }));
    return;
  }
  for (const path of paths) holder.append(el('div', { class: 'filerow' }, [el('span', { text: path })]));
  holder.append(el('div', { class: 'gate-note' }, [
    el('span', { text: 'These are the files the agent has touched. The exact change, with its fingerprint, is computed by trusted code once the attempt finishes.' }),
  ]));
}
`;
