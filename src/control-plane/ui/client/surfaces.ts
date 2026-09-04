export const surfacesSource = String.raw`
/* ---------- access ---------- */

async function accessSurface(surface) {
  setTopbar([el('div', { class: 'crumbs' }, [el('b', { text: 'Access' }), el('span', { text: ' · what Bobsled can reach' })])]);
  const body = el('div', { class: 'pane-body' });
  surface.append(el('div', { class: 'col-pane' }, [
    el('div', { class: 'pane-head' }, [el('h2', { text: 'GitHub' })]),
    body,
  ]));

  const [authority, status, observability, repositoryDrift] = await Promise.all([
    json('/api/github-app/authority').catch((error) => ({ error: message(error) })),
    json('/api/github-app/status').catch(() => undefined),
    json('/api/observability/status').catch(() => undefined),
    json('/api/repositories/drift').catch(() => undefined),
  ]);

  if (authority.error) {
    body.append(el('div', { class: 'inline-error' }, [el('b', { text: 'Could not check GitHub access.' }), el('span', { text: authority.error })]));
  } else if (authority.status === 'within_policy') {
    body.append(el('div', { class: 'verdict' }, [
      el('div', { class: 'tags' }, [el('span', { class: 'tag ok', text: 'Looks right' })]),
      el('h3', { text: 'GitHub access looks right.' }),
      el('p', { class: 'prose', text: 'The App has exactly the permissions it is supposed to have, and nothing more.' }),
    ]));
  } else if (authority.status === 'unobserved') {
    body.append(el('div', { class: 'verdict', 'data-route': 'needs_human' }, [
      el('div', { class: 'tags' }, [el('span', { class: 'tag warn', text: 'Nothing seen yet' })]),
      el('h3', { text: 'Bobsled has not heard from GitHub yet.' }),
      el('p', { class: 'prose', text: 'Access gets checked the first time GitHub tells us about the installation.' }),
    ]));
  } else {
    body.append(el('div', { class: 'inline-error' }, [
      el('b', { text: 'The GitHub App has more access than it should.' }),
      el('span', { text: 'Beyond what Bobsled declares it needs: ' + (authority.excessPermissions || []).map((entry) => entry.name).join(', ') + '.' }),
    ]));
  }

  if (status) {
    body.append(el('div', { class: 'subhead', text: 'Installation' }));
    body.append(evGrid([
      ['Configured', status.configured ? 'yes' : 'no', status.configured ? 'ok' : 'bad'],
      ['Webhooks seen', String((status.webhooks && status.webhooks.total) || 0)],
      ['Last webhook', (status.webhooks && status.webhooks.lastEventAt) ? ago(status.webhooks.lastEventAt) : 'never'],
    ]));
  }
  if (observability) {
    body.append(el('div', { class: 'subhead', text: 'What Bobsled has recorded' }));
    body.append(evGrid([
      ['Agent events', String(observability.total || 0)],
      ['Stored', Math.round((observability.storedBytes || 0) / 1024) + ' KB'],
      ['Last seen', observability.lastObservedAt ? ago(observability.lastObservedAt) : 'never'],
    ]));
  }

  body.append(el('div', { class: 'subhead', text: 'Repositories' }));
  const grid = el('div', { style: 'display:grid;gap:8px' });
  for (const repository of state.repositories) {
    const drift = repositoryDrift && repositoryDrift.find((entry) => entry.repositoryId === repository.id);
    const driftLabel = !drift ? 'not checked' : drift.status === 'aligned' ? 'aligned' : drift.status === 'drifted' ? 'drift found' : 'unavailable';
    const detail = !drift || !drift.findings.length ? '' : ' · ' + drift.findings.map((finding) => finding.kind.replace(/_/g, ' ')).join(', ');
    grid.append(el('div', { class: 'filerow' }, [
      el('span', { text: repository.id }),
      el('span', { class: 'pm', text: (repository.readOnly ? 'read only' : 'can write') + ' · ' + driftLabel + detail }),
    ]));
  }
  body.append(grid);
  return undefined;
}

/* ---------- activity ---------- */

async function activitySurface(surface) {
  setTopbar([
    el('div', { class: 'crumbs' }, [el('b', { text: 'Activity' }), el('span', { text: ' · everything, newest first' })]),
    el('button', { class: 'btn spacer', text: 'Refresh', onclick: () => render() }),
  ]);
  if (!state.cards.length) await loadBoardQuietly();

  const events = [];
  for (const card of state.cards) {
    if (state.scope && card.repositoryId !== state.scope) continue;
    for (const event of card.run.audit) {
      events.push({ card: card, type: event.type, actorId: event.actorId, at: event.createdAt });
    }
  }
  events.sort((left, right) => right.at.localeCompare(left.at));

  const body = el('div', { class: 'pane-body' });
  surface.append(el('div', { class: 'col-pane' }, [
    el('div', { class: 'pane-head' }, [el('h2', { text: 'What has been happening' }), el('span', { class: 'pane-note', text: events.length + ' events' })]),
    body,
  ]));

  if (!events.length) {
    body.append(el('div', { class: 'center-note' }, [
      el('h2', { text: 'Nothing has happened yet.' }),
      el('p', { text: 'Queue something up and it will show here.' }),
    ]));
    return undefined;
  }

  let lastDay = '';
  let holder;
  for (const event of events.slice(0, 300)) {
    const day = new Date(event.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      holder = el('div', { class: 'tl' });
      body.append(el('div', { class: 'subhead', text: day }), holder);
    }
    const node = el('div', { class: event.type.includes('blocked') || event.type.includes('failed') ? 'hot' : '' }, [
      el('b', { text: EVENT_NAMES[event.type] || event.type.replace(/[._]/g, ' ') }),
      el('em', { text: clock(event.at) + ' · ' + event.card.title }),
    ]);
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => navigate('/runs/' + event.card.id));
    holder.append(node);
  }
  return undefined;
}

/* ---------- change sets ---------- */

async function changeSetsSurface(surface) {
  setTopbar([el('div', { class: 'crumbs' }, [el('b', { text: 'Change sets' }), el('span', { text: ' · work that spans repositories' })])]);
  surface.append(el('div', { class: 'center-note' }, [
    el('h2', { text: 'No change sets yet.' }),
    el('p', { class: 'prose', text: 'A change set coordinates one piece of work across several repositories: dependency order, compatibility checks between them, and a rollout that stops at the first failure. The machinery is built and tested; nothing has used it yet, so there is nothing to show.' }),
    el('p', { class: 'prose', text: 'When the first one exists, this is where its members, their order, and their rollout state will live.' }),
  ]));
  return undefined;
}
`;
