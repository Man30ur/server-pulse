import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '../extension');

test('manifest.json is valid Manifest V3 with minimal permissions and icons', () => {
  const raw = fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.equal(manifest.background?.service_worker, 'background.js');
  assert.equal(manifest.background?.type, 'module');
  assert.equal(manifest.action?.default_popup, 'popup.html');

  for (const size of ['16', '48', '128']) {
    const iconPath = path.join(EXT_DIR, manifest.icons[size]);
    const buf = fs.readFileSync(iconPath);
    assert.deepEqual(buf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
});

test('extension total file footprint is under 60 KB', () => {
  let totalBytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else totalBytes += fs.statSync(full).size;
    }
  };
  walk(EXT_DIR);
  assert.ok(totalBytes < 60 * 1024, `expected < 60KB, got ${totalBytes} bytes`);
});

test('strict MV3 CSP compliance: no inline scripts, inline handlers, eval, or innerHTML', () => {
  const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'inline <script> found in popup.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler found in popup.html');

  for (const file of ['api.js', 'background.js', 'render.js', 'popup.js']) {
    const src = fs.readFileSync(path.join(EXT_DIR, file), 'utf8');
    assert.ok(!/\beval\s*\(/.test(src), `eval() found in ${file}`);
    assert.ok(!/\bnew\s+Function\b/.test(src), `new Function found in ${file}`);
    assert.ok(!/\.innerHTML\b/.test(src), `innerHTML found in ${file}`);
  }
});

