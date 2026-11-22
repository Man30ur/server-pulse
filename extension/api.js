// Shared storage, API client, and pure formatting helpers (zero dependencies).

export const STORAGE_KEYS = {
  SERVER_URL: 'serverUrl',
  API_TOKEN: 'apiToken',
  BADGE_METRIC: 'badgeMetric',
  LAST_SNAPSHOT: 'lastSnapshot',
  LAST_OK_AT: 'lastOkAt',
  LAST_ERROR: 'lastError',
  HISTORY: 'history',
  SORT_KEY: 'sortKey',
};

export const COLORS = {
  GREEN: '#10B981',
  AMBER: '#F59E0B',
  RED: '#EF4444',
  MUTED: '#4B5563',
};

export function normalizeServerUrl(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

export function parseConnectionInput(raw) {
  let text = String(raw || '').trim();
  if (!text) return { serverUrl: '', apiToken: '' };

  if (/^pulses:\/\//i.test(text)) {
    text = `https://${text.slice(9)}`;
  } else if (/^pulse:\/\//i.test(text)) {
    text = `http://${text.slice(8)}`;
  }

  let apiToken = '';
  const hashIdx = text.indexOf('#');
  if (hashIdx !== -1) {
    apiToken = decodeURIComponent(text.slice(hashIdx + 1).trim());
    text = text.slice(0, hashIdx);
  } else {
    const qIdx = text.indexOf('?');
    if (qIdx !== -1) {
      const params = new URLSearchParams(text.slice(qIdx + 1));
      const tok = params.get('token');
      if (tok) {
        apiToken = tok.trim();
        text = text.slice(0, qIdx);
      }
    }
  }
  return { serverUrl: normalizeServerUrl(text), apiToken };
}

export async function getConfig() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.SERVER_URL,
    STORAGE_KEYS.API_TOKEN,
    STORAGE_KEYS.BADGE_METRIC,
  ]);
  return {
    serverUrl: normalizeServerUrl(data[STORAGE_KEYS.SERVER_URL]),
    apiToken: String(data[STORAGE_KEYS.API_TOKEN] || '').trim(),
    badgeMetric: data[STORAGE_KEYS.BADGE_METRIC] === 'cpu' ? 'cpu' : 'ram',
  };
}

export async function saveConfig({ serverUrl, apiToken, badgeMetric }) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.SERVER_URL]: normalizeServerUrl(serverUrl),
    [STORAGE_KEYS.API_TOKEN]: String(apiToken || '').trim(),
    [STORAGE_KEYS.BADGE_METRIC]: badgeMetric === 'cpu' ? 'cpu' : 'ram',
  });
}

export async function fetchMetrics(serverUrl, apiToken, timeoutMs = 3000) {
  const base = normalizeServerUrl(serverUrl);
  if (!base || !apiToken) {
    throw new Error('NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/metrics`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiToken}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('UNAUTHORIZED');
    }
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }
    const payload = await res.json();
    if (!payload || typeof payload !== 'object' || !payload.cpu || !payload.memory) {
      throw new Error('INVALID_PAYLOAD');
    }
    return payload;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function levelColor(percent) {
  const n = Number(percent) || 0;
  if (n >= 85) return COLORS.RED;
  if (n >= 65) return COLORS.AMBER;
  return COLORS.GREEN;
}

export function levelClass(percent) {
  const n = Number(percent) || 0;
  if (n >= 85) return 'lvl-red';
  if (n >= 65) return 'lvl-amber';
  return 'lvl-green';
}

export function formatMemMB(mb) {
  const v = Number(mb) || 0;
  if (v >= 1024) {
    return `${(v / 1024).toFixed(1)}G`;
  }
  return `${Math.round(v)}M`;
}

export function formatUptime(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `up ${days}d ${hours}h`;
  if (hours > 0) return `up ${hours}h ${mins}m`;
  return `up ${mins}m`;
}
