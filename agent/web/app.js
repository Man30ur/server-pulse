import {
  SORT_KEYS, pushHistory, renderContainers, renderHostSub, renderProcesses, renderSummary,
} from './view.js';

const TOKEN_KEY = 'server_pulse_token';
const SORT_KEY = 'server_pulse_sort';
const POLL_MS = 3000;
const $ = (id) => document.getElementById(id);
const ids = ['statusDot', 'hostName', 'hostSub', 'refreshBtn', 'authBtn', 'errorBanner', 'dashboardView',
  'authView', 'cpuVal', 'cpuSub', 'cpuBar', 'cpuSpark', 'ramVal', 'ramSub', 'ramBar', 'ramSpark', 'swapNote',
  'diskVal', 'diskSub', 'diskBar', 'details', 'loadVal', 'netVal', 'ioVal', 'containerCount', 'issues',
  'sortBtn', 'containerList', 'procToggle', 'procCount', 'procChevron', 'procList', 'authForm', 'tokenInput',
  'authStatus', 'clearTokenBtn', 'connectBtn'];
const refs = Object.fromEntries(ids.map((id) => [id, $(id)]));

const state = {
  token: '',
  data: null,
  lastOkAt: 0,
  offline: false,
  inAuth: false,
  pollTimer: null,
  hist: { cpu: [], ram: [] },
  sortKey: SORT_KEYS.includes(localStorage.getItem(SORT_KEY)) ? localStorage.getItem(SORT_KEY) : 'ram',
  expanded: new Set(),
};
const SORT_LABEL = { ram: 'RAM', cpu: 'CPU', name: 'A–Z' };

function setStatus(kind, msg = '') {
  refs.statusDot.className = `dot ${kind === 'ok' ? 'dot-ok' : kind === 'err' ? 'dot-err' : 'dot-idle'}`;
  refs.errorBanner.textContent = msg;
  refs.errorBanner.classList.toggle('hidden', !msg);
  refs.dashboardView.classList.toggle('stale', kind === 'err' && Boolean(state.data));
}

function renderAll() {
  const d = state.data;
  if (!d) return;
  document.title = `${d.hostname || 'Server-Pulse'} · CPU ${Math.round(d.cpu?.percent || 0)}% · RAM ${Math.round(d.memory?.percent || 0)}%`;
  renderSummary(refs, d, state.hist);
  renderContainers(refs, d.containers, { sortKey: state.sortKey, expanded: state.expanded });
  renderProcesses(refs, d.processes);
  renderHostSub(refs, d, state.lastOkAt, state.offline);
}

async function fetchMetrics(tok) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch('/api/metrics', { headers: { Authorization: `Bearer ${tok}` }, cache: 'no-store', signal: ctrl.signal });
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function stopPoll() {
  if (state.pollTimer !== null) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

function startPoll() {
  stopPoll();
  if (!state.inAuth && state.token && !document.hidden) {
    state.pollTimer = setInterval(() => { refresh(false); }, POLL_MS);
  }
}

function showAuth(open, msg = '') {
  state.inAuth = open;
  refs.authView.classList.toggle('hidden', !open);
  refs.dashboardView.classList.toggle('hidden', open);
  refs.authBtn.classList.toggle('active', open);
  refs.authStatus.textContent = msg;
  refs.authStatus.className = msg ? 'status-msg err' : 'status-msg';
  refs.clearTokenBtn.classList.toggle('hidden', !state.token);
  if (open) { stopPoll(); refs.tokenInput.value = ''; refs.tokenInput.focus(); } else { startPoll(); }
}

function accept(data) {
  state.data = data;
  state.lastOkAt = Date.now();
  state.offline = false;
  pushHistory(state.hist, data);
  setStatus('ok');
  renderAll();
}

async function refresh(spin = true) {
  if (!state.token) return;
  if (spin) refs.refreshBtn.classList.add('spinning');
  try {
    accept(await fetchMetrics(state.token));
  } catch (err) {
    if (err?.message === 'UNAUTHORIZED') {
      setStatus('err');
      showAuth(true, 'Invalid Bearer token (401).');
    } else {
      state.offline = true;
      setStatus('err', 'Server offline or timed out. Showing last known data.');
      renderHostSub(refs, state.data, state.lastOkAt, true);
    }
  } finally {
    refs.refreshBtn.classList.remove('spinning');
  }
}

refs.refreshBtn.addEventListener('click', () => { if (!state.inAuth) refresh(true); });
refs.authBtn.addEventListener('click', () => showAuth(!state.inAuth));
refs.sortBtn.textContent = SORT_LABEL[state.sortKey];
refs.sortBtn.addEventListener('click', () => {
  state.sortKey = SORT_KEYS[(SORT_KEYS.indexOf(state.sortKey) + 1) % SORT_KEYS.length];
  localStorage.setItem(SORT_KEY, state.sortKey);
  refs.sortBtn.textContent = SORT_LABEL[state.sortKey];
  renderAll();
});
refs.procToggle.addEventListener('click', () => {
  const open = refs.procToggle.getAttribute('aria-expanded') === 'true';
  refs.procToggle.setAttribute('aria-expanded', String(!open));
  refs.procList.classList.toggle('hidden', open);
  refs.procChevron.classList.toggle('open', !open);
});
refs.clearTokenBtn.addEventListener('click', () => {
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  setStatus('idle');
  showAuth(true);
});
refs.authForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const raw = refs.tokenInput.value.trim();
  const candidate = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1).trim() : raw;
  if (!candidate) return;
  refs.connectBtn.disabled = true;
  refs.authStatus.textContent = 'Connecting...';
  refs.authStatus.className = 'status-msg';
  try {
    const data = await fetchMetrics(candidate);
    state.token = candidate;
    localStorage.setItem(TOKEN_KEY, candidate);
    showAuth(false);
    accept(data);
  } catch (err) {
    refs.authStatus.textContent = err?.message === 'UNAUTHORIZED' ? 'Invalid token (401).' : 'Connection failed.';
    refs.authStatus.className = 'status-msg err';
  } finally {
    refs.connectBtn.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPoll(); return; }
  refresh(false);
  startPoll();
});
// Keeps "updated Xs ago" honest even between polls or while offline.
setInterval(() => { if (!document.hidden) renderHostSub(refs, state.data, state.lastOkAt, state.offline); }, 5000);

const hashTok = window.location.hash.replace(/^#/, '').trim();
if (hashTok) {
  state.token = decodeURIComponent(hashTok);
  localStorage.setItem(TOKEN_KEY, state.token);
  history.replaceState(null, '', window.location.pathname);
} else {
  state.token = (localStorage.getItem(TOKEN_KEY) || '').trim();
}

if (!state.token) {
  showAuth(true);
} else {
  refs.dashboardView.classList.remove('hidden');
  refresh(false).then(startPoll);
}
