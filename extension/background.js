import { COLORS, STORAGE_KEYS, fetchMetrics, getConfig, levelColor } from './api.js';

const ALARM_NAME = 'server-pulse-poll';
const POLL_PERIOD_MINUTES = 0.25; // 15s in unpacked dev; Chrome clamps to 30s when packed.

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MINUTES });
  }
}

async function setBadge(text, bgColor, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: bgColor });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  }
  if (title) {
    await chrome.action.setTitle({ title });
  }
}

export async function updateBadgeFromData(data, badgeMetric) {
  const pct = badgeMetric === 'cpu' ? Number(data.cpu?.percent || 0) : Number(data.memory?.percent || 0);
  const rounded = Math.max(0, Math.min(100, Math.round(pct)));
  const label = rounded >= 100 ? '100' : `${rounded}%`;
  const host = data.hostname || 'Server-Pulse';
  const title = `${host} · CPU ${data.cpu?.percent ?? 0}% · RAM ${data.memory?.percent ?? 0}%`;
  await setBadge(label, levelColor(pct), title);
}

async function pollServer() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.apiToken) {
    await setBadge('', COLORS.MUTED, 'Server-Pulse — Click to configure');
    return;
  }

  try {
    const data = await fetchMetrics(cfg.serverUrl, cfg.apiToken, 3000);
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_SNAPSHOT]: data,
      [STORAGE_KEYS.LAST_ERROR]: '',
    });
    await updateBadgeFromData(data, cfg.badgeMetric);
  } catch (err) {
    const code = err?.message === 'UNAUTHORIZED' ? '401' : 'OFF';
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_ERROR]: err?.message || 'OFFLINE' });
    await setBadge(code, COLORS.RED, `Server-Pulse — ${code === '401' ? 'Invalid Token' : 'Server Offline'}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  pollServer();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  pollServer();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollServer();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.SERVER_URL] || changes[STORAGE_KEYS.API_TOKEN] || changes[STORAGE_KEYS.BADGE_METRIC]) {
    pollServer();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'syncBadge' && msg.data) {
    updateBadgeFromData(msg.data, msg.badgeMetric || 'ram').then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'badgeError') {
    const code = msg.code === 'UNAUTHORIZED' ? '401' : 'OFF';
    setBadge(code, COLORS.RED, `Server-Pulse — ${code}`).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'pollNow') {
    pollServer().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
