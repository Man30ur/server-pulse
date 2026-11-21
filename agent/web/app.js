(() => {
  'use strict';

  const TOKEN_KEY = 'server_pulse_token';
  const POLL_MS = 3000;
  const $ = (id) => document.getElementById(id);

  const refs = {
    statusDot: $('statusDot'), hostName: $('hostName'), hostSub: $('hostSub'),
    refreshBtn: $('refreshBtn'), authBtn: $('authBtn'), errorBanner: $('errorBanner'),
    dashboardView: $('dashboardView'), authView: $('authView'),
    cpuVal: $('cpuVal'), cpuSub: $('cpuSub'), cpuBar: $('cpuBar'),
    ramVal: $('ramVal'), ramSub: $('ramSub'), ramBar: $('ramBar'),
    diskVal: $('diskVal'), diskSub: $('diskSub'), diskBar: $('diskBar'),
    containerCount: $('containerCount'), containerList: $('containerList'),
    procToggle: $('procToggle'), procCount: $('procCount'),
    procChevron: $('procChevron'), procList: $('procList'),
    authForm: $('authForm'), tokenInput: $('tokenInput'),
    authStatus: $('authStatus'), clearTokenBtn: $('clearTokenBtn'), connectBtn: $('connectBtn'),
  };

  let token = '';
  let pollTimer = null;
  let inAuth = false;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const levelClass = (p) => (p >= 85 ? 'lvl-red' : p >= 65 ? 'lvl-amber' : 'lvl-green');
  const formatMem = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb || 0)}M`);
  const formatUptime = (sec) => {
    const t = Math.max(0, Math.floor(sec || 0));
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    return d > 0 ? `up ${d}d ${h}h` : h > 0 ? `up ${h}h ${m}m` : `up ${m}m`;
  };

  const setBar = (node, pct) => {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    node.style.width = `${v}%`;
    node.className = `bar-fill ${levelClass(v)}`;
  };

  const setBanner = (state, msg) => {
    refs.statusDot.className = `dot ${state === 'ok' ? 'dot-ok' : state === 'err' ? 'dot-err' : 'dot-idle'}`;
    refs.errorBanner.textContent = msg || '';
    refs.errorBanner.classList.toggle('hidden', !msg);
  };

  function renderData(d) {
    const cpu = Number(d.cpu?.percent || 0);
    const ram = Number(d.memory?.percent || 0);
    const disk = Number(d.disk?.percent || 0);
    document.title = `${d.hostname || 'Server-Pulse'} · RAM ${Math.round(ram)}%`;
    refs.hostName.textContent = d.hostname || 'server';
    const swap = d.memory?.swap_used_mb > 0 ? ` · swap ${formatMem(d.memory.swap_used_mb)}` : '';
    refs.hostSub.textContent = `${formatUptime(d.uptime_sec)}${swap}`;

    refs.cpuVal.textContent = `${cpu.toFixed(1)}%`;
    refs.cpuSub.textContent = `${d.cpu?.cores || 0}c`;
    setBar(refs.cpuBar, cpu);

    refs.ramVal.textContent = `${ram.toFixed(1)}%`;
    refs.ramSub.textContent = `${formatMem(d.memory?.used_mb)}/${formatMem(d.memory?.total_mb)}`;
    setBar(refs.ramBar, ram);

    refs.diskVal.textContent = `${disk.toFixed(1)}%`;
    refs.diskSub.textContent = `${Number(d.disk?.used_gb || 0).toFixed(0)}/${Number(d.disk?.total_gb || 0).toFixed(0)}G`;
    setBar(refs.diskBar, disk);

    const containers = Array.isArray(d.containers) ? [...d.containers].sort((a, b) => (b.mem_mb || 0) - (a.mem_mb || 0)) : [];
    const running = containers.filter((c) => c.state === 'running').length;
    refs.containerCount.textContent = containers.length ? `${running}/${containers.length}` : '0';

    const cFrag = document.createDocumentFragment();
    if (!containers.length) {
      cFrag.appendChild(el('div', 'empty', 'No containers detected'));
    } else {
      for (const c of containers) {
        const up = c.state === 'running';
        const row = el('div', up ? 'row' : 'row row-stopped');
        const top = el('div', 'row-top');
        const left = el('div', 'row-left');
        left.appendChild(el('span', `dot ${up ? 'dot-ok' : 'dot-idle'}`));
        left.appendChild(el('span', 'row-name', c.name || c.id));
        const stats = el('div', 'row-stats num');
        if (up) {
          stats.appendChild(el('span', 'stat-mem', formatMem(c.mem_mb)));
          stats.appendChild(el('span', 'stat-cpu', `${Number(c.cpu_percent || 0).toFixed(1)}%`));
        } else {
          stats.appendChild(el('span', 'stat-cpu', c.state || 'stopped'));
        }
        top.appendChild(left);
        top.appendChild(stats);
        row.appendChild(top);
        const bar = el('div', 'bar');
        const fill = el('div', 'bar-fill');
        const pct = up ? Math.max(0, Math.min(100, Number(c.mem_percent) || 0)) : 0;
        fill.style.width = `${pct}%`;
        fill.className = `bar-fill ${up ? levelClass(pct) : 'lvl-muted'}`;
        bar.appendChild(fill);
        row.appendChild(bar);
        cFrag.appendChild(row);
      }
    }
    refs.containerList.replaceChildren(cFrag);

    const procs = Array.isArray(d.processes) ? d.processes : [];
    refs.procCount.textContent = String(procs.length);
    const pFrag = document.createDocumentFragment();
    if (!procs.length) {
      pFrag.appendChild(el('div', 'empty', 'No host processes reported'));
    } else {
      for (const p of procs) {
        const row = el('div', 'row');
        const top = el('div', 'row-top');
        const left = el('div', 'row-left');
        left.appendChild(el('span', 'row-name', p.name || `pid:${p.pid}`));
        const stats = el('div', 'row-stats num');
        stats.appendChild(el('span', 'stat-mem', formatMem(p.mem_mb)));
        stats.appendChild(el('span', 'stat-cpu', `${Number(p.cpu_percent || 0).toFixed(1)}%`));
        top.appendChild(left);
        top.appendChild(stats);
        row.appendChild(top);
        pFrag.appendChild(row);
      }
    }
    refs.procList.replaceChildren(pFrag);
  }

  async function fetchMetrics(tok) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch('/api/metrics', {
        headers: { Authorization: `Bearer ${tok}` },
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.status === 401) throw new Error('UNAUTHORIZED');
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function stopPoll() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPoll() {
    stopPoll();
    if (!inAuth && token && !document.hidden) {
      pollTimer = setInterval(() => { refresh(false); }, POLL_MS);
    }
  }

  function showAuth(open, msg = '') {
    inAuth = open;
    refs.authView.classList.toggle('hidden', !open);
    refs.dashboardView.classList.toggle('hidden', open);
    refs.authBtn.classList.toggle('active', open);
    refs.authStatus.textContent = msg;
    refs.authStatus.className = msg ? 'status-msg err' : 'status-msg';
    refs.clearTokenBtn.classList.toggle('hidden', !token);
    if (open) {
      stopPoll();
      refs.tokenInput.value = '';
      refs.tokenInput.focus();
    } else {
      startPoll();
    }
  }

  async function refresh(spin = true) {
    if (!token) return;
    if (spin) refs.refreshBtn.classList.add('spinning');
    try {
      const data = await fetchMetrics(token);
      renderData(data);
      setBanner('ok', '');
    } catch (err) {
      if (err?.message === 'UNAUTHORIZED') {
        setBanner('err', '');
        showAuth(true, 'Invalid Bearer token (401).');
      } else {
        setBanner('err', 'Server offline or timed out.');
      }
    } finally {
      refs.refreshBtn.classList.remove('spinning');
    }
  }

  refs.refreshBtn.addEventListener('click', () => { if (!inAuth) refresh(true); });
  refs.authBtn.addEventListener('click', () => showAuth(!inAuth));
  refs.procToggle.addEventListener('click', () => {
    const open = refs.procToggle.getAttribute('aria-expanded') === 'true';
    refs.procToggle.setAttribute('aria-expanded', String(!open));
    refs.procList.classList.toggle('hidden', open);
    refs.procChevron.classList.toggle('open', !open);
  });

  refs.clearTokenBtn.addEventListener('click', () => {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    setBanner('idle', '');
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
      token = candidate;
      localStorage.setItem(TOKEN_KEY, token);
      renderData(data);
      setBanner('ok', '');
      showAuth(false);
    } catch (err) {
      refs.authStatus.textContent = err?.message === 'UNAUTHORIZED' ? 'Invalid token (401).' : 'Connection failed.';
      refs.authStatus.className = 'status-msg err';
    } finally {
      refs.connectBtn.disabled = false;
    }
  });

  document.addEventListener('visibilitychange', () => (document.hidden ? stopPoll() : startPoll()));

  const hashTok = window.location.hash.replace(/^#/, '').trim();
  if (hashTok) {
    token = decodeURIComponent(hashTok);
    localStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, '', window.location.pathname);
  } else {
    token = (localStorage.getItem(TOKEN_KEY) || '').trim();
  }

  if (!token) {
    showAuth(true);
  } else {
    refs.dashboardView.classList.remove('hidden');
    refresh(false).then(startPoll);
  }
})();
