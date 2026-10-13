'use strict';

/* ============================================================
   helpers
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Build DOM instead of concatenating HTML — nothing user- or model-authored
// ever gets parsed as markup.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;   // callers phrase 404 differently
    throw error;
  }
  return data;
}

function relTime(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

// Supplementary only — the relative time stays readable without it.
function absTime(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

function clockOf(iso, precise) {
  const d = new Date(iso);
  const base = d.toTimeString().slice(0, 8);
  return precise ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

// Transport-level failures surface as "fetch failed" / ECONNREFUSED, which
// tells the reader nothing they can act on.
const UNREACHABLE = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|NetworkError|Failed to fetch|Load failed/i;

function plainError(message) {
  const text = String(message || '');
  if (!UNREACHABLE.test(text)) return text || 'That didn’t go through. Try again.';
  // Two different hosts can be unreachable; name the right one.
  return /make\.|projects|Request failed/i.test(text) && !/provider/i.test(text)
    ? 'Can’t reach make. right now — is the server still running?'
    : 'Can’t reach the model provider — check the base URL in Settings and that it’s running.';
}

const POINTS_AT_SETTINGS = /no model configured|api key was rejected|check it in settings|base url in settings|add a model name/i;

function notice(sel, message, kind = '') {
  const node = $(sel);
  node.textContent = '';
  node.className = `notice${message ? ' on' : ''}${kind ? ` ${kind}` : ''}`;
  if (!message) return node;

  node.append(message);
  // An error that names Settings should carry the way there, not just point.
  if (POINTS_AT_SETTINGS.test(message) && sel !== '#settings-notice') {
    node.append(' ');
    node.append(el('a', { href: '#/settings', text: 'Open Settings' }));
  }
  return node;
}

function busy(button, on) {
  button.classList.toggle('busy', on);
  button.disabled = on;
}

/* ============================================================
   toasts + dialog
   ============================================================ */

const TOAST_LIFE = 6000;        // reading speed, not a designer's taste
const TOAST_ACTION_LIFE = 8000; // must outlast the undo window it offers
const TOAST_MAX = 3;

// Every toast must state something the user can also verify by looking at the
// screen — a disappearing message is not allowed to be the only record of it.
function toast(message, kind = '', action = null) {
  const node = el('div', { class: `toast${kind ? ` ${kind}` : ''}`, role: 'status' },
    el('span', { text: message }));

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  if (action) {
    node.append(el('button', {
      class: 'toast-action',
      text: action.label,
      onclick: () => { dismiss(); action.fn(); },
    }));
    node.append(el('button', { class: 'toast-x', 'aria-label': 'Dismiss', text: '×', onclick: dismiss }));
  }

  const box = $('#toasts');
  box.append(node);
  while (box.children.length > TOAST_MAX) box.firstElementChild.remove();

  // Hovering or focusing holds the message open; the guard stops a second
  // pointerenter (without a leave) from docking the remaining time twice.
  let remaining = action ? TOAST_ACTION_LIFE : TOAST_LIFE;
  let startedAt = Date.now();
  let paused = false;
  let timer = setTimeout(dismiss, remaining);

  const pause = () => {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    remaining -= Date.now() - startedAt;
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    startedAt = Date.now();
    timer = setTimeout(dismiss, Math.max(remaining, 600));
  };

  node.addEventListener('pointerenter', pause);
  node.addEventListener('pointerleave', resume);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', resume);
}

// Resolves to `true` / the entered string on confirm, or `null` on cancel.
function ask({ title, body = '', confirmLabel = 'Confirm', danger = false, input = null }) {
  const dialog = $('#dialog');
  const field = $('#dialog-field');
  const inputEl = $('#dialog-input');
  const confirmBtn = $('#dialog-confirm');

  $('#dialog-title').textContent = title;
  $('#dialog-body').textContent = body;
  field.hidden = input === null;
  inputEl.value = input ?? '';
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = `btn ${danger ? 'danger' : 'primary'}`;

  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue !== 'confirm') return resolve(null);
      resolve(input === null ? true : inputEl.value.trim());
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
    if (input !== null) { inputEl.focus(); inputEl.select(); }
    // A destructive dialog defaults to the safe choice — confirming should
    // take a deliberate move, not a reflexive Enter.
    else if (danger) $('#dialog-cancel').focus();
    else confirmBtn.focus();
  });
}

// Clicking the backdrop cancels, matching Esc.
$('#dialog').addEventListener('click', event => {
  if (event.target === $('#dialog')) $('#dialog').close('cancel');
});

/* ============================================================
   theme
   ============================================================ */

const THEME_KEY = 'make.theme';

