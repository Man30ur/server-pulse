// Shared, framework-free renderer for the web dashboard (agent/web/view.js) and the
// Chrome extension popup (extension/view.js). The two copies MUST stay byte-identical
// (enforced by tests/extension_test.mjs). Safe DOM only: createElement + textContent.

export const HISTORY_LEN = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export const levelClass = (p) => (p >= 85 ? 'lvl-red' : p >= 65 ? 'lvl-amber' : 'lvl-green');
export const formatMem = (mb) => ((mb || 0) >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb || 0)}M`);

export function formatRate(bps) {
  const v = Number(bps) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)}M`;
  if (v >= 1024) return `${Math.round(v / 1024)}K`;
  return `${Math.round(v)}B`;
}

export function formatUptime(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  return d > 0 ? `up ${d}d ${h}h` : h > 0 ? `up ${h}h ${m}m` : `up ${m}m`;
}

export function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function setBar(node, pct) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  node.style.width = `${v}%`;
  node.className = `bar-fill ${levelClass(v)}`;
}

export function pushHistory(hist, d) {
  hist.cpu.push(Number(d.cpu?.percent) || 0);
  hist.ram.push(Number(d.memory?.percent) || 0);
  while (hist.cpu.length > HISTORY_LEN) hist.cpu.shift();
  while (hist.ram.length > HISTORY_LEN) hist.ram.shift();
}

