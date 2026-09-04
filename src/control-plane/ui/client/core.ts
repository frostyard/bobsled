// Shared client runtime: data access, navigation, feedback surfaces, and the
// authorization sheet that fronts every durable decision.
//
// Authored as a string so the interface ships as one document with no build
// step. Avoid backticks and template placeholders in here: the whole file is
// interpolated into a String.raw template.

export const coreSource = String.raw`
const state = {
  repositories: [],
  cards: [],
  scope: localStorage.getItem('bobsled.scope') || '',
  boardLoadedAt: 0,
  seenAt: Number(localStorage.getItem('bobsled.seenAt') || 0),
  poll: undefined,
};

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
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; }
  catch { throw new Error('The server sent something we could not read (HTTP ' + response.status + ').'); }
  if (!response.ok) throw new Error((value && value.error) || ('The request failed (HTTP ' + response.status + ').'));
  return value;
}

function post(url, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key !== false) headers['idempotency-key'] = key || browserUuid();
  return json(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/* ---------- DOM helpers ---------- */

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const key of Object.keys(props || {})) {
    const value = props[key];
    if (value === undefined || value === false || value === null) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children || [])) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child);
  }
  return node;
}

function clear(node) { while (node.firstChild) node.firstChild.remove(); return node; }

function ago(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function clock(timestamp) {
  const date = new Date(timestamp);
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

/* ---------- feedback ---------- */

function toast(title, options) {
  const settings = options || {};
  const node = el('div', { class: 'toast', 'data-tone': settings.tone || 'ok', role: 'status' }, [
    el('b', { text: title }),
    settings.detail ? el('p', { text: settings.detail }) : null,
  ]);
  if (settings.action && settings.href) {
    node.append(el('div', { class: 'btnrow' }, [
      el('button', { class: 'btn', text: settings.action, onclick: () => { navigate(settings.href); node.remove(); } }),
    ]));
  }
  document.querySelector('#toasts').append(node);
  const life = settings.tone === 'bad' ? 12000 : 6000;
  if (settings.tone !== 'busy') setTimeout(() => node.remove(), life);
  return node;
}

function fail(error, where) {
  const text = message(error);
  if (where) {
    clear(where);
    where.append(el('b', { text: 'That did not work.' }), el('span', { text: text }));
    return;
  }
  toast('That did not work.', { tone: 'bad', detail: text });
}

/* ---------- authorization sheet ---------- */

function authorize(kind, context) {
  const copy = COPY.AUTHORITY[kind];
  if (!copy) return Promise.resolve({ ok: true, reason: context && context.fallbackReason });
  const dialog = document.querySelector('#sheet');
  clear(dialog);

  const reason = el('textarea', { id: 'sheet-reason', maxlength: '2000', placeholder: copy.placeholder, rows: '2' });
  const errorSlot = el('div', { class: 'sheet-error', role: 'alert' });
  const confirm = el('button', { class: 'btn primary', text: copy.confirm });
  const dismiss = el('button', { class: 'btn', text: 'Never mind' });

  dialog.append(
    el('div', { class: 'sheet-head' }, [
      el('h2', { text: copy.title, id: 'sheet-title' }),
      context && context.subject ? el('em', { text: context.subject }) : null,
    ]),
    el('div', { class: 'grants' }, [
      el('div', { class: 'yes' }, [
        el('h3', { text: 'What this lets it do' }),
        el('ul', {}, copy.grants.map((item) => el('li', { text: item }))),
      ]),
      el('div', { class: 'no' }, [
        el('h3', { text: 'What it still cannot do' }),
        el('ul', {}, copy.denies.map((item) => el('li', { text: item }))),
      ]),
    ]),
  );
  const bound = (context && context.bound) || [];
  if (bound.length) {
    dialog.append(el('div', { class: 'bound' }, bound.map((entry) => el('div', {}, [
      el('label', { text: entry[0] }), el('b', { text: entry[1] }),
    ]))));
  }
  if (copy.note) dialog.append(el('div', { class: 'sheet-note', text: copy.note }));
  dialog.append(el('div', { class: 'sheet-foot' }, [
    el('div', {}, [el('label', { class: 'fieldlabel', for: 'sheet-reason', text: 'Why — kept in the log, for you later' }), reason]),
    errorSlot,
    el('div', { class: 'row' }, [confirm, dismiss, el('span', { class: 'note', text: 'logged as ' + IDENTITY.label })]),
  ]));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; dialog.close(); resolve(value); };
    confirm.addEventListener('click', () => {
      const text = reason.value.trim();
      // The store requires a bounded reason; an operator who leaves it empty
      // still gets a truthful default rather than a validation wall.
      finish({ ok: true, reason: text || (context && context.fallbackReason) || copy.title.replace(/\?$/, '') + ' — no note given.' });
    });
    dismiss.addEventListener('click', () => finish({ ok: false }));
    dialog.addEventListener('close', () => finish({ ok: false }), { once: true });
    dialog.showModal();
    reason.focus();
  });
}

/* ---------- routing ---------- */

const routes = [];
function route(pattern, render) { routes.push({ pattern: pattern, render: render }); }

function navigate(path, options) {
  if (path !== location.pathname + location.search) {
    if (options && options.replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
  }
  render();
}

function match(path) {
  for (const entry of routes) {
    if (entry.pattern instanceof RegExp) {
      const found = entry.pattern.exec(path);
      if (found) return { render: entry.render, params: found.slice(1) };
    } else if (entry.pattern === path) return { render: entry.render, params: [] };
  }
  return undefined;
}

let disposeSurface;
async function render() {
  if (disposeSurface) { try { disposeSurface(); } catch { /* a surface that fails to clean up must not block the next one */ } disposeSurface = undefined; }
  const surface = document.querySelector('#surface');
  const found = match(location.pathname);
  clear(surface);
  const active = currentSurfaceId();
  for (const link of document.querySelectorAll('.nav a')) {
    if (link.dataset.match === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (!found) {
    surface.append(el('div', { class: 'center-note' }, [
      el('h2', { text: 'There is nothing at this address.' }),
      el('p', { text: location.pathname }),
      el('button', { class: 'btn primary', text: 'Back to the board', onclick: () => navigate('/') }),
    ]));
    return;
  }
  try { disposeSurface = await found.render(surface, found.params); }
  catch (error) {
    clear(surface).append(el('div', { class: 'center-note' }, [
      el('h2', { text: 'This screen could not load.' }),
      el('p', { text: message(error) }),
      el('button', { class: 'btn', text: 'Try again', onclick: () => render() }),
    ]));
  }
}

function currentSurfaceId() {
  const path = location.pathname;
  if (path === '/' || path.startsWith('/runs')) return 'board';
  for (const surface of COPY.SURFACES) if (surface.path !== '/' && path.startsWith(surface.path)) return surface.id;
  return 'board';
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', () => render());
`;