function applyTheme(pref) {
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  localStorage.setItem(THEME_KEY, pref);
  // The `.on` class is styling; aria-pressed is what assistive tech reads.
  $$('#theme-seg button').forEach(b => {
    const on = b.dataset.theme === pref;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/* ============================================================
   technical details — off by default

   Most people here want a working extension, not source code. The Code tab
   and the raw log stay out of the way until someone asks for them.
   ============================================================ */

const TECH_KEY = 'make.technical';
const technicalOn = () => localStorage.getItem(TECH_KEY) === 'on';

function applyTechnical(pref) {
  localStorage.setItem(TECH_KEY, pref);
  $$('#tech-seg button').forEach(b => {
    const on = b.dataset.tech === pref;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  syncTechnical();
}

function syncTechnical() {
  const on = technicalOn();
  $('#log-levels').hidden = !on;
  updateCodeTab();

  if (!on) {
    // Back out of anything technical the user was already looking at.
    if (state.logLevel !== 'activity') {
      state.logLevel = 'activity';
      $$('#log-levels button').forEach(b => b.classList.toggle('on', b.dataset.level === 'activity'));
    }
    if (state.tab === 'files') setTab('spec');
    if (!$('#pane-code').hidden) {
      state.filePath = null;
      renderFiles();
      showPane('chat');
    }
  }

  if (state.view === 'project') {
    renderLogs();
    renderRail();
  }
}

/* ============================================================
   state
   ============================================================ */

const state = {
  view: null,
  projectId: null,
  project: null,
  files: [],
  tab: 'spec',
  logLevel: 'activity',
  filePath: null,
  lastActivity: '',
  lastStatus: null,
  history: [],          // full conversation, for revealing earlier messages
  chatFrom: 0,          // index of the first message on screen
  chatStick: true,      // follow new messages?
  chatAbort: null,      // AbortController for the turn in flight
  activityShown: 12,    // steps visible in the timeline
  pane: 'main',         // which pane is showing on narrow screens
  provider: 'openai',   // which settings profile is on screen
  search: '',
  poll: null,
  token: 0,   // bumped on navigation; async work checks it before touching the DOM
};

const logs = { activity: [], technical: [] };
const logCursor = { activity: null, technical: null };

const STATUS_LABEL = {
  draft: 'Draft',
  building: 'Building',
  ready: 'Ready',
  stale: 'Update pending',
  error: 'Needs attention',
};

// "Ready" is a lie once the plan has moved past what was built — say so.
const displayStatus = project => (project.status === 'ready' && project.stale) ? 'stale' : project.status;

/* ============================================================
   router
   ============================================================ */

function parseHash() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] === 'projects') return { view: 'projects' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'p' && parts[1]) return { view: 'project', id: parts[1] };
  return { view: 'home' };
}

function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('on', v.id === `view-${name}`));
  $$('.topnav > a').forEach(a => a.classList.toggle('on', a.dataset.nav === name));
  state.view = name;
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

const VIEW_HEADING = {
  home: 'home-h',
  projects: 'projects-h',
  settings: 'settings-h',
  project: 'proj-title',
};

let booted = false;

function route() {
  const target = parseHash();

  // Re-entering the project you're already on shouldn't tear anything down.
  if (target.view === 'project' && state.view === 'project' && state.projectId === target.id) return;

  stopPolling();
  state.token++;
  showView(target.view);

  if (target.view === 'home') renderHome();
  else if (target.view === 'projects') renderProjects();
  else if (target.view === 'settings') loadSettings();
  else if (target.view === 'project') openProject(target.id);

  // Move focus to the new view's heading so keyboard and screen-reader users
  // land somewhere meaningful — but never on first paint, where stealing
  // focus reads as a bug.
  if (booted) {
    const heading = document.getElementById(VIEW_HEADING[target.view]);
    if (heading) {
      heading.focus({ preventScroll: true });
      $('#route-announcer').textContent = `Navigated to ${heading.textContent.trim() || target.view}`;
    }
  }
  booted = true;

  // The shell doesn't scroll any more — reset the region that does.
  const active = $('.view.on');
  if (active) active.scrollTop = 0;
}

/* ============================================================
   home
   ============================================================ */

// A first-run user with no model configured would otherwise type a sentence,
// press Start, and meet a failure. Say the quiet part up front instead — and
// leave the composer working, because a returning user can fix it later.
async function renderSetupCard() {
  let card = $('#setup-card');
  try {
    const config = await api('/api/config');
    if (config.model) {
      if (card) card.remove();
      return;
    }
    if (card) return;
    card = el('div', { class: 'setup-card', id: 'setup-card' },
      el('b', { text: 'One thing first.' }),
      ' make. needs an AI model to think with. ',
      el('a', { href: '#/settings', text: 'Add your API details' }),
      ' — it takes about a minute, and only happens once.');
    const composer = $('#home-composer');
    composer.parentNode.insertBefore(card, composer);
  } catch {
    // Config unreachable — the composer still works; don't add noise.
  }
}

async function renderHome() {
  notice('#home-notice', '');
  renderSetupCard();

  const box = $('#home-recent');
  const rows = $('#home-recent-rows');
  rows.textContent = '';
  rows.append(skeletonRow(), skeletonRow());
  box.hidden = false;

  try {
    const projects = await api('/api/projects');
    const recent = projects.slice(0, 4);
    box.hidden = recent.length === 0;
    rows.textContent = '';
    recent.forEach(p => rows.append(projectRow(p, { compact: true })));
  } catch {
    box.hidden = true;
    rows.textContent = '';
  }
}

async function startProject() {
  const field = $('#prompt-text');
  const button = $('#prompt-submit');
  const text = field.value.trim();
  if (!text) {
    notice('#home-notice', 'Tell it what you want first — one sentence is enough.');
    field.focus();
    return;
  }

  notice('#home-notice', '');
  busy(button, true);
  try {
    const project = await api('/api/projects', { method: 'POST', body: { text } });
    field.value = '';
    autoGrow(field);
    location.hash = `#/p/${project.id}`;
  } catch (err) {
    notice('#home-notice', plainError(err.message));
  } finally {
    busy(button, false);
  }
}

/* ============================================================
   projects
   ============================================================ */

// Layout-matched placeholders, so nothing jumps when the real data lands.
// Decorative: one polite "Loading…" is announced instead of the shapes.
function skeletonRow() {
  return el('li', { class: 'row', 'aria-hidden': 'true' },
    el('div', { class: 'row-ident' },
      el('div', { class: 'sk row-icon' }),
      el('div', { class: 'row-text', style: 'flex:1' },
        el('div', { class: 'sk line', style: 'width:38%' }),
        el('div', { class: 'sk line', style: 'width:62%;margin-top:8px;height:10px' }))),
    el('span', { class: 'sk line', style: 'width:70px;height:10px' }),
    el('span', {}), el('span', {}));
}

// Until the model names it, the user's own words beat the word "Untitled".
function projectName(project) {
  if (project.title) return project.title;
  const prompt = (project.prompt || '').trim();
  if (!prompt) return 'Untitled';
  return prompt.length > 44 ? `${prompt.slice(0, 44).trimEnd()}…` : prompt;
}

function monogram(project) {
  const source = (project.title || project.prompt || '?').trim();
  return source.charAt(0).toUpperCase() || '?';
}

function statusChip(project) {
  const shown = displayStatus(project);
  return el('span', { class: 'status', 'data-status': shown },
    el('i', { class: 'dot' }),
    el('span', { text: STATUS_LABEL[shown] || shown }));
}

// SVG needs its own namespace, so el() (createElement) can't build it.
function icon(pathData) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

function trashButton(project) {
  return el('button', {
    class: 'icon-btn subtle danger',
    'aria-label': `Delete ${projectName(project)}`,
    title: 'Delete',
    onclick: () => removeProject(project),
  }, icon('M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12'));
}

function projectRow(project, { compact = false } = {}) {
  // Delete is here, but set apart from the safe actions by a divider and
  // reduced to an icon — it shouldn't read as a peer of Open and Download.
  // It still goes through confirm-then-undo.
  const actions = el('div', { class: 'row-actions' },
    el('a', { class: 'btn ghost small', href: `#/p/${project.id}` },
      project.status === 'ready' ? 'Open' : 'Continue'),
    !compact && project.hasBuild && el('a', {
      class: 'btn ghost small',
      href: `/api/projects/${project.id}/download`,
    }, 'Download'),
    !compact && el('span', { class: 'action-split', 'aria-hidden': 'true' }),
    !compact && trashButton(project));

  return el('li', { class: 'row' },
    el('div', { class: 'row-ident' },
      el('div', { class: 'mono-icon', 'aria-hidden': 'true', text: monogram(project) }),
      el('div', { class: 'row-text' },
        el('div', { class: 'row-name' },
          el('a', { href: `#/p/${project.id}`, text: projectName(project) })),
        // The model often names similar things identically — the prompt is
        // what tells two "Shorts Hider" rows apart.
        el('div', { class: 'row-sub', text: project.prompt || project.kind }))),
    statusChip(project),
    el('span', { class: 'row-when', text: relTime(project.updatedAt), title: absTime(project.updatedAt) }),
    actions);
}

async function renderProjects() {
  const list = $('#projects-rows');
  const empty = $('#projects-empty');

  if (!list.children.length) {
    empty.hidden = true;
    list.append(skeletonRow(), skeletonRow(), skeletonRow());
    $('#projects-count').textContent = 'Loading…';
  }

  let projects;
  try {
    projects = await api('/api/projects');
  } catch (err) {
    list.textContent = '';
    toast(plainError(err.message), 'err');
    return;
  }

  const query = state.search.trim().toLowerCase();
  const shown = projects.filter(p => !query
    || (p.title || '').toLowerCase().includes(query)
    || (p.prompt || '').toLowerCase().includes(query));

  list.textContent = '';
  shown.forEach(p => list.append(projectRow(p)));

  $('#projects-count').textContent = shown.length
    ? `${shown.length} project${shown.length === 1 ? '' : 's'}`
    : 'No matches';

  // Every empty state educates and offers exactly one next step.
  empty.hidden = shown.length > 0;
  empty.textContent = '';
  if (projects.length === 0) {
    empty.append(
      el('p', { class: 'empty-title', text: 'Nothing here yet.' }),
      el('p', { text: 'Your extensions will live here — made from plain-words descriptions.' }),
      el('a', { class: 'btn primary', href: '#/', text: 'Describe something' }));
  } else if (shown.length === 0) {
    empty.append(
      el('p', { text: `Nothing matches “${state.search.trim()}”.` }),
      el('button', {
        class: 'btn ghost small',
        onclick: () => {
          $('#projects-search').value = '';
          state.search = '';
          renderProjects();
          $('#projects-search').focus();
        },
      }, 'Clear search'));
  }
}

// Pause first (a deliberate confirm), safety net after (an undo window).
// Tired people tunnel-vision through confirms; irreversible loss needs both.
async function removeProject(project) {
  const ok = await ask({
    title: `Delete “${projectName(project)}”?`,
    body: 'The conversation and the built extension go with it. You’ll get a few seconds to undo.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;

  const refresh = () => {
    if (state.view === 'projects') renderProjects();
    else if (state.view === 'home') renderHome();
  };

  try {
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    if (state.view === 'project' && state.projectId === project.id) location.hash = '#/projects';
    else refresh();

    toast('Project deleted.', '', {
      label: 'Undo',
      fn: async () => {
        try {
          await api(`/api/projects/${project.id}/restore`, { method: 'POST' });
          toast('Restored.');
          refresh();
        } catch (err) {
          toast(plainError(err.message), 'err');
        }
      },
    });
  } catch (err) {
    toast(plainError(err.message), 'err');
  }
}

/* ============================================================
   project — shell
   ============================================================ */

function resetProjectUI() {
  $('#chat').textContent = '';
  $('#spec-list').textContent = '';
  $('#file-list').textContent = '';
  $('#log-lines').textContent = '';
  $('#chat-text').value = '';
  $('#chat-status').textContent = '';
  $('#code-body').textContent = '';
  $('#rail-actions').textContent = '';
  notice('#chat-notice', '');

  logs.activity = [];
  logs.technical = [];
  logCursor.activity = null;
  logCursor.technical = null;
  state.files = [];
  state.filePath = null;
  state.lastActivity = '';
  state.lastStatus = null;
  state.history = [];
  state.chatFrom = 0;
  state.chatStick = true;
  state.activityShown = 12;
  showPane('chat');
  setPane('main');
  setTab('spec');
}

async function openProject(id) {
  const token = state.token;
  state.projectId = id;
  resetProjectUI();

  // Placeholders in the real shapes, so the pane doesn't sit blank and then jump.
  const chat = $('#chat');
  chat.append(
    el('div', { class: 'sk bubble-ghost me', 'aria-hidden': 'true' }),
    el('div', { class: 'sk bubble-ghost', 'aria-hidden': 'true' }),
    el('div', { class: 'sk bubble-ghost me', 'aria-hidden': 'true', style: 'max-width:35%' }));
  $('#spec-list').append(...Array.from({ length: 4 }, (_, i) =>
    el('li', { 'aria-hidden': 'true', style: 'border:none' },
      el('span', { class: 'sk line', style: `width:${[86, 72, 91, 64][i]}%` }))));

  let project;
  try {
    project = await api(`/api/projects/${id}`);
  } catch (err) {
    toast(err.status === 404 ? 'That project is gone — it may have been deleted.' : plainError(err.message), 'err');
    location.hash = '#/projects';
    return;
  }
  if (token !== state.token) return;

  state.project = project;
  state.lastStatus = project.status;
  document.title = `make. — ${projectName(project)}`;

  renderIdentity(project);
  state.history = project.history.slice();
  // A project seconds old has no recorded turns yet, but the prompt it was
  // created from is the first thing the user said.
  if (!state.history.length && project.prompt) {
    state.history.push({ role: 'user', content: project.prompt });
  }
  renderChatWindow();
  renderSpec(project);
  renderStatusBits(project);

  await Promise.all([pullLogs('activity'), refreshFiles()]);
  if (token !== state.token) return;
  renderLogs();
  renderRail();

  if (project.status === 'building') {
    setTab('logs');
    startPolling();
  }

  // A project created seconds ago has no conversation yet — open with the
  // model's first question instead of making the user say it twice.
  if (!project.history.length && project.status === 'draft') sendChat('');
}

function renderIdentity(project) {
  $('#proj-title').textContent = projectName(project);
}

function renderStatusBits(project) {
  const chip = $('#proj-status');
  const shown = displayStatus(project);
  chip.dataset.status = shown;
  $('span', chip).textContent = STATUS_LABEL[shown] || shown;

  const building = project.status === 'building';
  $('#build-strip').hidden = !building;
  if (building) {
    const pct = Math.max(0, Math.min(100, project.percent || 0));
    $('#progress-fill').style.width = `${pct}%`;
    $('#progress-pct').textContent = `${Math.round(pct)}%`;
    $('.build-strip .bar').setAttribute('aria-valuenow', String(Math.round(pct)));

    // A long model call genuinely parks at one number; say so rather than
    // letting silence read as a hang.
    const stalledFor = state.percentSince ? Date.now() - state.percentSince : 0;
    const stage = state.lastActivity || 'Starting…';
    $('#progress-line').textContent = stalledFor > 20000
      ? `${stage} — still going, nothing is stuck`
      : stage;
  }
  setComposerEnabled(!building);
}

function setComposerEnabled(on) {
  $('#chat-text').disabled = !on;
  $('#chat-send').disabled = !on;
  $('#chat-text').placeholder = on
    ? 'Reply in plain words…'
    : 'Building — you can send changes when it finishes.';
}

function renderSpec(project) {
  const list = $('#spec-list');
  list.textContent = '';

  // The rail foot says this too, but the foot can be scrolled away — put it
  // where the changed bullets actually are.
  const banner = $('#plan-banner');
  banner.hidden = !project.stale;
  banner.textContent = 'Plan changed since the last build — rebuild to get the new version.';

  // Anything not in the snapshot the current build came from is a pending
  // change — flag it so "what's different now" is visible at a glance.
  const built = Array.isArray(project.builtSpec) ? new Set(project.builtSpec) : null;

  (project.spec || []).forEach(item => {
    const pending = Boolean(built) && !built.has(item);
    list.append(el('li', { class: pending ? 'changed' : '' },
      el('span', { class: 'spec-text', text: item }),
      pending && el('span', { class: 'tag', text: 'new' })));
  });

  $('#spec-empty').hidden = (project.spec || []).length > 0;
}

/* ============================================================
   project — panes and tabs
   ============================================================ */

function showPane(which) {
  $('#pane-chat').hidden = which !== 'chat';
  $('#pane-code').hidden = which !== 'code';
}

// Which half of the workspace is on screen. Only has an effect below 980px,
// where the two panes share the viewport instead of sitting side by side.
function setPane(which) {
  state.pane = which;
  $('#workspace').dataset.pane = which;
  $$('#pane-switch button').forEach(b => {
    const on = b.dataset.pane === which;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

const isNarrow = () => window.matchMedia('(max-width: 980px)').matches;

function setTab(name, { focus = false } = {}) {
  state.tab = name;
  $$('#rail-tabs .tab').forEach(tab => {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    // Roving tabindex: one stop for the tablist, arrows move within it.
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  });
  $$('.rail-body .panel').forEach(panel => { panel.hidden = panel.id !== `panel-${name}`; });
  if (name === 'logs') renderLogs();
}

const visibleTabs = () => $$('#rail-tabs .tab').filter(tab => !tab.hidden && !tab.disabled);

function moveTab(step) {
  const tabs = visibleTabs();
  const current = tabs.findIndex(tab => tab.dataset.tab === state.tab);
  const next = tabs[(current + step + tabs.length) % tabs.length];
  if (next) setTab(next.dataset.tab, { focus: true });
}

function updateCodeTab() {
  const tab = $('#tab-files');
  const show = technicalOn() && state.files.length > 0;
  tab.hidden = !show;
  tab.textContent = 'Code';
  if (show) tab.append(el('span', { class: 'count', text: String(state.files.length) }));
}

/* ============================================================
   project — chat
   ============================================================ */

const CHAT_WINDOW = 8;    // messages shown before you ask for more
const REVEAL_STEP = 10;

function addBubble(kind, text) {
  const bubble = el('div', { class: `bubble ${kind}`, text });
  $('#chat').append(bubble);
  scrollChat();
  return bubble;
}

const bubbleFor = turn =>
  el('div', { class: `bubble ${turn.role === 'user' ? 'me' : 'them'}`, text: turn.content });

// Only the tail of the conversation is on screen; the rest sits behind the
// gate. Long threads otherwise open scrolled to the middle of nowhere.
function renderChatWindow() {
  const chat = $('#chat');
  chat.textContent = '';
  state.chatFrom = Math.max(0, state.history.length - CHAT_WINDOW);
  state.history.slice(state.chatFrom).forEach(turn => chat.append(bubbleFor(turn)));
  renderChatGate();
  scrollChat(true);
}

function renderChatGate() {
  const chat = $('#chat');
  const existing = $('.chat-gate', chat);
  if (existing) existing.remove();

  const hidden = state.chatFrom;
  if (hidden <= 0) return;

  const gate = el('div', { class: 'chat-gate' },
    el('button', {
      class: 'linkish',
      onclick: () => revealChat(REVEAL_STEP),
    }, `Show ${Math.min(REVEAL_STEP, hidden)} earlier`),
    hidden > REVEAL_STEP && el('span', { class: 'sep', text: '·' }),
    hidden > REVEAL_STEP && el('button', {
      class: 'linkish',
      onclick: () => revealChat(Infinity),
    }, `Show all (${hidden})`));

  chat.insertBefore(gate, chat.firstChild);
}

function revealChat(count) {
  const chat = $('#chat');
  const before = chat.scrollHeight;
  const from = count === Infinity ? 0 : Math.max(0, state.chatFrom - count);

  const batch = document.createDocumentFragment();
  state.history.slice(from, state.chatFrom).forEach(turn => batch.append(bubbleFor(turn)));
  state.chatFrom = from;

  const gate = $('.chat-gate', chat);
  chat.insertBefore(batch, gate ? gate.nextSibling : chat.firstChild);
  renderChatGate();

  // Hold the reader's place instead of jumping to the newly added top.
  chat.scrollTop += chat.scrollHeight - before;
  updateJumpButton();
}

function chatAtBottom() {
  const chat = $('#chat');
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

// Follow the conversation only while the reader is already at the bottom —
// yanking them down mid-scroll is the classic chat-UI sin. Stickiness is
// decided by the last scroll the reader made, not by measuring after new
// content has already changed the height.
function scrollChat(force = false) {
  const chat = $('#chat');
  if (force || state.chatStick) {
    chat.scrollTop = chat.scrollHeight;
    state.chatStick = true;
  }
  updateJumpButton();
}

function updateJumpButton() {
  $('#chat-jump').hidden = chatAtBottom();
}

function autoGrow(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

async function sendChat(message) {
  const token = state.token;
  const projectId = state.projectId;
  const field = $('#chat-text');
  const sendBtn = $('#chat-send');
  const live = () => token === state.token && state.projectId === projectId;

  if (message) {
    state.history.push({ role: 'user', content: message });
    state.chatStick = true;
    addBubble('me', message);
    field.value = '';
    autoGrow(field);
  }

  notice('#chat-notice', '');
  // No spinner on the button — it turns into Stop, so it must stay clickable.
  field.disabled = true;

  // The thinking bubble is never announced — the status line already says
  // "thinking…", and reasoning text is opt-in.
  const thinking = addBubble('them thinking pending', 'Thinking…');
  thinking.setAttribute('aria-hidden', 'true');
  let thinkingText = '';
  let reply = null;
  let replyText = '';
  let anchored = false;

  const started = Date.now();
  const ticker = setInterval(() => {
    if (!live()) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    const stage = reply ? 'answering' : 'thinking';
    // Past half a minute, silence starts to read as a hang.
    $('#chat-status').textContent = seconds > 30
      ? `${stage}… ${seconds}s — big questions take a bit`
      : `${stage}… ${seconds}s`;
  }, 1000);
  $('#chat-status').textContent = 'thinking… 0s';

  // Lets the user call off a turn that is taking too long. The server aborts
  // its own model call when this request closes.
  const canceller = new AbortController();
  state.chatAbort = canceller;
  setSendStopping(true);

  try {
    const res = await fetch(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || '' }),
      signal: canceller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;

        let event;
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (!live()) continue;

        if (event.type === 'thinking') {
          // Raw reasoning is noise unless you asked for it — everyone else
          // keeps the plain "Thinking…" placeholder until the answer lands.
          if (!technicalOn()) continue;
          thinking.classList.remove('pending');
          thinkingText += event.delta;
          // Reasoning runs long — keep the tail, which is where it lands.
          thinking.textContent = thinkingText.length > 400 ? `…${thinkingText.slice(-400)}` : thinkingText;
          scrollChat();
        } else if (event.type === 'reply') {
          if (!reply) {
            thinking.classList.remove('pending');
            if (thinkingText) thinking.classList.add('settled');
            else thinking.remove();
            reply = addBubble('them', '');
            // Hidden from assistive tech while it grows; the finished message
            // is added as a fresh node below, announcing exactly once.
            reply.setAttribute('aria-hidden', 'true');
          }
          replyText += event.delta;
          reply.textContent = replyText;

          // For a long answer, hold the top of it in view rather than dragging
          // the reader along to the tail they haven't read yet.
          if (state.chatStick && !anchored && reply.offsetHeight > $('#chat').clientHeight * 1.5) {
            anchored = true;
            state.chatStick = false;
            reply.scrollIntoView({ block: 'start', behavior: 'auto' });
          }
          scrollChat();
        } else if (event.type === 'done') {
          if (thinkingText) thinking.classList.add('settled');
          else thinking.remove();
          // Swap the silent streaming node for a plain one: a single addition
          // to the log region, announced once, in full.
          if (reply) reply.remove();
          reply = addBubble('them', event.reply);
          state.history.push({ role: 'assistant', content: event.reply });
          state.project = { ...state.project, spec: event.spec, title: event.title, status: event.status };
          renderSpec(state.project);
          renderIdentity(state.project);
          renderRail();
          document.title = `make. — ${projectName(state.project)}`;
          scrollChat();
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    }
  } catch (err) {
    if (live()) {
      thinking.remove();
      if (reply) reply.remove();
      // The server only records a completed turn, so a cancelled one leaves
      // nothing behind — and the words go back in the box either way.
      const stopped = err.name === 'AbortError';
      notice('#chat-notice', stopped
        ? 'Stopped — nothing was added.'
        : plainError(err.message));
      if (message) { field.value = message; autoGrow(field); }
    }
  } finally {
    clearInterval(ticker);
    if (state.chatAbort === canceller) state.chatAbort = null;
    if (live()) {
      $('#chat-status').textContent = '';
      setSendStopping(false);
      busy(sendBtn, false);
      field.disabled = state.project?.status === 'building';
      if (!field.disabled) field.focus();
      pullLogs('activity').then(() => { if (live() && state.tab === 'logs') renderLogs(); });
      // The turn may have changed the spec, which is what decides whether the
      // existing build is now out of date — ask the server rather than guess.
      refreshProject();
    }
  }
}

// The Send button becomes Stop for the duration of a turn: same slot, same
// size, no layout shift.
function setSendStopping(on) {
  const btn = $('#chat-send');
  btn.textContent = on ? 'Stop' : 'Send';
  btn.classList.toggle('primary', !on);
  btn.setAttribute('aria-label', on ? 'Stop this reply' : 'Send');
  btn.disabled = false;
}

async function refreshProject() {
  const token = state.token;
  try {
    const project = await api(`/api/projects/${state.projectId}`);
    if (token !== state.token) return;
    state.project = project;
    renderIdentity(project);
    renderSpec(project);
    renderStatusBits(project);
    renderRail();
  } catch {
    // Leave the last known state on screen.
  }
}

/* ============================================================
   project — files
   ============================================================ */

async function refreshFiles() {
  try {
    state.files = await api(`/api/projects/${state.projectId}/files`);
  } catch {
    state.files = [];
  }
  renderFiles();
  updateCodeTab();
}

function renderFiles() {
  const list = $('#file-list');
  list.textContent = '';
  state.files.forEach(file => {
    list.append(el('li', {},
      el('button', { class: file.path === state.filePath ? 'on' : '', onclick: () => openFile(file.path) },
        el('span', { text: file.path }),
        el('span', { class: 'size', text: fmtSize(file.size) }))));
  });
  $('#files-empty').hidden = state.files.length > 0;
}

async function openFile(path) {
  const token = state.token;
  try {
    const file = await api(`/api/projects/${state.projectId}/file?path=${encodeURIComponent(path)}`);
    if (token !== state.token) return;
    state.filePath = path;
    $('#code-name').textContent = path;
    $('#code-body').textContent = file.text;
    $('#code-body').scrollTop = 0;
    showPane('code');
    renderFiles();
    // The reader lives in the wide pane, which on narrow screens means
    // switching away from the file list that was just tapped.
    if (isNarrow()) setPane('main');
  } catch (err) {
    toast(plainError(err.message), 'err');
  }
}

/* ============================================================
   project — logs
   ============================================================ */

// The clarify stage logs both sides of the conversation at activity level.
// That is already sitting in the chat pane a few inches away, so it is noise
// in the timeline — the timeline is for what the machine actually did.
const isChatLine = line => /^(you|make) · /.test(line);

const buildSteps = () => logs.activity.filter(row => !isChatLine(row.line));

async function pullLogs(level) {
  const query = logCursor[level] ? `&since=${encodeURIComponent(logCursor[level])}` : '';
  try {
    const rows = await api(`/api/projects/${state.projectId}/logs?level=${level}${query}`);
    if (rows.length) {
      logs[level].push(...rows);
      logCursor[level] = rows[rows.length - 1].t;
      if (level === 'activity') {
        const steps = rows.filter(row => !isChatLine(row.line));
        if (steps.length) state.lastActivity = steps[steps.length - 1].line;
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function renderLogs() {
  const box = $('#log-lines');
  if (technicalOn() && state.logLevel === 'technical') {
    box.textContent = '';
    renderRawLog(box);
    return;
  }
  renderTimeline(box);   // reconciles its own children
}

// Each build run opens with one of these lines.
const RUN_START = /^(build started|applying your changes)$/;

const stepKey = row => `${row.t}|${row.line}`;

function stepNode(row) {
  return el('div', { class: 'tl-item', 'data-key': stepKey(row) },
    el('div', { class: 'tl-mark', 'aria-hidden': 'true' }),
    el('div', { class: 'tl-text', text: row.line }));
}

function stepKind(row, isLast, building) {
  if (/went wrong|stopped|interrupted|problem/i.test(row.line)) return 'err';
  return building && isLast ? 'live' : 'done';
}

function renderTimeline(box) {
  const steps = buildSteps();

  if (!steps.length) {
    box.textContent = '';
    box.append(el('p', {
      class: 'empty-note',
      text: 'Nothing has happened yet — you’re still describing what you want.',
    }));
    return;
  }

  const building = state.project?.status === 'building';

  // Always keep the run that is happening now whole, however long it runs.
  let runStart = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (RUN_START.test(steps[i].line)) { runStart = i; break; }
  }

  const atLeast = building ? steps.length - runStart : 0;
  const shown = Math.min(steps.length, Math.max(state.activityShown, atLeast));
  const from = steps.length - shown;
  const visible = steps.slice(from);

  const stale = box.querySelector('.empty-note');
  if (stale) stale.remove();

  const oldReveal = box.querySelector('.reveal-row');
  if (oldReveal) oldReveal.remove();
  if (from > 0) {
    const step = Math.min(REVEAL_STEP, from);
    box.prepend(el('div', { class: 'reveal-row' },
      el('button', {
        class: 'linkish',
        onclick: () => { state.activityShown = shown + REVEAL_STEP; renderLogs(); },
      }, `Show ${step} more`),
      from > step && el('span', { class: 'sep', text: '·' }),
      from > step && el('button', {
        class: 'linkish',
        onclick: () => { state.activityShown = Infinity; renderLogs(); },
      }, `Show all (${steps.length})`)));
  }

  let list = box.querySelector('.timeline');
  if (!list) {
    list = el('div', { class: 'timeline' });
    box.append(list);
  }

  // Reconcile rather than rebuild. This runs once a second during a build, and
  // replacing the nodes restarted the live step's CSS animation every tick —
  // which is why the pulse faded in and then snapped back to the start.
  const nodes = [...list.children];
  let shared = 0;
  while (shared < nodes.length && shared < visible.length
         && nodes[shared].dataset.key === stepKey(visible[shared])) shared++;

  for (const dead of nodes.slice(shared)) dead.remove();
  for (let i = shared; i < visible.length; i++) list.append(stepNode(visible[i]));

  // Only the kind can change on a surviving node (live → done). Assigning the
  // same className is a no-op, so untouched animations keep running.
  [...list.children].forEach((node, i) => {
    const kind = stepKind(visible[i], i === visible.length - 1, building);
    if (node.className !== `tl-item ${kind}`) node.className = `tl-item ${kind}`;
  });
}

// Re-rendering the list resets its scroll; keep the newest step in view when
// the reader was already at the bottom.
function renderLogsKeepingPlace() {
  const body = $('.rail-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  renderLogs();
  if (atBottom) body.scrollTop = body.scrollHeight;
}

function renderRawLog(box) {
  const rows = logs.technical;
  if (!rows.length) {
    box.append(el('p', { class: 'empty-note', text: 'Nothing logged yet.' }));
    return;
  }

  const log = el('div', { class: 'log' });
  rows.forEach(row => {
    log.append(el('div', { class: `line${/error|failed|check failed/i.test(row.line) ? ' err' : ''}` },
      el('span', { class: 'ts', text: clockOf(row.t, true) }),
      el('span', { text: row.line })));
  });
  box.append(log);
}

/* ============================================================
   project — action rail
   ============================================================ */

// The download is not the finish line — this is where a novice gives up.
// Opening an unsigned .xpi directly makes Firefox say it "appears to be
// corrupt", which is a lie about the file and reads as "the build failed".
// Lead with that, because everyone hits it.
function installHelp() {
  return el('details', { class: 'install-guide', id: 'install-guide' },
    el('summary', { text: 'How to install' }),
    el('p', { class: 'hint alert' },
      'Don’t open the downloaded file directly — Firefox will say it “appears to be corrupt”. ',
      'It isn’t. That message just means “unsigned”. Do this instead:'),
    el('ol', {},
      el('li', {},
        el('span', { class: 'step-copy' },
          'Copy this address: ',
          el('code', { text: 'about:debugging' }),
          el('button', {
            class: 'btn ghost small',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText('about:debugging');
                toast('Copied — paste it into Firefox’s address bar.');
              } catch {
                toast('Could not access the clipboard.', 'err');
              }
            },
          }, 'Copy'))),
      el('li', {}, 'Paste it into Firefox’s address bar and press Enter.'),
      el('li', {}, 'Click ', el('b', { text: 'This Firefox' }), ' on the left.'),
      el('li', {}, 'Click ', el('b', { text: 'Load Temporary Add-on…' }), ' and choose the file you just downloaded.')),
    el('p', { class: 'hint alert' },
      'It works right away. One catch: because it’s unsigned, Firefox removes it when you restart ',
      'the browser — come back here and repeat step 4, or ask in the chat to rebuild and you’ll get a fresh file.'),
    el('details', {},
      el('summary', { text: 'Make it permanent' }),
      el('p', { text: 'Signing the file at addons.mozilla.org is free and needs no review for self-distribution, and a signed add-on survives restarts. Firefox Developer Edition can also load unsigned add-ons once xpinstall.signatures.required is turned off.' })));
}

// What this extension can do, in plain language, at the moment you decide
// whether to install it. The manifest already says all of this; nobody opens
// the manifest. High-risk items are never hidden behind a disclosure.
function permissionsPanel(report) {
  if (!report) return null;
  const { permissions: perms = [], exposures = [], worst = 'low' } = report;
  if (!perms.length && !exposures.length) return null;

  const body = el('div', { class: 'perm-body' });

  for (const item of perms) {
    body.append(el('div', { class: `perm-item risk-${item.risk}` },
      el('i', { class: 'perm-dot', 'aria-hidden': 'true' }),
      el('div', {},
        el('div', { class: 'perm-says', text: item.says }),
        el('code', { class: 'perm-name', text: item.name }))));
  }

  for (const item of exposures) {
    body.append(el('div', { class: `perm-item risk-${item.risk} perm-exposure` },
      el('i', { class: 'perm-dot', 'aria-hidden': 'true' }),
      el('div', {},
        el('div', { class: 'perm-says' }, el('b', { text: 'A website could reach in. ' }), item.means),
        el('div', { class: 'perm-detail', text: `${item.file} ${item.says}` }),
        el('div', { class: 'perm-detail', text: `Ask for: ${item.fix}` }))));
  }

  const heading = worst === 'high'
    ? 'What this can do — worth reading'
    : 'What this can do';

  // A high-risk build shows its teeth immediately; a tame one folds away.
  const panel = el('details', { class: `perm-panel risk-${worst}` },
    el('summary', {}, heading),
    body);
  if (worst === 'high') panel.open = true;
  return panel;
}

async function loadPermissions(projectId, foot) {
  try {
    const report = await api(`/api/projects/${projectId}/permissions`);
    if (state.projectId !== projectId || !foot.isConnected) return;
    const panel = permissionsPanel(report);
    if (panel) foot.append(panel);
  } catch {
    // Not worth an error message — the manifest is still in the Code tab.
  }
}

// Clicking Download can't tell us the file arrived, but it does tell us the
// user is now standing in front of Firefox with no idea what to do next.
function onDownloadClicked(projectId, foot) {
  const key = `make.installShown.${projectId}`;
  setTimeout(() => {
    if (state.projectId !== projectId) return;
    const hint = foot.querySelector('.hint');
    if (hint) hint.textContent = 'Downloaded. Now let’s put it in Firefox — 4 steps, about a minute.';
    const guide = $('#install-guide');
    if (guide && !sessionStorage.getItem(key)) {
      guide.open = true;
      sessionStorage.setItem(key, '1');
    }
  }, 400);
}

function renderRail() {
  const project = state.project;
  const foot = $('#rail-actions');
  foot.textContent = '';
  if (!project) return;

  if (project.status === 'building') {
    // Secondary, not primary — stopping is an escape hatch, not the goal.
    foot.append(el('button', { class: 'btn wide', onclick: onStop }, 'Stop build'));
    foot.append(el('p', { class: 'hint', text: 'Stopping throws away this attempt — nothing is kept.' }));
    return;
  }

  if (project.status === 'ready') {
    const download = `/api/projects/${project.id}/download`;
    const when = project.builtAt ? relTime(project.builtAt) : null;

    if (project.stale) {
      // The plan has changed since this .xpi was made. Lead with the update,
      // and be explicit that the download is the older version.
      foot.append(el('p', { class: 'hint alert', text: 'Your plan changed since this was built.' }));
      foot.append(el('button', { class: 'btn primary wide', onclick: onBuild }, 'Update the extension'));
      const old = el('a', { class: 'btn wide', href: download }, 'Download the older version');
      old.addEventListener('click', () => onDownloadClicked(project.id, foot));
      foot.append(old);
      foot.append(el('p', {
        class: 'hint',
        text: when ? `That file was built ${when}, before your latest changes.` : 'That file predates your latest changes.',
      }));
    } else {
      // "the extension" — nobody outside this app knows what an .xpi is.
      const get = el('a', { class: 'btn primary wide', href: download }, 'Download the extension');
      get.addEventListener('click', () => onDownloadClicked(project.id, foot));
      foot.append(get);
      foot.append(el('p', {
        class: 'hint',
        text: when
          ? `Built ${when}. Want a change? Just say it in the chat.`
          : 'Want a change? Just say it in the chat.',
      }));
      foot.append(el('p', { class: 'hint' },
        el('button', { class: 'linkish', onclick: onBuild }, 'Build it again')));
    }

    foot.append(installHelp());
    loadPermissions(project.id, foot);
    if (!technicalOn()) {
      foot.append(el('p', { class: 'hint' },
        el('button', {
          class: 'linkish',
          onclick: () => { applyTechnical('on'); setTab('files'); },
        }, 'Show me the code')));
    }
    return;
  }

  if (project.status === 'error') {
    // Raw build-exhaustion text is accurate but technical; the Activity tab
    // holds the detail for anyone who wants it.
    const detail = technicalOn()
      ? (project.error || 'The last build failed.')
      : 'The build didn’t finish — the details are in Activity.';
    foot.append(el('p', { class: 'hint', text: plainError(detail) }));
    foot.append(el('button', { class: 'btn primary wide', onclick: onBuild }, 'Try again'));
    if (project.hasBuild) {
      const last = el('a', { class: 'btn wide', href: `/api/projects/${project.id}/download` },
        'Download the last working version');
      last.addEventListener('click', () => onDownloadClicked(project.id, foot));
      foot.append(last);
      foot.append(installHelp());
    }
    return;
  }

  // Draft. A disabled primary reads as "broken" to a novice and can't be
  // focused to find out why — so when there's nothing to build, the
  // explanation takes the button's place instead of sitting under it.
  if (!(project.spec || []).length) {
    foot.append(el('p', {
      class: 'hint',
      text: 'Keep talking — when there’s a plan, the build button appears here.',
    }));
    return;
  }

  foot.append(el('button', { class: 'btn primary wide', onclick: onBuild }, 'Build it'));
  foot.append(el('p', { class: 'hint', text: 'Takes a minute or two. You can keep watching it work.' }));
}

async function onBuild(event) {
  const button = event.currentTarget;
  busy(button, true);
  try {
    await api(`/api/projects/${state.projectId}/build`, { method: 'POST' });
    state.project = { ...state.project, status: 'building', percent: 0 };
    state.lastStatus = 'building';
    state.activityShown = 12;   // this run is what matters now
    renderStatusBits(state.project);
    renderRail();
    setTab('logs');
    if (isNarrow()) setPane('rail');   // put the progress where they can see it
    startPolling();
  } catch (err) {
    busy(button, false);
    toast(plainError(err.message), 'err');
  }
}

async function onStop(event) {
  busy(event.currentTarget, true);
  try {
    await api(`/api/projects/${state.projectId}/stop`, { method: 'POST' });
  } catch (err) {
    toast(plainError(err.message), 'err');
  }
}

/* ============================================================
   project — polling while a build runs
   ============================================================ */

function startPolling() {
  stopPolling();
  const token = state.token;
  const projectId = state.projectId;

  const tick = async () => {
    if (token !== state.token || state.projectId !== projectId) return stopPolling();

    let project;
    try {
      project = await api(`/api/projects/${projectId}`);
    } catch {
      return; // transient — try again on the next tick
    }
    if (token !== state.token) return stopPolling();

    const previous = state.lastStatus;
    // Track how long the number has sat still, for the stall reassurance.
    if (project.percent !== state.lastPercent) {
      state.lastPercent = project.percent;
      state.percentSince = Date.now();
    }
    state.project = project;
    state.lastStatus = project.status;

    await pullLogs('activity');
    if (state.logLevel === 'technical') await pullLogs('technical');
    if (token !== state.token) return stopPolling();

    renderIdentity(project);
    renderSpec(project);
    renderStatusBits(project);
    if (state.tab === 'logs') renderLogsKeepingPlace();

    if (project.status === 'building') return;

    stopPolling();
    await refreshFiles();
    if (token !== state.token) return;
    renderRail();

    if (previous === 'building' && project.status === 'ready') {
      // Land on the plan and the download button, not on a wall of JavaScript.
      toast('Your extension is ready.');
      setTab('spec');
    } else if (previous === 'building' && project.status === 'error') {
      // "logs" is jargon to the person this is written for.
      toast('The build didn’t finish. The details are in Activity.', 'err');
      setTab('logs');
    }
  };

  state.poll = setInterval(tick, 1000);
  tick();
}

/* ============================================================
   settings
   ============================================================ */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function applyProvider(provider) {
  state.provider = provider;
  $$('#provider-seg button').forEach(b => {
    const on = b.dataset.provider === provider;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  // The routing controls are OpenRouter-only; the server ignores them for
  // anything else, so showing them would be a lie.
  $('#openrouter-fields').hidden = provider !== 'openrouter';
}

async function loadSettings() {
  notice('#settings-notice', '');
  applyTheme(localStorage.getItem(THEME_KEY) || 'system');
  applyTechnical(technicalOn() ? 'on' : 'off');
  try {
    const config = await api('/api/config');
    applyProvider(config.provider || 'openai');
    $('#cfg-base').value = config.baseUrl || '';
    $('#cfg-model').value = config.model || '';
    $('#cfg-context').value = config.contextTokens || 128000;
    $('#cfg-temp').value = config.temperature ?? 0.2;
    $('#cfg-maxtok').value = config.maxTokens ?? 0;
    $('#cfg-sort').value = config.sort ?? 'throughput';
    $('#cfg-quant').value = config.quantizations ?? '';
    $('#cfg-reasoning').value = config.reasoningEffort ?? 'high';
    $('#cfg-toolmode').value = config.toolMode ?? 'auto';
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = config.hasKey ? 'saved — type to replace' : 'sk-… (blank for local servers)';
  } catch (err) {
    notice('#settings-notice', plainError(err.message));
  }
}

// Validate on submit, not while typing — telling someone their half-typed URL
// is wrong is just nagging. Focus the first problem so the fix is one keystroke.
function settingsValid() {
  const base = $('#cfg-base');
  const context = $('#cfg-context');
  const problems = [];

  for (const field of [base, context]) {
    field.removeAttribute('aria-invalid');
    const stale = field.parentNode.querySelector('.field-error');
    if (stale) stale.remove();
  }

  if (base.value.trim() && !/^https?:\/\//i.test(base.value.trim())) {
    problems.push([base, 'That address should start with http:// or https://']);
  }
  const tokens = Number(context.value);
  if (context.value && (!Number.isFinite(tokens) || tokens < 8000 || tokens > 2000000)) {
    problems.push([context, 'Between 8,000 and 2,000,000 tokens']);
  }

  for (const [field, message] of problems) {
    const error = el('p', { class: 'field-error', id: `err-${field.id}`, text: message });
    field.setAttribute('aria-invalid', 'true');
    // Keep the field's existing note in the description, don't replace it.
    const note = field.parentNode.querySelector('.field-note');
    field.setAttribute('aria-describedby', [error.id, note && note.id].filter(Boolean).join(' '));
    field.parentNode.append(error);
  }

  if (problems.length) {
    document.title = 'Error: make. — Settings';
    problems[0][0].focus();
    notice('#settings-notice', problems.length === 1
      ? 'One field needs a look — it’s marked above.'
      : `${problems.length} fields need a look — they’re marked above.`);
    return false;
  }

  document.title = 'make. — Settings';
  return true;
}

function settingsPayload() {
  const payload = {
    provider: state.provider,
    baseUrl: $('#cfg-base').value.trim(),
    model: $('#cfg-model').value.trim(),
    temperature: Number($('#cfg-temp').value),
    maxTokens: Number($('#cfg-maxtok').value) || 0,
    sort: $('#cfg-sort').value,
    quantizations: $('#cfg-quant').value.trim(),
    reasoningEffort: $('#cfg-reasoning').value,
    toolMode: $('#cfg-toolmode').value,
  };
  // Only send the key when the user typed one, so a blank field keeps the saved one.
  if ($('#cfg-key').value) payload.apiKey = $('#cfg-key').value;
  const context = Number($('#cfg-context').value);
  if (Number.isFinite(context) && context > 0) payload.contextTokens = context;
  return payload;
}

async function saveSettings(event) {
  const button = event.currentTarget;
  if (!settingsValid()) return;
  busy(button, true);
  try {
    const saved = await api('/api/config', { method: 'POST', body: settingsPayload() });
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = saved.hasKey ? 'saved — type to replace' : 'sk-… (blank for local servers)';
    notice('#settings-notice', '');
    toast('Settings saved.');
  } catch (err) {
    notice('#settings-notice', plainError(err.message));
  } finally {
    busy(button, false);
  }
}

async function testSettings(event) {
  const button = event.currentTarget;
  if (!settingsValid()) return;
  busy(button, true);
  notice('#settings-notice', 'Testing…', 'ok');
  try {
    const result = await api('/api/config/test', { method: 'POST', body: settingsPayload() });
    if (result.ok) notice('#settings-notice', result.detail || 'Connection works.', 'ok');
    else notice('#settings-notice', result.error || 'That didn’t work — check the three fields and try again.');
  } catch (err) {
    notice('#settings-notice', plainError(err.message));
  } finally {
    busy(button, false);
  }
}

async function fetchModels(event) {
  const button = event.currentTarget;
  const label = button.textContent;
  button.textContent = 'Loading…';
  button.disabled = true;
  try {
    // Save first, so the endpoint queried is the one on screen.
    await api('/api/config', { method: 'POST', body: settingsPayload() });
    const { models, error } = await api('/api/config/models');
    const list = $('#model-options');
    list.textContent = '';
    models.forEach(id => list.append(el('option', { value: id })));
    if (models.length) notice('#settings-notice', `${models.length} models available — click the model field to pick one.`, 'ok');
    else notice('#settings-notice', error || 'This endpoint does not list models. Type the name by hand.');
  } catch (err) {
    notice('#settings-notice', plainError(err.message));
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

/* ============================================================
   wiring
   ============================================================ */

// home
$('#prompt-submit').addEventListener('click', startProject);
$('#prompt-text').addEventListener('input', event => {
  autoGrow(event.target);
  // The server silently truncates at 4000. Warn before the cliff rather than
  // losing the end of someone's description without telling them.
  const left = 4000 - event.target.value.length;
  const counter = $('#prompt-count');
  counter.hidden = left > 500;
  counter.textContent = `${left} characters left`;
});
$('#prompt-text').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    startProject();
  }
});
$('#home-examples').addEventListener('click', event => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  const field = $('#prompt-text');
  field.value = chip.dataset.example;
  autoGrow(field);
  field.focus();
});

// projects
$('#projects-search').addEventListener('input', event => {
  state.search = event.target.value;
  renderProjects();
});

// project — chat
$('#chat-send').addEventListener('click', () => {
  // Mid-turn the same button is Stop.
  if (state.chatAbort) { state.chatAbort.abort(); return; }
  const message = $('#chat-text').value.trim();
  if (message) sendChat(message);
});
$('#chat-text').addEventListener('input', event => autoGrow(event.target));
$('#chat-text').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#chat-send').click();
  }
});

// project — rail
$('#rail-tabs').addEventListener('click', event => {
  const tab = event.target.closest('.tab');
  if (tab && !tab.disabled) setTab(tab.dataset.tab);
});
$('#rail-tabs').addEventListener('keydown', event => {
  const tabs = visibleTabs();
  if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1); }
  else if (event.key === 'Home') { event.preventDefault(); setTab(tabs[0].dataset.tab, { focus: true }); }
  else if (event.key === 'End') { event.preventDefault(); setTab(tabs[tabs.length - 1].dataset.tab, { focus: true }); }
});
$('#log-levels').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  state.logLevel = button.dataset.level;
  $$('#log-levels button').forEach(b => {
    b.classList.toggle('on', b === button);
    b.setAttribute('aria-pressed', String(b === button));
  });
  if (!logs[state.logLevel].length) await pullLogs(state.logLevel);
  renderLogs();
});

// project — panes
$('#pane-switch').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button) setPane(button.dataset.pane);
});
// Streaming content changes the scroll height, which fires scroll events of
// its own. Only a physical input should be allowed to change stickiness —
// otherwise the view freezes mid-answer because growth looked like a scroll.
let lastPhysicalScroll = 0;
['wheel', 'touchmove', 'keydown'].forEach(evt =>
  $('#chat').addEventListener(evt, () => { lastPhysicalScroll = Date.now(); }, { passive: true }));

