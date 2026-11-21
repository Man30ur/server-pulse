import { STORAGE_KEYS, fetchMetrics, getConfig, parseConnectionInput, saveConfig } from './api.js';
import { renderContainers, renderProcesses, renderSummary } from './render.js';

const POLL_MS = 3000;
const $ = (id) => document.getElementById(id);

const refs = {
  statusDot: $('statusDot'),
  hostName: $('hostName'),
  hostSub: $('hostSub'),
  refreshBtn: $('refreshBtn'),
  settingsBtn: $('settingsBtn'),
  errorBanner: $('errorBanner'),
  dashboardView: $('dashboardView'),
  settingsView: $('settingsView'),
  cpuVal: $('cpuVal'),
  cpuSub: $('cpuSub'),
  cpuBar: $('cpuBar'),
  ramVal: $('ramVal'),
  ramSub: $('ramSub'),
  ramBar: $('ramBar'),
  diskVal: $('diskVal'),
  diskSub: $('diskSub'),
  diskBar: $('diskBar'),
  containerCount: $('containerCount'),
  containerList: $('containerList'),
  procToggle: $('procToggle'),
  procCount: $('procCount'),
  procChevron: $('procChevron'),
  procList: $('procList'),
  settingsForm: $('settingsForm'),
  inputUrl: $('inputUrl'),
  inputToken: $('inputToken'),
  toggleTokenBtn: $('toggleTokenBtn'),
  settingsStatus: $('settingsStatus'),
  cancelBtn: $('cancelBtn'),
  saveBtn: $('saveBtn'),
};

let pollTimer = null;
let inSettings = false;
let currentConfig = { serverUrl: '', apiToken: '', badgeMetric: 'ram' };

function setConnectionState(state, message = '') {
  refs.statusDot.className = `dot ${state === 'ok' ? 'dot-ok' : state === 'err' ? 'dot-err' : 'dot-idle'}`;
  if (message) {
    refs.errorBanner.textContent = message;
    refs.errorBanner.classList.remove('hidden');
  } else {
    refs.errorBanner.classList.add('hidden');
    refs.errorBanner.textContent = '';
  }
}

function errorLabel(code) {
  if (code === 'UNAUTHORIZED') return 'Authentication failed (401) — check Bearer token.';
  if (code === 'TIMEOUT') return 'Request timed out (3s) — server unreachable.';
  if (code === 'NOT_CONFIGURED') return 'Configure Server URL and Bearer token.';
  return 'Server offline or unreachable.';
}

function applySnapshot(data) {
  renderSummary(refs, data);
  renderContainers(refs.containerList, refs.containerCount, data.containers);
  renderProcesses(refs.procList, refs.procCount, data.processes);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
    applySnapshot(data);
    setConnectionState('ok');
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SNAPSHOT]: data, [STORAGE_KEYS.LAST_ERROR]: '' });
    chrome.runtime.sendMessage({ type: 'syncBadge', data, badgeMetric: currentConfig.badgeMetric }).catch(() => {});
  } catch (err) {
    const code = err?.message || 'OFFLINE';
    setConnectionState('err', errorLabel(code));
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

refs.settingsBtn.addEventListener('click', () => showSettings(!inSettings));
refs.cancelBtn.addEventListener('click', () => showSettings(false));
refs.refreshBtn.addEventListener('click', () => {
  if (inSettings) showSettings(false);
  refresh(true);
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
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SNAPSHOT]: data, [STORAGE_KEYS.LAST_ERROR]: '' });
    applySnapshot(data);
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

window.addEventListener('pagehide', stopPolling);
window.addEventListener('unload', stopPolling);

async function init() {
  currentConfig = await getConfig();
  const cached = await chrome.storage.local.get([STORAGE_KEYS.LAST_SNAPSHOT, STORAGE_KEYS.LAST_ERROR]);

  if (!currentConfig.serverUrl || !currentConfig.apiToken) {
    showSettings(true);
    return;
  }

  if (cached[STORAGE_KEYS.LAST_SNAPSHOT]) {
    applySnapshot(cached[STORAGE_KEYS.LAST_SNAPSHOT]);
    setConnectionState(cached[STORAGE_KEYS.LAST_ERROR] ? 'err' : 'ok', cached[STORAGE_KEYS.LAST_ERROR] ? errorLabel(cached[STORAGE_KEYS.LAST_ERROR]) : '');
  }

  await refresh(false);
  startPolling();
}

init();