test('api.js helpers and fetchMetrics work against mock HTTP API', async () => {
  const api = await import(path.join(EXT_DIR, 'api.js'));

  assert.equal(api.normalizeServerUrl('203.0.113.10:9191/'), 'http://203.0.113.10:9191');
  assert.deepEqual(api.parseConnectionInput('pulse://203.0.113.10:9191#abc123'), {
    serverUrl: 'http://203.0.113.10:9191',
    apiToken: 'abc123',
  });
  assert.deepEqual(api.parseConnectionInput('pulses://mon.example.com#xyz789'), {
    serverUrl: 'https://mon.example.com',
    apiToken: 'xyz789',
  });
  assert.deepEqual(api.parseConnectionInput('http://10.0.0.1:9191?token=tok42'), {
    serverUrl: 'http://10.0.0.1:9191',
    apiToken: 'tok42',
  });
  assert.equal(api.formatMemMB(420.5), '421M');
  assert.equal(api.formatMemMB(2048), '2.0G');
  assert.equal(api.formatUptime(90060), 'up 1d 1h');
  assert.equal(api.levelColor(40), api.COLORS.GREEN);
  assert.equal(api.levelColor(72), api.COLORS.AMBER);
  assert.equal(api.levelColor(91), api.COLORS.RED);

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer valid-tok') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      timestamp: 1795273436,
      hostname: 'demo-node-1',
      uptime_sec: 86400,
      cpu: { percent: 18.4, cores: 6 },
      memory: { used_mb: 8420, total_mb: 15980, percent: 52.7, swap_used_mb: 0, swap_total_mb: 8192 },
      disk: { used_gb: 24.5, total_gb: 99.0, percent: 24.7 },
      containers: [
        { id: 'aaa', name: 'small', state: 'running', cpu_percent: 0.5, mem_mb: 100, mem_percent: 0.6 },
        { id: 'bbb', name: 'front-stox', state: 'running', cpu_percent: 1.2, mem_mb: 420.5, mem_percent: 2.6 },
      ],
      processes: [{ pid: 1245, name: 'java', cpu_percent: 4.5, mem_mb: 2150.0 }],
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(() => api.fetchMetrics(baseUrl, 'wrong-tok', 1000), { message: 'UNAUTHORIZED' });
    const data = await api.fetchMetrics(baseUrl, 'valid-tok', 1000);
    assert.equal(data.hostname, 'demo-node-1');
    assert.equal(data.containers.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('render.js renders summary, sorted containers, and processes safely without innerHTML', async () => {
  const makeNode = (tag) => ({
    tag,
    className: '',
    textContent: '',
    title: '',
    style: {},
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(frag) { this.children = frag.children ? [...frag.children] : [frag]; },
  });
  globalThis.document = {
    createElement: makeNode,
    createDocumentFragment: () => makeNode('#fragment'),
  };

  const { renderSummary, renderContainers, renderProcesses } = await import(path.join(EXT_DIR, 'render.js'));

  const refs = {
    hostName: makeNode('span'), hostSub: makeNode('span'),
    cpuVal: makeNode('div'), cpuSub: makeNode('span'), cpuBar: makeNode('div'),
    ramVal: makeNode('div'), ramSub: makeNode('span'), ramBar: makeNode('div'),
    diskVal: makeNode('div'), diskSub: makeNode('span'), diskBar: makeNode('div'),
  };

  renderSummary(refs, {
    hostname: 'demo-node-1',
    uptime_sec: 86400,
    cpu: { percent: 18.4, cores: 6 },
    memory: { used_mb: 8420, total_mb: 15980, percent: 52.7, swap_used_mb: 0 },
    disk: { used_gb: 24.5, total_gb: 99.0, percent: 24.7 },
  });
  assert.equal(refs.hostName.textContent, 'demo-node-1');
  assert.equal(refs.cpuVal.textContent, '18.4%');
  assert.equal(refs.ramVal.textContent, '52.7%');
  assert.equal(refs.diskVal.textContent, '24.7%');

  const cList = makeNode('div');
  const cCount = makeNode('span');
  renderContainers(cList, cCount, [
    { id: '1', name: 'redis', state: 'running', cpu_percent: 0.2, mem_mb: 12, mem_percent: 0.1 },
    { id: '2', name: 'front-stox', state: 'running', cpu_percent: 1.2, mem_mb: 420.5, mem_percent: 2.6 },
    { id: '3', name: 'old-job', state: 'exited', cpu_percent: 0, mem_mb: 0, mem_percent: 0 },
  ]);
  assert.equal(cCount.textContent, '2/3');
  assert.equal(cList.children.length, 3);
  assert.equal(cList.children[0].children[0].children[0].children[1].textContent, 'front-stox');

  const pList = makeNode('div');
  const pCount = makeNode('span');
  renderProcesses(pList, pCount, [{ pid: 1245, name: 'java', cpu_percent: 4.5, mem_mb: 2150 }]);
  assert.equal(pCount.textContent, '1');
  assert.equal(pList.children[0].children[0].children[0].children[0].textContent, 'java');
});

test('background.js updates badge text and colors for RAM/CPU thresholds', async () => {
  const badgeState = { text: '', color: '', title: '' };
  globalThis.chrome = {
    alarms: { get: async () => null, create: () => {}, onAlarm: { addListener: () => {} } },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } },
    runtime: { onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    action: {
      setBadgeText: async ({ text }) => { badgeState.text = text; },
      setBadgeBackgroundColor: async ({ color }) => { badgeState.color = color; },
      setBadgeTextColor: async () => {},
      setTitle: async ({ title }) => { badgeState.title = title; },
    },
  };

  const { updateBadgeFromData } = await import(path.join(EXT_DIR, 'background.js'));
  await updateBadgeFromData({ hostname: 'demo-node-1', cpu: { percent: 18.4 }, memory: { percent: 52.7 } }, 'ram');
  assert.equal(badgeState.text, '53%');
  assert.equal(badgeState.color, '#10B981');

  await updateBadgeFromData({ hostname: 'demo-node-1', cpu: { percent: 88.2 }, memory: { percent: 70.0 } }, 'cpu');
  assert.equal(badgeState.text, '88%');
  assert.equal(badgeState.color, '#EF4444');
});