$('#chat').addEventListener('scroll', () => {
  if (Date.now() - lastPhysicalScroll < 150) state.chatStick = chatAtBottom();
  updateJumpButton();
});
$('#chat-jump').addEventListener('click', () => {
  state.chatStick = true;
  scrollChat(true);
});

// project — code reader
$('#code-back').addEventListener('click', () => {
  state.filePath = null;
  renderFiles();
  showPane('chat');
  scrollChat();
});
$('#code-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#code-body').textContent);
    toast('Copied to clipboard.');
  } catch {
    toast('Could not access the clipboard.', 'err');
  }
});

// project — head
$('#proj-rename').addEventListener('click', async () => {
  const project = state.project;
  if (!project) return;
  const title = await ask({ title: 'Rename project', confirmLabel: 'Save', input: project.title || '' });
  if (!title) return;
  try {
    const updated = await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { title } });
    state.project = { ...state.project, title: updated.title };
    renderIdentity(state.project);
    document.title = `make. — ${updated.title}`;
  } catch (err) {
    toast(plainError(err.message), 'err');
  }
});
$('#proj-delete').addEventListener('click', () => state.project && removeProject(state.project));

// A password field defeats checking a paste, and a wrong key here is the
// single most common way setup fails.
$('#cfg-key-eye').addEventListener('click', () => {
  const field = $('#cfg-key');
  const button = $('#cfg-key-eye');
  const wasHidden = field.type === 'password';
  field.type = wasHidden ? 'text' : 'password';
  button.textContent = wasHidden ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', String(wasHidden));
  button.setAttribute('aria-label', wasHidden ? 'Hide the API key' : 'Show the API key');
});

