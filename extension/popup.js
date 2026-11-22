import { STORAGE_KEYS, fetchMetrics, getConfig, parseConnectionInput, saveConfig } from './api.js';
import {
  FOCUS_TABS, SORT_KEYS, pushHistory, renderContainers, renderDiskView, renderHostSub,
  renderProcesses, renderSummary, syncFocusTabs,
} from './view.js';

const POLL_MS = 3000;
const SORT_LABEL = { ram: 'RAM', cpu: 'CPU', name: 'A–Z' };
const $ = (id) => document.getElementById(id);
const ids = ['statusDot', 'hostName', 'hostSub', 'refreshBtn', 'settingsBtn', 'errorBanner', 'dashboardView',
  'settingsView', 'tabCpu', 'tabRam', 'tabDisk', 'cpuVal', 'cpuSub', 'cpuBar', 'cpuSpark', 'ramVal', 'ramSub',
  'ramBar', 'ramSpark', 'swapNote', 'diskVal', 'diskSub', 'diskBar', 'details', 'd1Label', 'd1Val', 'd2Label',
  'd2Val', 'd3Label', 'd3Val', 'computePanel', 'diskPanel', 'containerCount', 'issues', 'sortBtn',
  'containerList', 'procToggle', 'procTitle', 'procCount', 'procChevron', 'procList', 'mountCount',
  'mountList', 'dockerDiskTotal', 'reclaimPill', 'dockerDiskList', 'settingsForm', 'inputUrl', 'inputToken',
  'toggleTokenBtn', 'settingsStatus', 'cancelBtn', 'saveBtn'];
const refs = Object.fromEntries(ids.map((id) => [id, $(id)]));

let pollTimer = null;
let inSettings = false;
let currentConfig = { serverUrl: '', apiToken: '', badgeMetric: 'ram' };
const view = {
  data: null, lastOkAt: 0, offline: false,
  hist: { cpu: [], ram: [] }, focusTab: 'ram', sortKey: 'ram', expanded: new Set(),
};

function setConnectionState(state, message = '') {
  refs.statusDot.className = `dot ${state === 'ok' ? 'dot-ok' : state === 'err' ? 'dot-err' : 'dot-idle'}`;
  refs.errorBanner.textContent = message;
  refs.errorBanner.classList.toggle('hidden', !message);
  refs.dashboardView.classList.toggle('stale', state === 'err' && Boolean(view.data));
}

function errorLabel(code) {
  if (code === 'UNAUTHORIZED') return 'Authentication failed (401) — check Bearer token.';
  if (code === 'TIMEOUT') return 'Request timed out (3s) — showing last known data.';
  if (code === 'NOT_CONFIGURED') return 'Configure Server URL and Bearer token.';
  return 'Server offline or unreachable — showing last known data.';
}

function renderAll() {
  syncFocusTabs(refs, view.focusTab);
  refs.sortBtn.textContent = SORT_LABEL[view.sortKey];
  if (!view.data) return;
  renderSummary(refs, view.data, view.hist, view.focusTab);
  if (view.focusTab === 'disk') {
    renderDiskView(refs, view.data);
  } else {
    renderContainers(refs, view.data.containers, { sortKey: view.sortKey, focusTab: view.focusTab, expanded: view.expanded });
    renderProcesses(refs, view.data, view.focusTab);
  }
  renderHostSub(refs, view.data, view.lastOkAt, view.offline);
}

function selectTab(tab) {
  if (!FOCUS_TABS.includes(tab)) return;
  view.focusTab = tab;
  const patch = { [STORAGE_KEYS.FOCUS_TAB]: tab };
  if (tab === 'cpu' || tab === 'ram') {
    view.sortKey = tab;
    patch[STORAGE_KEYS.SORT_KEY] = tab;
  }
  chrome.storage.local.set(patch);
  renderAll();
}

async function applySnapshot(data, lastOkAt = Date.now(), record = false) {
  view.data = data;
  view.lastOkAt = lastOkAt;
  view.offline = false;
  if (record) pushHistory(view.hist, data);
  renderAll();
}

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling() {
  stopPolling();
  if (!inSettings && currentConfig.serverUrl && currentConfig.apiToken) {
    pollTimer = setInterval(() => { refresh(false); }, POLL_MS);
  }
}

async function refresh(showSpin = true) {
  if (!currentConfig.serverUrl || !currentConfig.apiToken) return;
  if (showSpin) refs.refreshBtn.classList.add('spinning');
  try {
    const data = await fetchMetrics(currentConfig.serverUrl, currentConfig.apiToken, 3000);
    const now = Date.now();
    await applySnapshot(data, now, true);
    setConnectionState('ok');
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SNAPSHOT]: data, [STORAGE_KEYS.LAST_OK_AT]: now, [STORAGE_KEYS.LAST_ERROR]: '' });
    chrome.runtime.sendMessage({ type: 'syncBadge', data, badgeMetric: currentConfig.badgeMetric }).catch(() => {});
  } catch (err) {
    const code = err?.message || 'OFFLINE';
    view.offline = true;
    setConnectionState('err', errorLabel(code));
    renderHostSub(refs, view.data, view.lastOkAt, true);
    chrome.runtime.sendMessage({ type: 'badgeError', code }).catch(() => {});
  } finally {
    refs.refreshBtn.classList.remove('spinning');
  }
}

