export const bootSource = String.raw`
/* ---------- shell wiring ---------- */

function setTopbar(children) {
  const bar = clear(document.querySelector('#topbar'));
  for (const child of children) if (child) bar.append(child);
  bar.append(
    el('span', { class: 'spacer' }),
    el('div', { class: 'stat alarm', id: 'stat-attention', hidden: true }),
    el('div', { class: 'stat', id: 'stat-budget', hidden: true }),
  );
  updateAttention();
}

function setScope(id) {
  state.scope = id || '';
  localStorage.setItem('bobsled.scope', state.scope);
  const select = document.querySelector('#scope');
  if (select && select.value !== state.scope) select.value = state.scope;
}

function buildRail() {
  const select = el('select', { id: 'scope', 'aria-label': 'Repository' });
  select.append(el('option', { value: '', text: 'All repositories' }));
  for (const repository of state.repositories) {
    select.append(el('option', { value: repository.id, text: repository.id }));
  }
  select.value = state.scope;
  select.addEventListener('change', () => { setScope(select.value); render(); });

  const nav = el('nav', { class: 'nav' });
  for (const surface of COPY.SURFACES) {
    const link = el('a', { href: surface.path, 'data-link': true, 'data-match': surface.id }, [el('span', { text: surface.name })]);
    if (surface.id === 'board') link.append(el('span', { class: 'pip alarm', id: 'nav-attention', hidden: true, text: '0' }));
    nav.append(link);
  }

  const foot = el('div', { class: 'rail-foot' }, [
    el('div', { class: 'opchip' }, [el('span', { class: 'dot' }), el('span', { text: 'Signed in as ' + IDENTITY.label })]),
  ]);
  if ('Notification' in window && Notification.permission === 'default') {
    const ask = el('a', { href: '#', text: 'Tell me when something needs me' });
    ask.addEventListener('click', async (event) => {
      event.preventDefault();
      const granted = await Notification.requestPermission();
      ask.remove();
      if (granted === 'granted') toast('You will be told when something stops.');
    });
    foot.append(ask);
  }
  if (IDENTITY.provider === 'github') {
    const out = el('a', { href: '#', text: 'Sign out' });
    out.addEventListener('click', async (event) => {
      event.preventDefault();
      try { await fetch('/auth/logout', { method: 'POST' }); location.assign('/'); }
      catch (error) { fail(error); }
    });
    foot.append(out);
  }

  return el('nav', { class: 'rail' }, [
    el('div', { class: 'mark', html: 'BOB<i>SLED</i>' }),
    el('div', { class: 'rail-label', text: 'Repositories' }),
    el('div', { class: 'scope' }, [select]),
    el('div', { class: 'rail-label', text: 'Go to' }),
    nav,
    foot,
  ]);
}

/* ---------- routes ---------- */

route('/', boardSurface);
route('/intake', intakeSurface);
route('/access', accessSurface);
route('/activity', activitySurface);
route('/change-sets', changeSetsSurface);
route(/^\/runs\/([0-9a-fA-F-]{36})\/live$/, liveSurface);
route(/^\/runs\/([0-9a-fA-F-]{36})$/, runSurface);

/* ---------- start ---------- */

async function start() {
  try {
    state.repositories = await json('/api/repositories');
  } catch (error) {
    fail(error);
    state.repositories = [];
  }
  if (state.scope && !state.repositories.some((repository) => repository.id === state.scope)) setScope('');
  document.querySelector('#app').prepend(buildRail());
  await render();
}

start();
`;