// Minified lines otherwise force horizontal scrolling on a phone.
$('#code-wrap').addEventListener('click', () => {
  const body = $('#code-body');
  const button = $('#code-wrap');
  const wrapping = body.style.whiteSpace === 'pre-wrap';
  body.style.whiteSpace = wrapping ? 'pre' : 'pre-wrap';
  button.setAttribute('aria-pressed', String(!wrapping));
});

$('#provider-seg').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const provider = button.dataset.provider;
  applyProvider(provider);
  // Switching to OpenRouter with the stock OpenAI URL still in the box is
  // never what anyone means.
  const base = $('#cfg-base');
  if (provider === 'openrouter' && (!base.value.trim() || /api\.openai\.com/.test(base.value))) {
    base.value = OPENROUTER_BASE;
  }
});

// settings
$('#settings-save').addEventListener('click', saveSettings);
$('#settings-test').addEventListener('click', testSettings);
$('#cfg-fetch-models').addEventListener('click', fetchModels);
$('#theme-seg').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button) applyTheme(button.dataset.theme);
});
$('#tech-seg').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button) applyTechnical(button.dataset.tech);
});

// global
document.addEventListener('keydown', event => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');

  if (event.key === '/' && state.view === 'projects' && !typing) {
    event.preventDefault();
    $('#projects-search').focus();
    return;
  }

  // Esc leaves the code reader, matching the dialog's behaviour.
  if (event.key === 'Escape' && state.view === 'project' && !$('#pane-code').hidden) {
    $('#code-back').click();
  }
});

window.addEventListener('hashchange', route);

/* ============================================================
   boot
   ============================================================ */

// Chrome/Android shrinks the layout for the keyboard via the viewport meta.
// iOS Safari ignores that, so lift the pinned chrome by hand. --kb stays 0
// everywhere else, and re-syncing on every visual-viewport event means a
// dismissed keyboard corrects itself.
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const syncKeyboard = () => {
    const lift = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(lift)}px`);
  };
  viewport.addEventListener('resize', syncKeyboard);
  viewport.addEventListener('scroll', syncKeyboard);
  syncKeyboard();
}

applyTheme(localStorage.getItem(THEME_KEY) || 'system');
applyTechnical(technicalOn() ? 'on' : 'off');
if (!location.hash) location.hash = '#/';
route();
