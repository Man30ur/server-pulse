import { formatMemMB, formatUptime, levelClass } from './api.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setBar(barEl, percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  barEl.style.width = `${clamped}%`;
  barEl.className = `bar-fill ${levelClass(clamped)}`;
}

export function renderSummary(refs, data) {
  const cpuPct = Number(data.cpu?.percent || 0);
  const ramPct = Number(data.memory?.percent || 0);
  const diskPct = Number(data.disk?.percent || 0);

  refs.hostName.textContent = data.hostname || 'server';
  const swapTxt = data.memory?.swap_used_mb > 0 ? ` · swap ${formatMemMB(data.memory.swap_used_mb)}` : '';
  refs.hostSub.textContent = `${formatUptime(data.uptime_sec)}${swapTxt}`;

  refs.cpuVal.textContent = `${cpuPct.toFixed(1)}%`;
  refs.cpuSub.textContent = `${data.cpu?.cores || 0}c`;
  setBar(refs.cpuBar, cpuPct);

  refs.ramVal.textContent = `${ramPct.toFixed(1)}%`;
  refs.ramSub.textContent = `${formatMemMB(data.memory?.used_mb)}/${formatMemMB(data.memory?.total_mb)}`;
  setBar(refs.ramBar, ramPct);

  refs.diskVal.textContent = `${diskPct.toFixed(1)}%`;
  refs.diskSub.textContent = `${Number(data.disk?.used_gb || 0).toFixed(0)}/${Number(data.disk?.total_gb || 0).toFixed(0)}G`;
  setBar(refs.diskBar, diskPct);
}

export function renderContainers(listEl, countEl, containers) {
  const items = Array.isArray(containers) ? [...containers] : [];
  items.sort((a, b) => (Number(b.mem_mb) || 0) - (Number(a.mem_mb) || 0));

  const running = items.filter((c) => c.state === 'running').length;
  countEl.textContent = items.length ? `${running}/${items.length}` : '0';

  const frag = document.createDocumentFragment();
  if (items.length === 0) {
    frag.appendChild(el('div', 'empty', 'No containers detected'));
    listEl.replaceChildren(frag);
    return;
  }

  for (const c of items) {
    const isRunning = c.state === 'running';
    const row = el('div', isRunning ? 'row' : 'row row-stopped');

    const top = el('div', 'row-top');
    const left = el('div', 'row-left');
    left.appendChild(el('span', `dot ${isRunning ? 'dot-ok' : 'dot-idle'}`));
    const nameEl = el('span', 'row-name', c.name || c.id || 'unknown');
    nameEl.title = `${c.name || c.id} (${c.state || 'unknown'})`;
    left.appendChild(nameEl);

    const stats = el('div', 'row-stats num');
    if (isRunning) {
      stats.appendChild(el('span', 'stat-mem', formatMemMB(c.mem_mb)));
      stats.appendChild(el('span', 'stat-cpu', `${Number(c.cpu_percent || 0).toFixed(1)}%`));
    } else {
      stats.appendChild(el('span', 'stat-cpu', c.state || 'stopped'));
    }

    top.appendChild(left);
    top.appendChild(stats);
    row.appendChild(top);

    const bar = el('div', 'bar');
    const fill = el('div', 'bar-fill');
    const pct = isRunning ? Math.max(0, Math.min(100, Number(c.mem_percent) || 0)) : 0;
    fill.style.width = `${pct}%`;
    fill.className = `bar-fill ${isRunning ? levelClass(pct) : 'lvl-muted'}`;
    bar.appendChild(fill);
    row.appendChild(bar);

    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);
}

export function renderProcesses(listEl, countEl, processes) {
  const items = Array.isArray(processes) ? processes : [];
  countEl.textContent = String(items.length);

  const frag = document.createDocumentFragment();
  if (items.length === 0) {
    frag.appendChild(el('div', 'empty', 'No host processes reported'));
    listEl.replaceChildren(frag);
    return;
  }

  for (const p of items) {
    const row = el('div', 'row');
    const top = el('div', 'row-top');
    const left = el('div', 'row-left');
    const nameEl = el('span', 'row-name', p.name || `pid:${p.pid}`);
    nameEl.title = `PID ${p.pid} · ${p.name}`;
    left.appendChild(nameEl);

    const stats = el('div', 'row-stats num');
    stats.appendChild(el('span', 'stat-mem', formatMemMB(p.mem_mb)));
    stats.appendChild(el('span', 'stat-cpu', `${Number(p.cpu_percent || 0).toFixed(1)}%`));

    top.appendChild(left);
    top.appendChild(stats);
    row.appendChild(top);
    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);
}