// Draws a right-aligned 0-100% sparkline into an <svg viewBox="0 0 100 24">.
export function drawSpark(svg, values) {
  if (!svg) return;
  let line = svg.firstElementChild;
  if (!line) {
    line = document.createElementNS(SVG_NS, 'polyline');
    svg.appendChild(line);
  }
  const n = values.length;
  const step = 100 / (HISTORY_LEN - 1);
  const pts = values.map((v, i) => {
    const x = 100 - (n - 1 - i) * step;
    const y = 23 - (Math.max(0, Math.min(100, v)) / 100) * 22;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  line.setAttribute('points', n > 1 ? pts.join(' ') : '');
  line.setAttribute('class', `spark ${levelClass(values[n - 1] || 0)}`);
}

export function renderSummary(refs, d, hist) {
  const cpu = Number(d.cpu?.percent || 0);
  const ram = Number(d.memory?.percent || 0);
  const disk = Number(d.disk?.percent || 0);
  refs.hostName.textContent = d.hostname || 'server';

  refs.cpuVal.textContent = `${cpu.toFixed(1)}%`;
  refs.cpuSub.textContent = `${d.cpu?.cores || 0} cores`;
  setBar(refs.cpuBar, cpu);

  refs.ramVal.textContent = `${ram.toFixed(1)}%`;
  refs.ramSub.textContent = `${formatMem(d.memory?.used_mb)}/${formatMem(d.memory?.total_mb)}`;
  setBar(refs.ramBar, ram);
  const swapUsed = Number(d.memory?.swap_used_mb) || 0;
  refs.swapNote.textContent = swapUsed > 0 ? `swap ${formatMem(swapUsed)}/${formatMem(d.memory?.swap_total_mb)}` : '';
  refs.swapNote.classList.toggle('hidden', swapUsed <= 0);

  refs.diskVal.textContent = `${disk.toFixed(1)}%`;
  refs.diskSub.textContent = `${Number(d.disk?.used_gb || 0).toFixed(0)}/${Number(d.disk?.total_gb || 0).toFixed(0)}G`;
  setBar(refs.diskBar, disk);

  if (hist) {
    drawSpark(refs.cpuSpark, hist.cpu);
    drawSpark(refs.ramSpark, hist.ram);
  }
  renderDetails(refs, d);
}

function renderDetails(refs, d) {
  if (!Array.isArray(d.load)) {
    refs.details.classList.add('hidden'); // older agent without extended metrics
    return;
  }
  refs.details.classList.remove('hidden');
  const cores = Number(d.cpu?.cores) || 1;
  const ratio = (Number(d.load[0]) || 0) / cores;
  refs.loadVal.textContent = d.load.map((v) => Number(v || 0).toFixed(2)).join(' ');
  refs.loadVal.className = `detail-val num${ratio >= 1.5 ? ' txt-red' : ratio >= 1 ? ' txt-amber' : ''}`;
  refs.loadVal.title = `Load average 1 / 5 / 15 min on ${cores} cores`;
  refs.netVal.textContent = `↓${formatRate(d.network?.rx_bps)} ↑${formatRate(d.network?.tx_bps)}`;
  refs.netVal.title = 'Network per second: download / upload';
  refs.ioVal.textContent = `R ${formatRate(d.disk_io?.read_bps)} W ${formatRate(d.disk_io?.write_bps)}`;
  refs.ioVal.title = 'Disk per second: read / write';
}

export function renderHostSub(refs, d, lastOkAt, offline) {
  if (!d) return;
  const ago = formatAgo(Date.now() - lastOkAt);
  refs.hostSub.textContent = offline ? `offline · last data ${ago}` : `${formatUptime(d.uptime_sec)} · updated ${ago}`;
}

const isProblem = (c) => c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead';
const isWarn = (c) => c.health === 'starting' || c.state === 'paused';
const group = (c) => (isProblem(c) ? 0 : c.state === 'running' || c.state === 'paused' ? 1 : 2);
const SORTERS = {
  ram: (a, b) => (b.mem_mb || 0) - (a.mem_mb || 0),
  cpu: (a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0),
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
};
export const SORT_KEYS = Object.keys(SORTERS);

function statRow(left, mem, cpu) {
  const top = el('div', 'row-top');
  const stats = el('div', 'row-stats num');
  if (mem !== null) stats.appendChild(el('span', 'stat-mem', mem));
  stats.appendChild(el('span', 'stat-cpu', cpu));
  top.appendChild(left);
  top.appendChild(stats);
  return top;
}

// opts: { sortKey: 'ram'|'cpu'|'name', expanded: Set<string> }
export function renderContainers(refs, containers, opts) {
  const sorter = SORTERS[opts.sortKey] || SORTERS.ram;
  const items = (Array.isArray(containers) ? [...containers] : []).sort((a, b) => group(a) - group(b) || sorter(a, b));
  const running = items.filter((c) => c.state === 'running').length;
  const problems = items.filter(isProblem).length;
  refs.containerCount.textContent = items.length ? `${running}/${items.length}` : '0';
  refs.issues.textContent = problems ? `${problems} issue${problems > 1 ? 's' : ''}` : '';
  refs.issues.classList.toggle('hidden', !problems);

  const frag = document.createDocumentFragment();
  if (!items.length) frag.appendChild(el('div', 'empty', 'No containers detected'));
  for (const c of items) {
    const up = c.state === 'running';
    const open = opts.expanded.has(c.id);
    const row = el('div', `row row-click${up ? '' : ' row-stopped'}${open ? ' open' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(open));

    const left = el('div', 'row-left');
    const dot = isProblem(c) ? 'dot-err' : isWarn(c) ? 'dot-warn' : up ? 'dot-ok' : 'dot-idle';
    left.appendChild(el('span', `dot ${dot}`));
    left.appendChild(el('span', 'row-name', c.name || c.id));
    row.appendChild(up
      ? statRow(left, formatMem(c.mem_mb), `${Number(c.cpu_percent || 0).toFixed(1)}%`)
      : statRow(left, null, c.state || 'stopped'));

    const bar = el('div', 'bar');
    const fill = el('div', 'bar-fill');
    const pct = up ? Math.max(0, Math.min(100, Number(c.mem_percent) || 0)) : 0;
    fill.style.width = `${pct}%`;
    fill.className = `bar-fill ${up ? levelClass(pct) : 'lvl-muted'}`;
    bar.appendChild(fill);
    row.appendChild(bar);

    const parts = [c.status || c.state];
    if (up) parts.push(`${pct.toFixed(1)}% of mem limit`);
    parts.push(`id ${c.id}`);
    const detail = el('div', `row-detail num${open ? '' : ' hidden'}`, parts.join(' · '));
    row.appendChild(detail);

    const toggle = () => {
      const nowOpen = !opts.expanded.has(c.id);
      if (nowOpen) opts.expanded.add(c.id); else opts.expanded.delete(c.id);
      row.classList.toggle('open', nowOpen);
      row.setAttribute('aria-expanded', String(nowOpen));
      detail.classList.toggle('hidden', !nowOpen);
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    frag.appendChild(row);
  }
  refs.containerList.replaceChildren(frag);
}

export function renderProcesses(refs, processes) {
  const items = Array.isArray(processes) ? processes : [];
  refs.procCount.textContent = String(items.length);
  const frag = document.createDocumentFragment();
  if (!items.length) frag.appendChild(el('div', 'empty', 'No host processes reported'));
  for (const p of items) {
    const row = el('div', 'row');
    const left = el('div', 'row-left');
    left.appendChild(el('span', 'row-name', p.name || `pid:${p.pid}`));
    left.appendChild(el('span', 'row-pid num', String(p.pid)));
    row.appendChild(statRow(left, formatMem(p.mem_mb), `${Number(p.cpu_percent || 0).toFixed(1)}%`));
    frag.appendChild(row);
  }
  refs.procList.replaceChildren(frag);
}