function showSettings(open) {
  inSettings = open;
  refs.settingsView.classList.toggle('hidden', !open);
  refs.dashboardView.classList.toggle('hidden', open);
  refs.settingsBtn.classList.toggle('active', open);
  refs.settingsStatus.textContent = '';
  refs.settingsStatus.className = 'settings-status';
  if (open) {
    stopPolling();
    refs.errorBanner.classList.add('hidden');
    refs.inputUrl.value = currentConfig.serverUrl;
    refs.inputToken.value = currentConfig.apiToken;
    const radio = refs.settingsForm.querySelector(`input[name="badgeMetric"][value="${currentConfig.badgeMetric}"]`);
    if (radio) radio.checked = true;
    refs.cancelBtn.classList.toggle('hidden', !currentConfig.serverUrl || !currentConfig.apiToken);
  } else {
    startPolling();
  }
}

for (const btn of [refs.tabCpu, refs.tabRam, refs.tabDisk]) {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
}
refs.settingsBtn.addEventListener('click', () => showSettings(!inSettings));
refs.cancelBtn.addEventListener('click', () => showSettings(false));
refs.refreshBtn.addEventListener('click', () => {
  if (inSettings) showSettings(false);
  refresh(true);
});
refs.sortBtn.addEventListener('click', () => {
  view.sortKey = SORT_KEYS[(SORT_KEYS.indexOf(view.sortKey) + 1) % SORT_KEYS.length];
  chrome.storage.local.set({ [STORAGE_KEYS.SORT_KEY]: view.sortKey });
  renderAll();
});
refs.procToggle.addEventListener('click', () => {
  const expanded = refs.procToggle.getAttribute('aria-expanded') === 'true';
  refs.procToggle.setAttribute('aria-expanded', String(!expanded));
  refs.procList.classList.toggle('hidden', expanded);
  refs.procChevron.classList.toggle('open', !expanded);
});
refs.toggleTokenBtn.addEventListener('click', () => {
  const isHidden = refs.inputToken.type === 'password';
  refs.inputToken.type = isHidden ? 'text' : 'password';
  refs.toggleTokenBtn.textContent = isHidden ? 'Hide' : 'Show';
});
refs.inputUrl.addEventListener('input', () => {
  const parsed = parseConnectionInput(refs.inputUrl.value);
  if (parsed.apiToken) {
    refs.inputUrl.value = parsed.serverUrl;
    refs.inputToken.value = parsed.apiToken;
    refs.settingsStatus.textContent = 'Quick-connect link parsed — click Save & Connect.';
    refs.settingsStatus.className = 'settings-status ok';
  }
});

refs.settingsForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const parsed = parseConnectionInput(refs.inputUrl.value);
  const serverUrl = parsed.serverUrl;
  const apiToken = (parsed.apiToken || refs.inputToken.value).trim();
  const metricInput = refs.settingsForm.querySelector('input[name="badgeMetric"]:checked');
  const badgeMetric = metricInput ? metricInput.value : 'ram';

  if (!serverUrl || !apiToken) {
    refs.settingsStatus.textContent = 'Both Server URL and Bearer Token are required.';
    refs.settingsStatus.className = 'settings-status err';
    return;
  }

  refs.saveBtn.disabled = true;
  refs.settingsStatus.textContent = 'Testing connection...';
  refs.settingsStatus.className = 'settings-status';

  try {
    const data = await fetchMetrics(serverUrl, apiToken, 3000);
    await saveConfig({ serverUrl, apiToken, badgeMetric });
    currentConfig = { serverUrl, apiToken, badgeMetric };
    const now = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SNAPSHOT]: data, [STORAGE_KEYS.LAST_OK_AT]: now, [STORAGE_KEYS.LAST_ERROR]: '' });
    await applySnapshot(data, now, true);
    setConnectionState('ok');
    chrome.runtime.sendMessage({ type: 'syncBadge', data, badgeMetric }).catch(() => {});
    showSettings(false);
  } catch (err) {
    refs.settingsStatus.textContent = errorLabel(err?.message);
    refs.settingsStatus.className = 'settings-status err';
  } finally {
    refs.saveBtn.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.HISTORY]?.newValue) {
    view.hist = changes[STORAGE_KEYS.HISTORY].newValue;
    renderAll();
  }
});

window.addEventListener('pagehide', stopPolling);
setInterval(() => renderHostSub(refs, view.data, view.lastOkAt, view.offline), 5000);

async function init() {
  currentConfig = await getConfig();
  const cached = await chrome.storage.local.get([STORAGE_KEYS.LAST_SNAPSHOT, STORAGE_KEYS.LAST_OK_AT,
    STORAGE_KEYS.LAST_ERROR, STORAGE_KEYS.HISTORY, STORAGE_KEYS.SORT_KEY, STORAGE_KEYS.FOCUS_TAB]);
  if (FOCUS_TABS.includes(cached[STORAGE_KEYS.FOCUS_TAB])) view.focusTab = cached[STORAGE_KEYS.FOCUS_TAB];
  if (SORT_KEYS.includes(cached[STORAGE_KEYS.SORT_KEY])) view.sortKey = cached[STORAGE_KEYS.SORT_KEY];
  if (cached[STORAGE_KEYS.HISTORY]?.cpu) view.hist = cached[STORAGE_KEYS.HISTORY];
  syncFocusTabs(refs, view.focusTab);
  refs.sortBtn.textContent = SORT_LABEL[view.sortKey];

  if (!currentConfig.serverUrl || !currentConfig.apiToken) {
    showSettings(true);
    return;
  }

  const snap = cached[STORAGE_KEYS.LAST_SNAPSHOT];
  if (snap) {
    await applySnapshot(snap, Number(cached[STORAGE_KEYS.LAST_OK_AT]) || (snap.timestamp || 0) * 1000);
    const lastErr = cached[STORAGE_KEYS.LAST_ERROR];
    setConnectionState(lastErr ? 'err' : 'ok', lastErr ? errorLabel(lastErr) : '');
  }

  await refresh(false);
  startPolling();
}

init();
