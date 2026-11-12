/* Takeoff. A static front end for the cloud takeoff runner in a private GitHub repo.
   Everything talks to api.github.com with the fine-grained token saved on this device. No job data lives in this site. */
(function () {
  'use strict';

  const API = 'https://api.github.com';
  const CHUNK = 32 * 1024 * 1024;          // a drawing set goes up in parts this size, git blobs take up to 100 MB
  const PARALLEL = 2;                       // parts uploaded at the same time
  const POLL_MS = 8000;
  const MAX_SET = 2 * 1024 * 1024 * 1024;   // 2 GB, far above any real set
  const KEY = 'takeoff.v1.';
  // the branch whose copy of .github/workflows/takeoff.yml runs
  const WORKFLOW_REF = 'cloud-app';

  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage full or off */ } },
    del: (k) => localStorage.removeItem(KEY + k),
  };
  const cfg = () => ({
    token: store.get('token', ''),
    repo: store.get('repo', 'Ridgify/takeoff'),
    ref: store.get('ref', WORKFLOW_REF),
    // engine v3 is the default (Nov 11, 2026). A saved 'master' was the old default, not a choice, so it moves to v3
    engine: ((e) => (e === 'master' ? 'engine-v3' : e))(store.get('engine', 'engine-v3')),
    dry: store.get('dry', false),
  });

  const $app = document.getElementById('app');
  let timers = [];
  let busy = false; // an upload is running
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  /* ---------- small helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // the CSP has no 'unsafe-inline' for styles, so per-element styles ride in data-s and are set through the CSSOM
  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    t.content.querySelectorAll('[data-s]').forEach((el) => { el.style.cssText = el.dataset.s; el.removeAttribute('data-s'); });
    return t.content;
  }
  function $(id) { return document.getElementById(id); }
  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function fmtNum(n) { return n == null || n === '' ? '' : Number(n).toLocaleString('en-US'); }
  // a bare YYYY-MM-DD is a calendar day, not midnight UTC, so it never slips a day west of Greenwich
  function toDate(v) {
    if (!v) return null;
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
    return isNaN(d) ? null : d;
  }
  function fmtDay(v, withYear) {
    const d = toDate(v);
    if (!d) return '';
    return d.toLocaleDateString('en-US', withYear === false ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function when(iso) {
    const d = toDate(iso);
    if (!d) return '';
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return 'Today, ' + t;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + t;
  }
  function dur(fromIso, toIso) {
    if (!fromIso) return '';
    const ms = (toIso ? new Date(toIso) : new Date()) - new Date(fromIso);
    if (!(ms >= 0)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
  }
  function newId(name) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    const rnd = Math.random().toString(36).slice(2, 5);
    return (slug(name) + '-' + stamp + '-' + rnd).replace(/^-+/, '');
  }
  function plural(n, one, many) { return fmtNum(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function setTitle(t) { document.title = t ? t + ' | Takeoff' : 'Takeoff'; }

  const I = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M11 8v6M8 11h6M16 16l4.5 4.5"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M8 11h6M16 16l4.5 4.5"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v4.5h16V15"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    bang: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 6v8M12 18h.01"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  };

  /* ---------- GitHub API ---------- */
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function gh(path, opts) {
    opts = opts || {};
    const headers = { Authorization: 'Bearer ' + cfg().token, Accept: opts.accept || 'application/vnd.github+json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(API + path, { method: opts.method || 'GET', headers, cache: opts.cache || 'no-store', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      throw new ApiError(0, 'Could not reach GitHub. Check the connection and try again.');
    }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).message || ''; } catch (e) { /* not json */ }
      throw new ApiError(r.status, explain(r.status, msg));
    }
    if (opts.raw) return r;
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  function explain(status, msg) {
    if (status === 401) return 'GitHub did not accept the token. It may have expired. Add a new one in Settings.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub says too many requests for now. Wait a minute and try again.';
    if (status === 403) return 'The token is missing a permission. It needs Contents and Actions set to Read and write.';
    if (status === 404) return 'Not found. Check the token can see the repository ' + cfg().repo + '.';
    return 'GitHub said: ' + (msg || ('error ' + status));
  }
  const repoPath = () => '/repos/' + cfg().repo;
  const branchOf = (id) => 'jobs/' + id;
  function contentsUrl(id, path) {
    return repoPath() + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(branchOf(id));
  }
  async function readFile(id, path, as, cache) {
    const r = await gh(contentsUrl(id, path), { accept: 'application/vnd.github.raw+json', raw: true, cache });
    return as === 'blob' ? r.blob() : r.json();
  }

  // images come through the API as blobs, four at a time, kept for the session
  const blobUrls = new Map();
  let active = 0;
  const waiting = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      const go = () => { active++; fn().then(resolve, reject).finally(() => { active--; const n = waiting.shift(); if (n) n(); }); };
      if (active < 4) go(); else waiting.push(go);
    });
  }
  function imageUrl(id, path) {
    const k = id + '|' + path;
    if (!blobUrls.has(k)) {
      const p = limited(() => readFile(id, path, 'blob', 'default'))
        .then((b) => URL.createObjectURL(new Blob([b], { type: /\.webp$/i.test(path) ? 'image/webp' : (/\.png$/i.test(path) ? 'image/png' : 'image/jpeg') })));
      p.catch(() => blobUrls.delete(k));
      blobUrls.set(k, p);
    }
    return blobUrls.get(k);
  }

  // one part of the set, posted as a git blob with upload progress
  function postBlob(b64, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', API + repoPath() + '/git/blobs');
      x.setRequestHeader('Authorization', 'Bearer ' + cfg().token);
      x.setRequestHeader('Accept', 'application/vnd.github+json');
      x.setRequestHeader('Content-Type', 'application/json');
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) { try { resolve(JSON.parse(x.responseText).sha); } catch (e) { reject(new ApiError(x.status, 'GitHub sent an answer that could not be read')); } }
        else { let m = ''; try { m = JSON.parse(x.responseText).message; } catch (e) { /* */ } reject(new ApiError(x.status, explain(x.status, m))); }
      };
      x.onerror = () => reject(new ApiError(0, 'The upload lost its connection.'));
      x.send(JSON.stringify({ content: b64, encoding: 'base64' }));
    });
  }
  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = fr.result; resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  /* ---------- routing ---------- */
  let mounted = { page: null, id: null };
  function parse() {
    const hash = location.hash || '#/';
    const [path, qs] = hash.slice(1).split('?');
    return { path: path || '/', q: new URLSearchParams(qs || '') };
  }
  function route() {
    const { path, q } = parse();
    const c = cfg();
    let m = path.match(/^\/job\/([a-z0-9-]+)(?:\/(deck|plans)\/(\d+))?$/);
    // the viewer opens and closes over a job that is already on screen
    if (m && mounted.page === 'job' && mounted.id === m[1] && mounted.result) {
      if (m[2]) openViewer(m[1], m[2], +m[3] - 1); else closeViewer(true);
      return;
    }
    closeViewer(true);
    clearTimers();
    document.querySelectorAll('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
    mounted = { page: null, id: null };
    document.body.classList.toggle('signed-out', !c.token);
    if (!c.token && path !== '/settings') return renderWelcome();
    if (m) return renderJob(m[1], m[2] ? { kind: m[2], index: +m[3] - 1 } : null);
    if (path === '/new') { nav('new'); return renderNew(); }
    if (path === '/settings') { nav('settings'); return renderSettings(); }
    nav('library');
    return renderLibrary(q);
  }
  function nav(k) { const a = document.querySelector('[data-nav="' + k + '"]'); if (a && !a.classList.contains('btn')) a.setAttribute('aria-current', 'page'); }
  function mount(frag, page) {
    $app.replaceChildren(frag);
    if ($app.firstElementChild) $app.firstElementChild.classList.add('fade');
    window.scrollTo(0, 0);
    mounted.page = page || null;
  }
  window.addEventListener('hashchange', () => {
    if (busy) { toast('The upload is still running. Keep this page open.'); return; }
    route();
  });
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- welcome and settings ---------- */
  const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Takeoff&description=Takeoff%20site&expires_in=366&contents=write&actions=write&metadata=read';
  function tokenForm(full) {
    const c = cfg();
    return `
      <label class="field"><span>GitHub token</span>
        <input class="input" id="tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…" value="${esc(c.token)}">
        <em>Kept in this browser only and sent to api.github.com, nowhere else.</em></label>
      ${full ? `<label class="field"><span>Repository</span><input class="input" id="repo" type="text" autocapitalize="off" spellcheck="false" value="${esc(c.repo)}"></label>` : ''}
      <div id="tokmsg" class="mt" role="status"></div>
      <div class="mt"><button class="btn primary" id="save" type="button">Save and check</button></div>`;
  }
  async function checkToken() {
    await gh(repoPath());
    await gh(repoPath() + '/actions/workflows/takeoff.yml');
  }
  function wireTokenForm(after) {
    const btn = $('save');
    const run = async () => {
      const tok = $('tok').value.trim();
      const repoEl = $('repo');
      const msg = $('tokmsg');
      if (!tok) { msg.innerHTML = '<div class="note warn">Paste the token first.</div>'; $('tok').focus(); return; }
      store.set('token', tok);
      if (repoEl && repoEl.value.trim()) store.set('repo', repoEl.value.trim());
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Checking…';
      msg.innerHTML = '';
      try {
        await checkToken();
        msg.innerHTML = '<div class="note ok">Connected to ' + esc(cfg().repo) + '. This device is set.</div>';
        toast('Token saved on this device');
        later(after, 700);
      } catch (e) {
        msg.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>';
      } finally { btn.removeAttribute('aria-busy'); btn.textContent = 'Save and check'; }
    };
    btn.onclick = run;
    $('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }
  function renderWelcome() {
    setTitle('Connect');
    mount(h(`
      <section class="narrow">
        <h1 class="h1">Window counts from drawing sets</h1>
        <p class="lede">Every takeoff in one place, with the totals, the deck, the workbook and the circled plans. New sets run in the cloud. Connect this device once to open the library.</p>
        <div class="block">
          <h2>Connect this device</h2>
          <ol class="how">
            <li><span>Open <a href="${TOKEN_URL}" target="_blank" rel="noopener">a new fine-grained token</a> on GitHub.</span></li>
            <li><span>Resource owner <b>Ridgify</b>. Repository access <b>Only select repositories</b>, then pick <b>Ridgify/takeoff</b>.</span></li>
            <li><span>Repository permissions: <b>Contents</b> and <b>Actions</b> set to Read and write.</span></li>
            <li><span>Generate it, copy it and paste it below.</span></li>
          </ol>
          ${tokenForm(false)}
        </div>
      </section>`), 'welcome');
    wireTokenForm(() => { location.hash = '#/'; route(); });
  }
  function renderSettings() {
    const c = cfg();
    setTitle('Settings');
    mount(h(`
      <section class="narrow">
        <h1 class="h1">Settings</h1>
        <p class="lede">Saved on this device only.</p>
        <div class="block"><h2>GitHub</h2>${tokenForm(true)}</div>
        <div class="block">
          <h2>Runs</h2>
          <label class="switch" for="dry"><span><span data-s="font-weight:600">Dry run</span><br><span class="small faint">Runs every step except the Claude calls and saves sample files. For testing the pipeline.</span></span><input type="checkbox" id="dry" ${c.dry ? 'checked' : ''}></label>
          <label class="field"><span>Engine branch</span><input class="input" id="engine" type="text" autocapitalize="off" spellcheck="false" value="${esc(c.engine)}"></label>
          <label class="field"><span>Workflow branch</span><input class="input" id="ref" type="text" autocapitalize="off" spellcheck="false" value="${esc(c.ref)}"></label>
          <div class="mt"><button class="btn" id="saveadv" type="button">Save run settings</button></div>
        </div>
        <div class="block">
          <h2>This device</h2>
          <p class="small muted mt">Removing the token signs this browser out. The jobs stay in the repository.</p>
          <div class="mt"><button class="btn danger" id="forget" type="button">Remove the token</button></div>
        </div>
      </section>`), 'settings');
    wireTokenForm(() => {});
    $('saveadv').onclick = () => {
      store.set('dry', $('dry').checked);
      store.set('engine', $('engine').value.trim() || 'master');
      store.set('ref', $('ref').value.trim() || WORKFLOW_REF);
      toast('Run settings saved');
    };
    $('forget').onclick = () => {
      if (!confirm('Remove the token from this device?')) return;
      store.del('token'); store.del('jobs2'); toast('Token removed'); location.hash = '#/'; route();
    };
  }

  /* ---------- the library ---------- */
  function remember(id, row) { const all = store.get('jobs2', {}); all[id] = Object.assign(all[id] || {}, row); store.set('jobs2', all); }
  function stampOf(id) {
    const m = String(id).match(/(\d{8})-(\d{4})-[a-z0-9]{3}$/);
    return m ? m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6) + 'T' + m[2].slice(0, 2) + ':' + m[2].slice(2) : '';
  }
  function rowFrom(id, sha, s) {
    const sum = s.summary || {};
    const kind = s.kind || (s.dry_run ? 'dry-run' : 'cloud');
    return {
      id, sha, kind,
      name: s.name || id,
      state: s.state || 'queued',
      date: s.delivered || s.finished_at || s.started_at || stampOf(id),
      location: s.location || '',
      count: sum.count != null ? sum.count : sum.windows,
      countLabel: sum.count_label || 'windows',
      patio: sum.patio_doors,
      send: sum.send,
      label: s.status_label || '',
      recount: sum.recount || null,
    };
  }
  async function listJobs() {
    const refs = await gh(repoPath() + '/git/matching-refs/heads/jobs/');
    const items = (refs || []).map((r) => ({ id: r.ref.replace('refs/heads/jobs/', ''), sha: r.object && r.object.sha }))
      .filter((x) => /^[a-z0-9-]+$/.test(x.id));
    const cache = store.get('jobs2', {});
    const out = [];
    let i = 0;
    async function w() {
      while (i < items.length) {
        const { id, sha } = items[i++];
        const known = cache[id];
        if (known && known.sha === sha && known.state === 'done') { out.push(known); continue; }
        try {
          const row = rowFrom(id, sha, await readFile(id, 'status.json'));
          if (row.state === 'done') remember(id, row);
          out.push(row);
        } catch (e) { out.push({ id, sha, name: id, state: 'queued', kind: 'cloud', date: stampOf(id) }); }
      }
    }
    await Promise.all([w(), w(), w(), w(), w(), w()]);
    // forget jobs whose branch is gone
    const live = new Set(items.map((x) => x.id));
    const kept = {};
    Object.keys(cache).forEach((k) => { if (live.has(k)) kept[k] = cache[k]; });
    out.forEach((r) => { if (r.state === 'done') kept[r.id] = r; });
    store.set('jobs2', kept);
    out.sort((a, b) => (String(b.date || '')).localeCompare(String(a.date || '')));
    return out;
  }
  const GROUPS = [
    { key: 'delivered', label: 'Delivered', test: (j) => j.kind === 'delivery' || j.kind === 'follow-up', count: (j) => j.kind === 'delivery' },
    { key: 'all', label: 'All', test: (j) => j.kind !== 'dry-run' },
    { key: 'engine', label: 'Engine', test: (j) => j.kind === 'engine-test' || j.kind === 'cloud' },
    { key: 'dry', label: 'Dry runs', test: (j) => j.kind === 'dry-run' },
  ];
  function statusOf(j) {
    if (j.state === 'queued') return { cls: 'running', text: 'Waiting to start' };
    if (j.state === 'running') return { cls: 'running', text: 'Running' };
    if (j.state === 'failed') return { cls: 'stopped', text: 'Stopped' };
    if (j.state === 'stopped') return { cls: 'stopped', text: 'Cancelled' };
    if (j.kind === 'follow-up') return { cls: 'delivered followup', text: 'Follow-up, answered' };
    if (j.kind === 'delivery') return { cls: 'delivered', text: j.label || 'Delivered' };
    if (j.kind === 'engine-test') return { cls: 'test', text: j.label || 'Engine test' };
    if (j.kind === 'dry-run') return { cls: 'test', text: 'Dry run, sample numbers' };
    if (j.send === true) return { cls: 'send', text: 'Ready, check says send' };
    if (j.send === false) return { cls: 'hold', text: 'Ready, check says hold' };
    return { cls: 'send', text: 'Ready' };
  }
  // the blind recount of a past delivery (Nov 2026 audit): match, over, under, open or not checked
  function rcMark(j) {
    const r = j.recount;
    if (!r || !r.short) return '';
    return `<span class="rc ${esc(r.result || 'none')}">Recount: ${esc(r.short)}</span>`;
  }
  function stMark(s) { return `<span class="st ${s.cls}"><i aria-hidden="true"></i>${esc(s.text)}</span>`; }
  // a short run with end ticks reads like a letter H, so below the cutoff it becomes a dot
  function dimbar(v, max, cutoff) {
    if (!(v > 0) || !(max > 0)) return '';
    const pct = 100 * v / max;
    if (pct < (cutoff || 7)) return '<span class="dimbar dot" aria-hidden="true"><i></i></span>';
    return `<span class="dimbar" aria-hidden="true"><i data-s="width:${pct.toFixed(1)}%"></i></span>`;
  }
  function libRow(j, max) {
    const st = statusOf(j);
    const hasCount = j.count != null && j.state === 'done';
    return `<li><a class="row-a" href="#/job/${esc(j.id)}">
      <span class="r-date">${esc(fmtDay(j.date, true))}</span>
      <span class="r-main"><span class="r-name">${esc(j.name)}</span>
        <span class="r-meta"><span class="r-day-m">${esc(fmtDay(j.date))}</span>${j.location ? `<span>${esc(j.location)}</span>` : ''}${stMark(st)}${rcMark(j)}</span></span>
      <span class="r-count">${hasCount ? `<span><b>${fmtNum(j.count)}</b> <small>${esc(j.countLabel)}</small></span>${j.countLabel === 'windows' ? dimbar(j.count, max, 30) : ''}` : `<span class="none">${j.state === 'queued' || j.state === 'running' ? 'Counting…' : 'No result'}</span>`}</span>
      <span class="r-st">${stMark(st)}${rcMark(j)}</span>
    </a></li>`;
  }
  function skeletonRows(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += `<li><div class="row-a" aria-hidden="true"><span class="r-date"><span class="skel" data-s="width:70%"></span></span><span class="r-main"><span class="skel" data-s="width:${40 + (i * 13) % 35}%;height:17px"></span><span class="skel" data-s="width:30%;margin-top:8px"></span></span><span class="r-count"><span class="skel" data-s="width:60px;height:24px"></span></span><span class="r-st"><span class="skel" data-s="width:70%"></span></span></div></li>`;
    return s;
  }
  function colhead() { return '<div class="colhead" aria-hidden="true"><span>Date</span><span>Project</span><span>Count</span><span>Status</span></div>'; }
  async function renderLibrary(q) {
    setTitle('');
    const qText = q.get('q') || '';
    const group = GROUPS.find((g) => g.key === q.get('f')) || GROUPS[0];
    mount(h(`
      <section>
        <div class="lib-head">
          <div>
            <h1 class="h1">Takeoffs</h1>
            <div class="tally" id="tally"><div><b><span class="skel" data-s="display:inline-block;width:60px;height:28px"></span></b><span>delivered</span></div></div>
          </div>
        </div>
        <div class="tools">
          <label class="search"><span class="sr">Search takeoffs</span>${I.search}<input class="input" id="q" type="search" placeholder="Search by project or city…" autocomplete="off" spellcheck="false" value="${esc(qText)}"></label>
          <div class="seg" id="seg" role="group" aria-label="Show">${GROUPS.map((g) => `<button type="button" data-f="${g.key}" aria-pressed="${g === group}">${g.label}<span data-n="${g.key}"></span></button>`).join('')}</div>
        </div>
        <div id="list">${colhead()}<ul class="rows" aria-busy="true">${skeletonRows(7)}</ul></div>
      </section>`), 'library');

    let jobs;
    try {
      jobs = await listJobs();
    } catch (e) {
      if (!$('list')) return;
      $('list').replaceChildren(h(`<div class="empty"><h2>The library did not load</h2><p>${esc(e.message)}</p><div class="row"><button class="btn" id="retry" type="button">Try again</button><a class="btn quiet" href="#/settings">Settings</a></div></div>`));
      $('retry').onclick = () => route();
      $('tally').replaceChildren();
      return;
    }
    if (!$('list')) return;
    const delivered = jobs.filter((j) => j.kind === 'delivery');
    const followUps = jobs.filter((j) => j.kind === 'follow-up').length;
    const windows = delivered.reduce((a, j) => a + (j.countLabel === 'windows' && typeof j.count === 'number' ? j.count : 0), 0);
    const first = delivered.map((j) => j.date).filter(Boolean).sort()[0];
    $('tally').replaceChildren(h(`
      <div><b>${fmtNum(delivered.length)}</b><span>takeoffs delivered${followUps ? `, plus ${plural(followUps, 'follow-up')}` : ''}</span></div>
      <div><b>${fmtNum(windows)}</b><span>windows counted on them</span></div>
      ${first ? `<div><b>${esc(toDate(first).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }))}</b><span>first delivery</span></div>` : ''}`));
    GROUPS.forEach((g) => { const el = document.querySelector('[data-n="' + g.key + '"]'); if (el) el.textContent = jobs.filter(g.count || g.test).length; });

    let cur = group;
    function draw() {
      const needle = ($('q').value || '').trim().toLowerCase();
      const shown = jobs.filter(cur.test).filter((j) => !needle || (j.name + ' ' + (j.location || '') + ' ' + j.id).toLowerCase().includes(needle));
      const max = Math.max(1, ...shown.filter((j) => j.countLabel === 'windows').map((j) => j.count || 0));
      if (!shown.length) {
        const none = !jobs.length;
        $('list').replaceChildren(h(none
          ? `<div class="empty"><h2>No takeoffs yet</h2><p>Start the first one with a drawing set. It shows up here while it runs and stays here when it is done.</p><a class="btn primary" href="#/new">New takeoff</a></div>`
          : `<div class="empty"><h2>Nothing matches ${needle ? '“' + esc(needle) + '”' : 'this view'}</h2><p>Try a project name or a city.</p><button class="btn" id="clear" type="button">Clear the search</button></div>`));
        const c = $('clear');
        if (c) c.onclick = () => { $('q').value = ''; cur = GROUPS[0]; sync(); draw(); };
        return;
      }
      const months = [];
      shown.forEach((j) => {
        const d = toDate(j.date);
        const key = d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') : 'undated';
        let g = months.find((m) => m.key === key);
        if (!g) { g = { key, label: d ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'No date', rows: [] }; months.push(g); }
        g.rows.push(j);
      });
      $('list').replaceChildren(h(colhead() + months.map((m) => `
        <div class="month"><h2>${esc(m.label)}<span>${plural(m.rows.length, 'job')}</span></h2>
        <ul class="rows">${m.rows.map((j) => libRow(j, max)).join('')}</ul></div>`).join('')));
    }
    function sync() {
      document.querySelectorAll('#seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === cur.key)));
      const p = new URLSearchParams();
      if ($('q').value.trim()) p.set('q', $('q').value.trim());
      if (cur.key !== 'delivered') p.set('f', cur.key);
      const s = p.toString();
      history.replaceState(null, '', '#/' + (s ? '?' + s : ''));
    }
    $('seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cur = GROUPS.find((g) => g.key === b.dataset.f) || GROUPS[0]; sync(); draw(); };
    $('q').oninput = () => { sync(); draw(); };
    draw();
  }

  /* ---------- new takeoff ---------- */
  function renderNew() {
    const c = cfg();
    let file = null;
    setTitle('New takeoff');
    mount(h(`
      <section>
        <div class="crumb"><a href="#/">Takeoffs</a>${I.next}<span>New</span></div>
        <h1 class="h1">New takeoff</h1>
        <p class="lede">Drop the drawing set as a PDF or a ZIP. The cloud counts every window and patio door, checks itself and builds the deck, the workbook and the circled plans.</p>
        ${c.dry ? '<div class="note warn mt">Dry run is on in Settings. This run makes sample files, not a real count.</div>' : ''}
        <div class="newgrid">
          <div>
            <div id="pick">
              <label class="drop" id="drop">
                <input type="file" id="file" accept=".pdf,.zip,application/pdf,application/zip,application/x-zip-compressed" aria-label="Pick the drawing set">
                <span class="crop a"></span><span class="crop b"></span><span class="crop c"></span><span class="crop d"></span>
                <span class="up">${I.up}</span>
                <span class="big">Drop the drawing set here</span>
                <span class="muted small">or tap to pick a PDF or ZIP, up to 2 GB</span>
              </label>
            </div>
            <label class="field"><span>Job name</span><input class="input" id="name" type="text" maxlength="80" placeholder="Harbor Point Apartments" autocomplete="off"></label>
            <label class="field"><span>What Greg asked for</span><textarea class="input" id="scope" maxlength="1000" required placeholder="Paste Greg's line, e.g. &quot;Please quote the vinyl window types only.&quot;"></textarea><em>Required. The engine reads it as the scope for the count.</em></label>
            <label class="field"><span>Other notes</span><textarea class="input" id="note" maxlength="1000" placeholder="Anything else, like leave out the clubhouse…"></textarea><em>Optional.</em></label>
            <div class="mt"><button class="btn primary block" id="go" type="button">Start takeoff</button></div>
            <div id="up" hidden class="scale">
              <div class="scale-bar live"><i id="upbar" data-s="width:0%"></i></div>
              <div class="scale-lab"><span id="uptext">Uploading…</span><span id="uppct">0%</span></div>
              <p class="small faint mt">Keep this page open until the upload finishes. After that the takeoff keeps running with the page closed.</p>
            </div>
            <div id="err" class="mt" role="alert"></div>
          </div>
          <aside class="aside" aria-label="What happens">
            <h3>What happens</h3>
            <ol>
              <li>The set uploads to the private job store.</li>
              <li>A cloud computer reads every sheet and counts windows and patio doors by type, building and floor.</li>
              <li>A second, independent check says send or don't send.</li>
              <li>The deck, workbook and circled plans land on the job page. A full set takes about 30 to 90 minutes.</li>
            </ol>
          </aside>
        </div>
      </section>`), 'new');

    const $drop = $('drop');
    const $name = $('name');
    const $go = $('go');
    function choose(f) {
      if (!f) return;
      if (!/\.(pdf|zip)$/i.test(f.name)) { $('err').innerHTML = '<div class="note warn">That is not a PDF or a ZIP. Pick the drawing set file.</div>'; return; }
      if (f.size > MAX_SET) { $('err').innerHTML = '<div class="note warn">That file is over 2 GB. Split the set into two jobs.</div>'; return; }
      $('err').innerHTML = '';
      file = f;
      if (!$name.value.trim()) $name.value = f.name.replace(/\.(pdf|zip)$/i, '').replace(/[_]+/g, ' ').slice(0, 80);
      const ext = (f.name.match(/\.(pdf|zip)$/i) || ['', 'file'])[1].toUpperCase();
      $('pick').replaceChildren(h(`<div class="picked"><span class="fmt ${ext === 'PDF' ? 'pdf' : ''}">${ext}</span><div><div class="name">${esc(f.name)}</div><div class="small faint">${fmtBytes(f.size)}</div></div><button class="btn sm" id="swap" type="button">Change</button></div>`));
      $('swap').onclick = () => renderNew();
    }
    $('file').onchange = (e) => choose(e.target.files[0]);
    ['dragenter', 'dragover'].forEach((t) => $drop.addEventListener(t, (e) => { e.preventDefault(); $drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => $drop.addEventListener(t, (e) => { e.preventDefault(); $drop.classList.remove('over'); }));
    $drop.addEventListener('drop', (e) => choose(e.dataTransfer.files[0]));
    $go.onclick = () => {
      if (!file) { $('err').innerHTML = '<div class="note warn">Add the drawing set first.</div>'; return; }
      if (!$name.value.trim()) { $('err').innerHTML = '<div class="note warn">Give the job a name.</div>'; $name.focus(); return; }
      if (!$('scope').value.trim()) { $('err').innerHTML = '<div class="note warn">Paste what Greg asked for. The count follows it.</div>'; $('scope').focus(); return; }
      startJob(file, $name.value.trim(), $('note').value.trim(), $('scope').value.trim());
    };
  }

  async function startJob(file, name, note, scope) {
    const c = cfg();
    const id = newId(name);
    const $bar = $('upbar');
    const $pct = $('uppct');
    const $txt = $('uptext');
    const $err = $('err');
    const $go = $('go');
    $go.setAttribute('aria-busy', 'true');
    $go.disabled = true;
    $('up').hidden = false;
    $err.innerHTML = '';
    busy = true;
    let lock = null;
    try { if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch (e) { /* not offered */ }

    const n = Math.max(1, Math.ceil(file.size / CHUNK));
    const done = new Array(n).fill(0);
    const shas = new Array(n);
    const show = () => {
      const sent = done.reduce((a, b, i) => a + b * Math.min(CHUNK, file.size - i * CHUNK), 0);
      const p = Math.min(99, Math.floor(100 * sent / Math.max(1, file.size)));
      $bar.style.width = p + '%';
      $pct.textContent = p + '%';
      $txt.textContent = 'Uploading ' + fmtBytes(sent) + ' of ' + fmtBytes(file.size);
    };
    try {
      let next = 0;
      async function worker() {
        while (next < n) {
          const i = next++;
          const part = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
          let tries = 0;
          for (;;) {
            try {
              const b64 = await toBase64(part);
              shas[i] = await postBlob(b64, (f) => { done[i] = f; show(); });
              done[i] = 1; show();
              break;
            } catch (e) {
              if (++tries >= 4 || e.status === 401 || e.status === 403 || e.status === 404) throw e;
              $txt.textContent = 'Connection dropped, sending part ' + (i + 1) + ' again';
              await new Promise((r) => setTimeout(r, 2000 * tries));
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL, n) }, worker));
      $txt.textContent = 'Starting the cloud run';
      const parts = shas.map((_, i) => 'input/part-' + String(i + 1).padStart(4, '0'));
      const now = new Date().toISOString();
      const job = { id, name, note, scope_note: scope, file_name: file.name, size: file.size, parts, created_at: now, dry_run: !!c.dry, engine_ref: c.engine };
      const status = { id, name, state: 'queued', step: 'setup', message: 'Waiting for a cloud computer', percent: 1, started_at: now, updated_at: now, dry_run: !!c.dry, steps: [] };
      const tree = parts.map((p, i) => ({ path: p, mode: '100644', type: 'blob', sha: shas[i] }));
      tree.push({ path: 'job.json', mode: '100644', type: 'blob', content: JSON.stringify(job, null, 1) });
      tree.push({ path: 'status.json', mode: '100644', type: 'blob', content: JSON.stringify(status, null, 1) });
      const t = await gh(repoPath() + '/git/trees', { method: 'POST', body: { tree } });
      const cm = await gh(repoPath() + '/git/commits', { method: 'POST', body: { message: 'New takeoff: ' + name, tree: t.sha } });
      await gh(repoPath() + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + branchOf(id), sha: cm.sha } });
      await dispatch(id);
      $bar.style.width = '100%'; $pct.textContent = '100%';
      busy = false;
      toast('Takeoff started');
      location.hash = '#/job/' + id;
    } catch (e) {
      busy = false;
      $err.innerHTML = '<div class="note bad">' + esc(e.message || String(e)) + ' Nothing was started, so it is safe to try again.</div>';
      $go.disabled = false;
      $go.removeAttribute('aria-busy');
    } finally {
      busy = false;
      if (lock) { try { lock.release(); } catch (e) { /* */ } }
    }
  }
  async function dispatch(id) {
    const c = cfg();
    let dry = !!c.dry;
    try { const j = await readFile(id, 'job.json'); dry = !!j.dry_run; } catch (e) { /* use the setting */ }
    await gh(repoPath() + '/actions/workflows/takeoff.yml/dispatches', {
      method: 'POST', body: { ref: c.ref || WORKFLOW_REF, inputs: { job_id: id, dry_run: dry ? 'true' : 'false', engine_ref: c.engine || 'engine-v3', engine_version: /v3/.test(c.engine || 'engine-v3') ? 'v3' : 'v2' } },
    });
  }

  /* ---------- one job ---------- */
  async function findRun(id) {
    try {
      const r = await gh(repoPath() + '/actions/workflows/takeoff.yml/runs?per_page=30&event=workflow_dispatch');
      return (r.workflow_runs || []).find((x) => (x.display_title || '').split(' ')[1] === id) || null;
    } catch (e) { return null; }
  }
  function jobSkeleton() {
    return `<div aria-busy="true"><div class="skel" data-s="width:120px"></div><div class="skel" data-s="width:min(520px,80%);height:40px;margin-top:16px"></div>
      <div class="skel" data-s="height:62px;margin-top:22px"></div><div class="skel" data-s="width:220px;height:150px;margin-top:34px"></div></div>`;
  }
  function renderJob(id, openAt) {
    setTitle('Job');
    mount(h(`<section id="job">${jobSkeleton()}</section>`), 'job');
    mounted.id = id;
    let lastRunCheck = 0;
    let run = null;
    async function tick() {
      const box = $('job');
      if (!box || mounted.id !== id) return;
      let s = null;
      try { s = await readFile(id, 'status.json'); } catch (e) {
        if (e.status === 404) {
          box.replaceChildren(h(`<div class="empty"><h2>No job called ${esc(id)}</h2><p>The link may be old, or the token can't see this job.</p><a class="btn" href="#/">Back to the library</a></div>`));
          return;
        }
        if (!box.dataset.shown) box.replaceChildren(h(`<div class="empty"><h2>The job did not load</h2><p>${esc(e.message)}</p><button class="btn" id="retry" type="button">Try again</button></div>`));
        const rb = $('retry'); if (rb) rb.onclick = () => route();
        later(tick, POLL_MS * 2);
        return;
      }
      if (s.state === 'done') return renderResult(id, s, openAt);
      if (Date.now() - lastRunCheck > 20000) { lastRunCheck = Date.now(); run = await findRun(id); }
      // the run ended without saying so in status.json (it failed before its first write, or was cancelled)
      if (run && run.status === 'completed' && (s.state === 'queued' || s.state === 'running')) {
        s.state = run.conclusion === 'cancelled' ? 'stopped' : 'failed';
        s.message = run.conclusion === 'cancelled' ? 'The run was cancelled.' : 'The run stopped. Open the run on GitHub to see why.';
        s.run_url = s.run_url || run.html_url;
      }
      renderProgress(id, s, run);
      if (s.state === 'queued' || s.state === 'running') later(tick, POLL_MS);
    }
    tick();
  }
  function crumb(name) { return `<div class="crumb"><a href="#/">Takeoffs</a>${I.next}<span>${esc(name)}</span></div>`; }
  function titleBlock(cells) {
    return `<dl class="titleblock">${cells.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }
  function renderProgress(id, s, run) {
    const box = $('job');
    if (!box) return;
    box.dataset.shown = '1';
    setTitle(s.name || id);
    const live = s.state === 'running' || s.state === 'queued';
    const steps = (s.steps && s.steps.length) ? s.steps : [{ key: 'setup', label: 'Waiting for a cloud computer', state: 'running' }];
    const cur = steps.find((x) => x.state === 'running') || steps.find((x) => x.state === 'failed');
    const runUrl = s.run_url || (run && run.html_url);
    const pct = Math.max(1, Math.min(100, s.percent || 1));
    const st = statusOf({ state: s.state, kind: s.dry_run ? 'dry-run' : 'cloud' });
    box.replaceChildren(h(`
      <div>
        ${crumb(s.name || id)}
        <h1 class="h1">${esc(s.name || id)}</h1>
        ${titleBlock([
          ['Started', esc(when(s.started_at)) || 'Not yet'],
          [live ? 'Running for' : 'Ran for', esc(dur(s.started_at, live ? null : s.updated_at)) || 'Under a minute'],
          ['Status', stMark(st)],
          ['Run', s.dry_run ? 'Dry run, sample files' : 'Full count'],
        ])}
        <div class="now">
          <span class="small faint">${live ? 'Now' : (s.state === 'failed' ? 'Stopped at' : 'Last step')}</span>
          <b>${esc(cur ? cur.label : (s.message || 'Waiting for a cloud computer'))}</b>
          ${s.message && (!cur || s.message !== cur.label) ? `<p class="muted">${esc(s.message)}</p>` : ''}
          ${s.state === 'failed' || s.state === 'stopped' ? '' : `
          <div class="scale"><div class="scale-bar ${live ? 'live' : ''}"><i data-s="width:${pct}%"></i></div>
            <div class="scale-lab"><span>About 30 to 90 minutes for a full set. Close the page any time.</span><span>${pct}%</span></div></div>`}
        </div>
        <div class="sec">
          <div class="sec-head"><h2 class="h2">Steps</h2><span class="small faint">Updated ${esc(when(s.updated_at))}</span></div>
          <ol class="steps">${steps.map((x, i) => `<li class="${esc(x.state)}"><span class="ix">${i + 1}</span><span>${esc(x.label)}</span><span class="tk">${x.state === 'done' ? I.tick : (x.state === 'failed' ? I.bang : '')}</span></li>`).join('')}</ol>
          ${s.log && s.log.length ? `<div class="log">${esc(s.log.join('\n'))}</div>` : ''}
        </div>
        <div class="row mt">
          ${(s.state === 'failed' || s.state === 'stopped') ? '<button class="btn primary" id="again" type="button">Run it again</button>' : ''}
          ${runUrl ? `<a class="btn" href="${esc(runUrl)}" target="_blank" rel="noopener">Open the run on GitHub ${I.ext}</a>` : ''}
          ${live && run && run.status !== 'completed' ? '<button class="btn quiet danger" id="cancel" type="button">Cancel the run</button>' : ''}
        </div>
      </div>`));
    const again = $('again');
    if (again) again.onclick = async () => {
      again.disabled = true;
      try { await dispatch(id); toast('Started again'); later(() => renderJob(id), 1500); } catch (e) { toast(e.message); again.disabled = false; }
    };
    const cancel = $('cancel');
    if (cancel) cancel.onclick = async () => {
      if (!confirm('Cancel this takeoff? The drawing set stays, so it can run again.')) return;
      cancel.disabled = true;
      try { await gh(repoPath() + '/actions/runs/' + run.id + '/cancel', { method: 'POST' }); toast('Cancelling the run'); } catch (e) { toast(e.message); cancel.disabled = false; }
    };
  }

  // the dimension string: one drafted line split into runs, a tick at each break, the count above each run
  function dimString(obj, caption) {
    const rows = Object.entries(obj || {}).filter(([, v]) => typeof v === 'number' && v > 0);
    if (rows.length < 2 || rows.length > 80) return '';
    const total = rows.reduce((a, [, v]) => a + v, 0);
    return `<div class="dim" aria-hidden="true"><div class="dim-cap"><span>${esc(caption)}</span><span>${plural(rows.length, 'run')}, ${fmtNum(total)} in all</span></div>
      <div class="dimline">${rows.map(([k, v]) => `<div class="seg-d" data-s="flex:${v} 1 0" title="${esc(k)}: ${fmtNum(v)}"><i></i><b>${fmtNum(v)}</b><span>${esc(k)}</span></div>`).join('')}</div></div>`;
  }
  function fitDims(root) {
    root.querySelectorAll('.seg-d').forEach((el) => {
      const b = el.querySelector('b'); const s = el.querySelector('span');
      el.classList.remove('tight');
      if (b.scrollWidth > el.clientWidth + 1 || s.scrollWidth > el.clientWidth + 1) el.classList.add('tight');
    });
  }
  function countTable(obj, head, totalLabel, opts) {
    const rows = Object.entries(obj || {}).filter(([, v]) => typeof v === 'number');
    if (!rows.length) return '';
    if (!(opts && opts.keepOrder)) rows.sort((a, b) => b[1] - a[1]);
    const max = Math.max(...rows.map((r) => r[1]), 1);
    const total = rows.reduce((a, [, v]) => a + v, 0);
    return `<table class="t"><thead><tr><th scope="col">${esc(head)}</th><th scope="col"><span class="sr">Share</span></th><th scope="col" class="n">Count</th></tr></thead>
      <tbody>${rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="b">${dimbar(v, max)}</td><td class="n">${fmtNum(v)}</td></tr>`).join('')}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td class="k">${esc(totalLabel || 'Total')}</td><td></td><td class="n">${fmtNum(total)}</td></tr></tfoot>` : ''}</table>`;
  }
  function fileFormat(n) { const m = String(n).toLowerCase().match(/\.(xlsx|pdf|pptx|md|html|txt|docx)$/); return m ? m[1] : 'file'; }

  async function renderResult(id, s, openAt) {
    const box = $('job');
    let r;
    try { r = await readFile(id, 'result.json'); } catch (e) {
      box.replaceChildren(h(`<div class="empty"><h2>The results did not load</h2><p>${esc(e.message)}</p><button class="btn" id="retry" type="button">Try again</button></div>`));
      $('retry').onclick = () => route();
      return;
    }
    if (!$('job') || mounted.id !== id) return;
    mounted.result = r;
    const name = r.name || s.name || id;
    setTitle(name);
    const kind = r.kind || (r.dry_run ? 'dry-run' : 'cloud');
    const t = r.totals || {};
    const prim = r.primary || { n: t.windows, label: 'windows' };
    const st = statusOf({ state: 'done', kind, label: r.status_label || s.status_label, send: r.verdict ? r.verdict.send : null });
    const delivered = kind === 'delivery' || kind === 'follow-up';
    const day = r.delivered || s.delivered || s.finished_at;
    const filesShort = (r.files || []).map((f) => f.label).filter((v, i, a) => a.indexOf(v) === i);
    const cells = [
      [delivered ? 'Delivered' : (kind === 'engine-test' ? 'Ran' : 'Finished'), esc(delivered ? fmtDay(day) : (fmtDay(day) || when(s.finished_at)))],
      ['Location', esc(r.location || 'Not on the deck')],
      ['Status', stMark(st)],
      [kind === 'cloud' || kind === 'dry-run' ? 'Took' : 'Files', esc(kind === 'cloud' || kind === 'dry-run' ? (dur(s.started_at, s.finished_at) || 'Not recorded') : (filesShort.length ? plural((r.files || []).length, 'file') + ', listed below' : 'None found'))],
    ];
    const side = [];
    if (t.patio_doors != null && prim.label !== 'patio doors') side.push([t.patio_doors, 'patio doors']);
    Object.entries(t.other || {}).forEach(([k, v]) => { if (typeof v === 'number') side.push([v, k]); });
    if (kind === 'cloud' || kind === 'dry-run') {
      const blocking = (r.flags && r.flags.by_severity && r.flags.by_severity.changes_count) || 0;
      side.push([blocking, 'flags that change the count']);
    }
    const bLabel = t.by_building_label || 'By building';
    const dimSrc = Object.keys(t.by_building || {}).length >= 2 ? [bLabel, t.by_building] : ['By type', t.by_type];
    const v = r.verdict;
    let verdictHtml = '';
    if (delivered) {
      verdictHtml = `<div class="verdict info"><span class="mark">${I.tick}</span><h2>${esc(st.text)}</h2>
        <p>${esc(r.headline || ('Sent ' + fmtDay(day) + '. The numbers on this page are read from the delivered files.'))}</p>
        ${v && v.headline ? `<p class="vcheck"><b>Independent check: ${v.send ? 'send' : 'hold'}.</b> ${esc(v.headline)}</p>` : ''}
        ${(r.notes || []).length ? `<ul>${r.notes.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`;
    } else if (v && v.send != null) {
      verdictHtml = `<div class="verdict ${v.send ? 'send' : 'hold'}"><span class="mark">${v.send ? I.tick : I.bang}</span>
        <h2>${v.send ? 'Send' : 'Don\'t send yet'}</h2><p>${esc(v.headline || '')}</p>
        ${(v.problems || []).length ? `<ul>${v.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`;
    } else if (kind === 'engine-test') {
      verdictHtml = `<div class="verdict info"><span class="mark">${I.bang}</span><h2>Engine test, not a delivery</h2>
        <p>${esc(r.headline || 'A rerun of a delivered job to test the engine. Nothing here was delivered.')}</p>
        ${(r.notes || []).length ? `<ul>${r.notes.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>`;
    } else if (kind === 'cloud') {
      verdictHtml = `<div class="verdict hold"><span class="mark">${I.bang}</span><h2>No verdict yet</h2><p>The independent check did not write one. Read the review summary before sending.</p></div>`;
    }
    const rc = r.recount;
    if (rc && rc.headline) {
      const cls = rc.result === 'match' ? 'ok' : (rc.result === 'over' || rc.result === 'under') ? 'bad' : 'warn';
      verdictHtml += `<div class="note ${cls} recount"><h2>Blind recount: ${esc(rc.short)}</h2>
        <p>${esc(rc.headline)}</p>
        ${rc.count != null ? `<p class="rcn"><b>${rc.approx ? 'About ' : ''}${fmtNum(rc.count)}</b> ${esc(prim.label)} on the recount, ${fmtNum(prim.n)} delivered</p>` : ''}
        ${rc.checked ? `<p><b>Checked:</b> ${esc(rc.checked)}</p>` : ''}
        ${rc.not_checked ? `<p><b>Not checked:</b> ${esc(rc.not_checked)}</p>` : ''}
        ${rc.proof ? `<p class="src">Proof: ${esc(rc.proof)}</p>` : ''}</div>`;
    }
    const viewers = r.viewers || {};
    const strip = (k) => {
      const vw = viewers[k];
      if (!vw || !vw.pages || !vw.pages.length) return '';
      const unit = k === 'deck' ? 'slide' : 'sheet';
      const p0 = vw.pages[0];
      return `<div class="sec">
        <div class="sec-head"><h2 class="h2">${esc(vw.label || (k === 'deck' ? 'Deck' : 'Circled plans'))}<small>${plural(vw.pages.length, unit)}${vw.total > vw.pages.length ? ' of ' + fmtNum(vw.total) : ''}</small></h2>
          <a class="btn quiet sm" href="#/job/${esc(id)}/${k}/1">Open ${I.next}</a></div>
        <div class="strip ${k}" data-s="--ar:${p0.w} / ${p0.h}">${vw.pages.map((p, i) => `
          <a class="thumb" href="#/job/${esc(id)}/${k}/${i + 1}" aria-label="${esc((k === 'deck' ? 'Slide ' : 'Sheet ') + (i + 1))}">
            <span class="frame" data-s="--ar:${p.w} / ${p.h}"><span class="skel"></span><img alt="" data-src="${esc(p.t)}" width="${p.w}" height="${p.h}" decoding="async"></span>
            <span class="cap"><span>${k === 'deck' ? 'Slide' : 'Sheet'} ${i + 1}</span></span></a>`).join('')}</div></div>`;
    };
    const missing = (r.missing || []).filter(Boolean);
    const sources = r.sources || {};
    const srcLine = (k) => sources[k] ? `<p class="src">From ${esc(sources[k])}</p>` : '';
    const hasTypes = Object.keys(t.by_type || {}).length;
    const hasBldg = Object.keys(t.by_building || {}).length;
    const hasDoors = Object.keys(t.patio_doors_by_type || {}).length;

    box.replaceChildren(h(`
      <div>
        ${crumb(name)}
        <h1 class="h1">${esc(name)}</h1>
        ${titleBlock(cells)}
        <div class="hero">
          <div>
            <div class="total">${prim.n != null ? `<b>${fmtNum(prim.n)}</b><span>${esc(prim.label)}${r.primary && r.primary.note ? `<em>${esc(r.primary.note)}</em>` : ''}</span>` : '<span>No count in the delivered files</span>'}</div>
            ${r.scope_note ? `<p class="scope"><span>What Greg asked for</span>${esc(r.scope_note)}</p>` : ''}
            ${dimString(dimSrc[1], dimSrc[0])}
          </div>
          ${side.length ? `<div class="sidecounts">${side.map(([n, l], i) => `<div class="${side.length % 2 && i === side.length - 1 && side.length > 1 ? 'wide' : ''}"><b>${fmtNum(n)}</b><span>${esc(l)}</span></div>`).join('')}</div>` : ''}
        </div>
        ${srcLine('totals')}
        ${verdictHtml}
        ${strip('deck')}
        ${strip('plans')}
        ${hasTypes || hasBldg ? `<div class="sec two">
          ${hasTypes ? `<div><div class="sec-head"><h2 class="h2">By type</h2></div>${countTable(t.by_type, 'Type', 'All ' + prim.label)}${srcLine('by_type')}
            ${hasDoors ? `<div class="sec" data-s="margin-top:28px"><div class="sec-head"><h2 class="h2">Patio doors by type</h2></div>${countTable(t.patio_doors_by_type, 'Type', 'All patio doors')}</div>` : ''}</div>` : ''}
          ${hasBldg ? `<div><div class="sec-head"><h2 class="h2">${esc(bLabel)}</h2></div>${countTable(t.by_building, bLabel.replace(/^By /, '').replace(/^./, (c) => c.toUpperCase()).replace(/,.*$/, ''), 'All ' + prim.label, { keepOrder: true })}${srcLine('by_building')}</div>` : ''}
        </div>` : ''}
        ${r.flags && r.flags.top && r.flags.top.length ? `<div class="sec"><div class="sec-head"><h2 class="h2">Flags to look at first</h2><small class="faint">${plural(r.flags.total, 'flag')} in all</small></div>
          <table class="t"><tbody>${r.flags.top.map((f) => `<tr><td class="k" data-s="width:90px">${f.severity === 'changes_count' ? 'Count' : 'Type'}</td><td>${esc(f.title)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${r.audit && r.audit.areas ? `<p class="src">Blind recount: ${fmtNum(r.audit.agree)} of ${fmtNum(r.audit.areas)} random areas agree.</p>` : ''}
        <div class="sec">
          <div class="sec-head"><h2 class="h2">Files</h2><small class="faint">${plural((r.files || []).length, 'file')}</small></div>
          ${(r.files || []).length ? `<ul class="files">${r.files.map((f, i) => `<li><button class="file" type="button" data-i="${i}">
            <span class="fmt ${fileFormat(f.name)}">${fileFormat(f.name).toUpperCase()}</span>
            <span><span class="fl">${esc(f.label)}</span><span class="fs">${esc(f.name)}, ${fmtBytes(f.size)}</span></span>
            <span class="go">${I.down}<span class="sr">Download</span></span></button></li>`).join('')}</ul>` : '<p class="muted mt">No files were saved for this job.</p>'}
          ${missing.length ? `<div class="note warn missing">Not found for this job: ${esc(missing.join(', '))}.</div>` : ''}
        </div>
        ${r.note ? `<p class="src">Scope note: ${esc(r.note)}</p>` : ''}
        ${s.run_url ? `<div class="mt"><a class="btn quiet sm" href="${esc(s.run_url)}" target="_blank" rel="noopener">Open the run on GitHub ${I.ext}</a></div>` : ''}
      </div>`));
    box.querySelectorAll('.file').forEach((b) => { b.onclick = () => download(id, r.files[+b.dataset.i], b); });
    fitDims(box);
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => fitDims(box)); box.querySelectorAll('.dimline').forEach((d) => ro.observe(d)); }
    lazyThumbs(id, box);
    if (openAt) openViewer(id, openAt.kind, openAt.index);
  }
  function lazyThumbs(id, root) {
    const imgs = root.querySelectorAll('img[data-src]');
    const load = (img) => {
      const p = img.dataset.src; img.removeAttribute('data-src');
      imageUrl(id, p).then((u) => { img.src = u; img.onload = () => { img.classList.add('in'); const sk = img.previousElementSibling; if (sk) sk.remove(); }; })
        .catch(() => { const sk = img.previousElementSibling; if (sk) sk.style.animation = 'none'; });
    };
    if (!('IntersectionObserver' in window)) { imgs.forEach(load); return; }
    // the first few of each strip load right away, the rest as they come near the screen
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); load(e.target); } }), { rootMargin: '600px 600px' });
    imgs.forEach((i) => { if (Array.from(i.closest('.strip').children).indexOf(i.closest('.thumb')) < 3) load(i); else io.observe(i); });
  }
  async function download(id, f, el) {
    if (el.getAttribute('aria-busy') === 'true') return;
    el.setAttribute('aria-busy', 'true');
    const label = el.querySelector('.fs');
    const old = label.textContent;
    label.textContent = 'Downloading…';
    try {
      let blob;
      if (f.parts && f.parts.length) {
        const pieces = [];
        for (let i = 0; i < f.parts.length; i++) {
          label.textContent = 'Downloading part ' + (i + 1) + ' of ' + f.parts.length + '…';
          pieces.push(await readFile(id, f.parts[i], 'blob'));
        }
        blob = new Blob(pieces);
      } else {
        blob = await readFile(id, f.path, 'blob');
      }
      const types = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', md: 'text/markdown', html: 'text/html', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      const e = (f.name.match(/\.([a-z]+)$/i) || ['', ''])[1].toLowerCase();
      const url = URL.createObjectURL(new Blob([blob], { type: types[e] || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      label.textContent = old;
    } catch (e) {
      label.textContent = old;
      toast(e.message || 'The download failed. Try again.');
    } finally { el.removeAttribute('aria-busy'); }
  }

  /* ---------- the viewer: swipe between pages, pinch or wheel to zoom, drag to pan ---------- */
  let V = null;
  function closeViewer(fromRoute) {
    if (!V) return;
    const v = V;
    V = null;
    v.cleanup();
    v.el.remove();
    document.documentElement.style.overflow = '';
    if (v.returnFocus && document.contains(v.returnFocus)) v.returnFocus.focus({ preventScroll: true });
    if (!fromRoute) {
      if (v.pushed) history.back(); else location.replace('#/job/' + v.id);
    }
  }
  function openViewer(id, kind, index) {
    const r = mounted.result;
    const vw = r && r.viewers && r.viewers[kind];
    if (!vw || !vw.pages || !vw.pages.length) { location.replace('#/job/' + id); return; }
    if (V && V.id === id && V.kind === kind) { V.go(index, false); return; }
    if (V) closeViewer(true);
    const pages = vw.pages;
    const n = pages.length;
    const unit = kind === 'deck' ? 'Slide' : 'Sheet';
    const el = document.createElement('div');
    el.className = 'viewer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', (vw.label || kind) + ' viewer');
    el.innerHTML = `
      <div class="v-top">
        <div class="v-title"><b>${esc(r.name || id)}</b><span>${esc(vw.label || kind)}</span></div>
        <button class="vb" data-a="out" aria-label="Zoom out" type="button">${I.minus}</button>
        <button class="vb" data-a="in" aria-label="Zoom in" type="button">${I.plus}</button>
        <button class="vb" data-a="fit" aria-label="Fit to screen" type="button">${I.fit}</button>
        <button class="vb" data-a="close" aria-label="Close" type="button">${I.close}</button>
      </div>
      <div class="v-stage" aria-roledescription="carousel"><div class="v-track">${pages.map((p, i) => `<div class="v-slide" role="group" aria-roledescription="slide" aria-label="${unit} ${i + 1} of ${n}"><div class="v-box"><span class="skel"></span><img alt="${esc((vw.label || kind) + ', ' + unit.toLowerCase() + ' ' + (i + 1))}" draggable="false"></div></div>`).join('')}</div>
        <div class="v-hint" id="vhint">${matchMedia('(pointer: coarse)').matches ? 'Swipe for the next page. Pinch or double tap to zoom.' : 'Arrow keys for pages. Scroll or double click to zoom, drag to move.'}</div></div>
      <div class="v-bot">
        <button class="vb" data-a="prev" aria-label="Previous ${unit.toLowerCase()}" type="button">${I.back}</button>
        <div class="v-count" aria-live="polite"></div>
        <button class="vb" data-a="next" aria-label="Next ${unit.toLowerCase()}" type="button">${I.next}</button>
      </div>`;
    document.body.appendChild(el);
    document.documentElement.style.overflow = 'hidden';
    const stage = el.querySelector('.v-stage');
    const track = el.querySelector('.v-track');
    const slides = Array.from(el.querySelectorAll('.v-slide'));
    const count = el.querySelector('.v-count');
    const hint = el.querySelector('.v-hint');
    let W = 0, H = 0, idx = Math.max(0, Math.min(n - 1, index || 0));
    let s = 1, tx = 0, ty = 0;           // zoom and pan of the current page box
    const fit = [];                       // fitted box per page {x, y, w, h}
    const loaded = {};                    // page index -> 's' or 'z'

    function layout() {
      const b = stage.getBoundingClientRect();
      W = b.width; H = b.height;
      const pad = W < 600 ? 8 : 28;
      pages.forEach((p, i) => {
        const k = Math.min((W - pad * 2) / p.w, (H - pad * 2) / p.h);
        const w = p.w * k, hh = p.h * k;
        fit[i] = { x: (W - w) / 2, y: (H - hh) / 2, w, h: hh };
        const box = slides[i].firstElementChild;
        box.style.left = fit[i].x + 'px'; box.style.top = fit[i].y + 'px';
        box.style.width = w + 'px'; box.style.height = hh + 'px';
      });
      s = 1; tx = 0; ty = 0; apply(); place(false);
    }
    function place(anim, dx) {
      track.classList.toggle('anim', !!anim);
      track.style.transform = 'translate3d(' + (-idx * W + (dx || 0)) + 'px,0,0)';
    }
    function clamp() {
      const f = fit[idx];
      const cw = f.w * s, chh = f.h * s;
      tx = cw <= W ? (W - cw) / 2 - f.x : Math.min(-f.x, Math.max(W - f.x - cw, tx));
      ty = chh <= H ? (H - chh) / 2 - f.y : Math.min(-f.y, Math.max(H - f.y - chh, ty));
    }
    function apply() {
      const box = slides[idx].firstElementChild;
      box.style.transform = s === 1 && tx === 0 && ty === 0 ? '' : 'translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + s + ')';
      stage.classList.toggle('zoomed', s > 1.01);
      if (s > 1.35) want(idx, 'z');
    }
    function zoomAt(ns, px, py) {
      ns = Math.max(1, Math.min(kind === 'plans' ? 8 : 4, ns));
      const f = fit[idx];
      const qx = px - f.x, qy = py - f.y;
      tx = qx - (qx - tx) * (ns / s);
      ty = qy - (qy - ty) * (ns / s);
      s = ns;
      if (s === 1) { tx = 0; ty = 0; } else clamp();
      apply();
    }
    function want(i, size) {
      if (i < 0 || i >= n) return;
      if (loaded[i] === 'z' || loaded[i] === size + '-loading' || (size === 's' && loaded[i] === 's')) return;
      const prev = loaded[i];
      loaded[i] = size + '-loading';
      imageUrl(id, pages[i][size]).then((u) => {
        const img = slides[i].querySelector('img');
        const done = () => { const sk = slides[i].querySelector('.skel'); if (sk) sk.remove(); };
        const pre = new Image();
        pre.onload = () => { img.src = u; done(); };
        pre.src = u;
        loaded[i] = size;
      }).catch(() => {
        loaded[i] = prev;
        if (!prev) { const box = slides[i].firstElementChild; if (!box.querySelector('.v-err')) box.insertAdjacentHTML('beforeend', '<div class="v-err">This page did not load. Close and open it again.</div>'); }
      });
    }
    function go(i, anim) {
      const old = idx;
      idx = Math.max(0, Math.min(n - 1, i));
      if (old !== idx) { const ob = slides[old].firstElementChild; ob.style.transform = ''; }
      s = 1; tx = 0; ty = 0; apply();
      place(anim !== false);
      count.textContent = unit + ' ' + (idx + 1) + ' of ' + n;
      el.querySelector('[data-a="prev"]').disabled = idx === 0;
      el.querySelector('[data-a="next"]').disabled = idx === n - 1;
      want(idx, 's'); want(idx + 1, 's'); want(idx - 1, 's');
      history.replaceState(null, '', '#/job/' + id + '/' + kind + '/' + (idx + 1));
    }

    // pointers: one finger swipes or pans, two pinch
    const pts = new Map();
    let g = null;      // gesture start
    let lastTap = 0, lastTapX = 0, lastTapY = 0;
    function rel(e) { const b = stage.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
    function startGesture() {
      const a = Array.from(pts.values());
      if (a.length === 1) g = { mode: 'one', x: a[0].x, y: a[0].y, tx, ty, t: Date.now(), moved: false, pinched: g && g.pinched };
      else if (a.length >= 2) {
        const [p, q] = a;
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const f = fit[idx];
        g = { mode: 'two', d: Math.hypot(p.x - q.x, p.y - q.y) || 1, s, cx: (mx - f.x - tx) / s, cy: (my - f.y - ty) / s, pinched: true, moved: true };
      }
    }
    function down(e) {
      if (e.button > 0) return;
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, rel(e));
      hint.style.opacity = '0';
      startGesture();
    }
    function move(e) {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, rel(e));
      const a = Array.from(pts.values());
      if (g.mode === 'two' && a.length >= 2) {
        const [p, q] = a;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        const ns = Math.max(1, Math.min(kind === 'plans' ? 8 : 4, g.s * d / g.d));
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const f = fit[idx];
        s = ns; tx = mx - f.x - g.cx * s; ty = my - f.y - g.cy * s;
        if (s === 1) { tx = 0; ty = 0; } else clamp();
        apply();
        return;
      }
      if (g.mode !== 'one') return;
      const dx = a[0].x - g.x, dy = a[0].y - g.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) g.moved = true;
      if (s > 1.01) { tx = g.tx + dx; ty = g.ty + dy; clamp(); apply(); return; }
      if (g.pinched) return;
      const edge = (idx === 0 && dx > 0) || (idx === n - 1 && dx < 0);
      place(false, edge ? dx / 3 : dx);
    }
    function up(e) {
      if (!pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size > 0) { startGesture(); return; }
      const gg = g; g = null;
      if (!gg) return;
      if (gg.mode === 'one' && !gg.moved) {
        const now = Date.now();
        if (now - lastTap < 320 && Math.hypot(p.x - lastTapX, p.y - lastTapY) < 30) {
          lastTap = 0;
          if (s > 1.01) { s = 1; tx = 0; ty = 0; apply(); } else zoomAt(kind === 'plans' ? 3 : 2.2, p.x, p.y);
        } else { lastTap = now; lastTapX = p.x; lastTapY = p.y; }
        place(true);
        return;
      }
      if (gg.mode === 'one' && s <= 1.01 && !gg.pinched) {
        const dx = p.x - gg.x;
        const v = dx / Math.max(1, Date.now() - gg.t);
        if ((dx < -W * 0.16 || v < -0.45) && idx < n - 1) return go(idx + 1);
        if ((dx > W * 0.16 || v > 0.45) && idx > 0) return go(idx - 1);
      }
      place(true);
    }
    function wheel(e) {
      e.preventDefault();
      const p = rel(e);
      if (!e.ctrlKey && s > 1.01 && Math.abs(e.deltaX) > 0.5) { tx -= e.deltaX; ty -= e.deltaY; clamp(); apply(); return; }
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)), p.x, p.y);
      hint.style.opacity = '0';
    }
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeViewer(false); return; }
      const c = { x: W / 2, y: H / 2 };
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (s > 1.01 && e.key === 'ArrowRight') { tx -= 80; clamp(); apply(); } else go(idx + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { if (s > 1.01 && e.key === 'ArrowLeft') { tx += 80; clamp(); apply(); } else go(idx - 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && s > 1.01) { ty += 80; clamp(); apply(); e.preventDefault(); }
      else if (e.key === 'ArrowDown' && s > 1.01) { ty -= 80; clamp(); apply(); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') zoomAt(s * 1.5, c.x, c.y);
      else if (e.key === '-' || e.key === '_') zoomAt(s / 1.5, c.x, c.y);
      else if (e.key === '0') zoomAt(1, c.x, c.y);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(n - 1);
      else if (e.key === 'Tab') {
        const f = Array.from(el.querySelectorAll('button:not([disabled])'));
        const i = Math.max(-1, f.indexOf(document.activeElement));
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    }
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const c = { x: W / 2, y: H / 2 };
      const a = b.dataset.a;
      if (a === 'close') closeViewer(false);
      else if (a === 'in') zoomAt(s * 1.6, c.x, c.y);
      else if (a === 'out') zoomAt(s / 1.6, c.x, c.y);
      else if (a === 'fit') zoomAt(1, c.x, c.y);
      else if (a === 'prev') go(idx - 1);
      else if (a === 'next') go(idx + 1);
    });
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('keydown', key);
    const onResize = () => layout();
    window.addEventListener('resize', onResize);
    const hintTimer = setTimeout(() => { hint.style.opacity = '0'; }, 3500);

    V = {
      id, kind, el, go,
      pushed: mounted.openedByClick === true,
      returnFocus: document.activeElement,
      cleanup() {
        document.removeEventListener('keydown', key);
        window.removeEventListener('resize', onResize);
        clearTimeout(hintTimer);
      },
    };
    mounted.openedByClick = false;
    layout();
    go(idx, false);
    requestAnimationFrame(() => { layout(); place(false); });
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  }
  // a thumbnail tap pushes a history entry, so the phone's back gesture closes the viewer
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href*="/deck/"], a[href*="/plans/"]');
    if (a && mounted.page === 'job') mounted.openedByClick = true;
  }, true);

  route();
})();
