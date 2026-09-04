export const boardSource = String.raw`
/* ---------- board data ---------- */

function visibleCards() {
  const query = (document.querySelector('#board-search') || { value: '' }).value.trim().toLocaleLowerCase();
  return state.cards.filter((card) => {
    if (state.scope && card.repositoryId !== state.scope) return false;
    if (!query) return true;
    return (card.title + ' ' + card.workItemKey + ' ' + card.repositoryId + ' ' + card.phase).toLocaleLowerCase().includes(query);
  });
}

function attentionCount() {
  return state.cards.filter((card) => card.lane === 'attention' && (!state.scope || card.repositoryId === state.scope)).length;
}

function shortRepo(id) { return String(id).split('/').pop(); }

function metricsFor(card) {
  const values = [];
  const m = card.metrics;
  if (m.filesChanged !== undefined) values.push(m.filesChanged + (m.filesChanged === 1 ? ' file, ' : ' files, ') + m.diffLines + ' lines');
  if (m.gatesTotal !== undefined) values.push(m.gatesPassed === m.gatesTotal ? 'tests passed' : m.gatesPassed + ' of ' + m.gatesTotal + ' checks passed');
  if (m.findings !== undefined) values.push(m.blockingFindings ? m.blockingFindings + ' blocking, ' + m.findings + ' total' : m.findings + (m.findings === 1 ? ' note' : ' notes') + ', none blocking');
  if (m.checksTotal !== undefined) values.push(m.checksPassed + ' of ' + m.checksTotal + ' checks passed');
  if (m.workerTasksTotal !== undefined) values.push(m.workerTasksSucceeded + ' of ' + m.workerTasksTotal + ' pieces done');
  values.push(ago(card.updatedAt));
  return values;
}

// Rough stage position, used only for the progress bar on a moving card.
function progressOf(card) {
  const order = ['ready', 'working', 'review', 'delivery', 'history'];
  const at = order.indexOf(card.lane);
  return [0, 1, 2, 3, 4].map((index) => (index < at ? 'done' : index === at ? 'now' : ''));
}

function renderCard(card) {
  const node = el('button', { class: 'card', 'data-lane': card.lane, 'data-run-id': card.id, type: 'button' }, [
    el('div', { class: 'card-top' }, [
      el('span', { text: shortRepo(card.repositoryId) }),
      el('span', { class: 'phase', text: card.phase }),
    ]),
    el('h3', { text: card.title }),
  ]);
  if (card.lane === 'working' || card.lane === 'review') {
    node.append(el('div', { class: 'micro' }, progressOf(card).map((cls) => el('i', { class: cls }))));
  }
  node.append(el('div', { class: 'why' + (card.attention ? ' alarm' : ''), text: card.attention || card.summary }));
  node.append(el('div', { class: 'metrics' }, metricsFor(card).map((value) => el('span', { text: value }))));
  node.addEventListener('click', () => navigate('/runs/' + card.id));

  if (card.actions.length) {
    const row = el('div', { class: 'btnrow' });
    for (const action of card.actions) row.append(actionButton(card, action));
    if (card.lane === 'working' || card.lane === 'review') {
      row.append(el('button', { class: 'btn', text: 'Watch it work', onclick: (event) => { event.stopPropagation(); navigate('/runs/' + card.id + '/live'); } }));
    }
    node.append(row);
  } else if (card.lane === 'working' || card.lane === 'review') {
    node.append(el('div', { class: 'btnrow' }, [
      el('button', { class: 'btn primary', text: 'Watch it work', onclick: (event) => { event.stopPropagation(); navigate('/runs/' + card.id + '/live'); } }),
    ]));
  }
  return node;
}

/* ---------- board surface ---------- */

async function boardSurface(surface) {
  const board = el('div', { class: 'board', id: 'board' });
  for (const lane of COPY.LANES) {
    board.append(el('section', { class: 'lane', 'data-lane': lane.id }, [
      el('div', { class: 'lane-head' }, [
        el('div', { class: 'lane-title' }, [
          el('span', { class: 'dot' }), el('strong', { text: lane.name }), el('span', { class: 'n', text: '0' }),
        ]),
        el('div', { class: 'lane-def', text: lane.definition }),
      ]),
      el('div', { class: 'lane-cards' }),
    ]));
  }
  const doneStrip = el('details', { class: 'done-strip', id: 'done-strip' }, [
    el('summary', {}, [el('span', { text: COPY.HISTORY.name + ' · ' }), el('span', { id: 'done-count', text: '0' })]),
    el('div', { class: 'done-grid', id: 'done-grid' }),
  ]);
  const errorSlot = el('div', { class: 'inline-error', id: 'board-error', role: 'alert' });
  surface.append(errorSlot, board, doneStrip);

  setTopbar([
    el('div', { class: 'crumbs' }, [el('b', { text: 'Board' }), el('span', { text: state.scope ? ' · ' + state.scope : ' · everything, newest first' })]),
    el('input', { class: 'spacer', id: 'board-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search runs' }),
    el('button', { class: 'btn', text: 'Refresh', onclick: () => loadBoard(true) }),
  ]);
  document.querySelector('#board-search').addEventListener('input', paintBoard);

  await loadBoard(false);
  markSeen();
  return () => { clearTimeout(state.poll); state.poll = undefined; };
}

function paintBoard() {
  const board = document.querySelector('#board');
  if (!board) return;
  const cards = visibleCards();
  for (const lane of board.querySelectorAll('.lane')) {
    const id = lane.dataset.lane;
    const mine = cards.filter((card) => card.lane === id);
    const holder = clear(lane.querySelector('.lane-cards'));
    lane.querySelector('.n').textContent = String(mine.length);
    if (!mine.length) {
      const copy = COPY.LANES.find((entry) => entry.id === id);
      holder.append(el('div', { class: 'lane-empty', text: copy ? copy.empty : 'Nothing here.' }));
    } else for (const card of mine) holder.append(renderCard(card));
  }
  const done = cards.filter((card) => card.lane === 'history');
  document.querySelector('#done-count').textContent = String(done.length);
  const grid = clear(document.querySelector('#done-grid'));
  if (!done.length) grid.append(el('div', { class: 'lane-empty', text: COPY.HISTORY.empty }));
  else for (const card of done) grid.append(renderCard(card));
}

async function loadBoard(announce) {
  const errorSlot = document.querySelector('#board-error');
  try {
    const board = await json('/api/operator-board');
    state.cards = board.cards;
    state.boardLoadedAt = Date.now();
    if (errorSlot) clear(errorSlot);
    paintBoard();
    updateAttention();
    schedulePoll();
    if (announce) toast('Board refreshed.', { detail: state.cards.length + ' runs.' });
  } catch (error) {
    if (errorSlot) fail(error, errorSlot);
    else fail(error);
  }
}

function schedulePoll() {
  clearTimeout(state.poll);
  const moving = state.cards.some((card) => card.lane === 'working' || card.lane === 'review'
    || (card.publication && ['running', 'published', 'checks_pending'].includes(card.publication.status)));
  // Poll steadily either way: a solo operator walks away, and a board that
  // stops updating because nothing looked busy is how you miss the moment
  // something started.
  state.poll = setTimeout(() => { if (document.querySelector('#board')) loadBoard(false); }, moving ? 5000 : 20000);
}

function updateAttention() {
  const count = attentionCount();
  const pip = document.querySelector('#nav-attention');
  pip.textContent = String(count);
  pip.hidden = count === 0;
  const stat = document.querySelector('#stat-attention');
  stat.textContent = count === 1 ? '1 needs you' : count + ' need you';
  stat.hidden = count === 0;
  document.title = (count ? '(' + count + ') ' : '') + 'Bobsled';
  notifyAttention(count);
}

function markSeen() {
  state.seenAt = Date.now();
  localStorage.setItem('bobsled.seenAt', String(state.seenAt));
}

/* ---------- desktop notification ---------- */

const notifiedFor = new Set();
let notificationsSeeded = false;
function notifyAttention() {
  const stuck = state.cards.filter((card) => card.lane === 'attention');
  // The first board load of a session records what is already stuck without
  // announcing it. You only get told about things that stop while you are away.
  if (!notificationsSeeded) {
    for (const card of stuck) notifiedFor.add(card.id + card.phase);
    notificationsSeeded = true;
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const card of stuck) {
    const key = card.id + card.phase;
    if (notifiedFor.has(key)) continue;
    notifiedFor.add(key);
    try {
      const note = new Notification('Bobsled needs you', { body: card.title + ' — ' + card.phase, tag: card.id });
      note.addEventListener('click', () => { window.focus(); navigate('/runs/' + card.id); });
    } catch { /* notifications are a convenience, never a dependency */ }
  }
}
`;
