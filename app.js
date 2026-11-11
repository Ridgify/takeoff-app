/* Takeoff. A static front end for the cloud takeoff runner in a private GitHub repo.
   Everything talks to api.github.com with the fine-grained token saved on this device. No data lives in this site. */
(function () {
  'use strict';

  const API = 'https://api.github.com';
  const CHUNK = 32 * 1024 * 1024;          // a drawing set goes up in parts this size, git blobs take up to 100 MB
  const PARALLEL = 2;                       // parts uploaded at the same time
  const POLL_MS = 8000;
  const MAX_SET = 2 * 1024 * 1024 * 1024;   // 2 GB, far above any real set
  const KEY = 'takeoff.v1.';

  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => localStorage.setItem(KEY + k, JSON.stringify(v)),
    del: (k) => localStorage.removeItem(KEY + k),
  };
  const cfg = () => ({
    token: store.get('token', ''),
    repo: store.get('repo', 'Ridgify/takeoff'),
    ref: store.get('ref', 'master'),
    engine: store.get('engine', 'master'),
    dry: store.get('dry', false),
  });

  const $app = document.getElementById('app');
  let timers = [];
  let busy = false; // an upload is running
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }
  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function fmtNum(n) { return n == null ? '' : Number(n).toLocaleString('en-US'); }
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (same) return 'Today ' + t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t;
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
    const t = document.getElementById('toast');
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
  const STATE_WORD = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Stopped', stopped: 'Cancelled' };

  /* ---------- GitHub API ---------- */
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function gh(path, opts) {
    opts = opts || {};
    const headers = { Authorization: 'Bearer ' + cfg().token, Accept: opts.accept || 'application/vnd.github+json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(API + path, { method: opts.method || 'GET', headers, cache: 'no-store', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
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
  async function readFile(id, path, as) {
    const r = await gh(repoPath() + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(branchOf(id)),
      { accept: 'application/vnd.github.raw+json', raw: true });
    return as === 'blob' ? r.blob() : r.json();
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
  function route() {
    clearTimers();
    const hash = location.hash || '#/';
    const c = cfg();
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.remove('on'));
    if (!c.token && !hash.startsWith('#/settings')) return renderWelcome();
    let m;
    if ((m = hash.match(/^#\/job\/([a-z0-9-]+)/))) return renderJob(m[1]);
    if (hash.startsWith('#/jobs')) { nav('jobs'); return renderJobs(); }
    if (hash.startsWith('#/settings')) { nav('settings'); return renderSettings(); }
    nav('home');
    return renderHome();
  }
  function nav(k) { const a = document.querySelector('[data-nav="' + k + '"]'); if (a) a.classList.add('on'); }
  function mount(frag) { $app.replaceChildren(frag); $app.firstElementChild && $app.firstElementChild.classList.add('fade'); window.scrollTo(0, 0); }
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
        <input id="tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_..." value="${esc(c.token)}"></label>
      ${full ? `
      <label class="field"><span>Repository</span><input id="repo" type="text" autocapitalize="off" spellcheck="false" value="${esc(c.repo)}"></label>` : ''}
      <div id="tokmsg" class="small" style="margin-top:12px"></div>
      <div class="row" style="margin-top:18px"><button class="btn primary block" id="save">Save and check</button></div>`;
  }
  async function checkToken() {
    await gh(repoPath());
    await gh(repoPath() + '/actions/workflows/takeoff.yml');
  }
  function wireTokenForm(after) {
    const btn = document.getElementById('save');
    btn.onclick = async () => {
      const tok = document.getElementById('tok').value.trim();
      const repoEl = document.getElementById('repo');
      const msg = document.getElementById('tokmsg');
      if (!tok) { msg.innerHTML = '<div class="note warn">Paste the token first.</div>'; return; }
      store.set('token', tok);
      if (repoEl && repoEl.value.trim()) store.set('repo', repoEl.value.trim());
      btn.disabled = true;
      msg.innerHTML = '<span class="muted">Checking with GitHub...</span>';
      try {
        await checkToken();
        msg.innerHTML = '<div class="note">Connected to ' + esc(cfg().repo) + '. You are set on this device.</div>';
        toast('Token saved on this device');
        later(after, 700);
      } catch (e) {
        msg.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>';
      } finally { btn.disabled = false; }
    };
  }
  function renderWelcome() {
    mount(h(`
      <section>
        <span class="eyebrow">Window and patio door takeoffs</span>
        <h1>Run a takeoff from any device</h1>
        <p class="sub">Drop in a drawing set and the takeoff runs in the cloud on your Claude plan. Your PC can stay off. This device needs a GitHub token once.</p>
        <div class="card">
          <h2>Connect this device</h2>
          <ol class="steps-list">
            <li>Open <a href="${TOKEN_URL}" target="_blank" rel="noopener">New fine-grained token</a> on GitHub.</li>
            <li>Resource owner <b>Ridgify</b>. Repository access <b>Only select repositories</b>, pick <b>Ridgify/takeoff</b>.</li>
            <li>Repository permissions: <b>Contents</b> Read and write, <b>Actions</b> Read and write. Metadata turns on by itself.</li>
            <li>Generate, copy it, paste it below.</li>
          </ol>
          ${tokenForm(false)}
        </div>
        <p class="small faint">The token stays in this browser only and is sent to api.github.com and nowhere else.</p>
      </section>`));
    wireTokenForm(() => { location.hash = '#/'; route(); });
  }
  function renderSettings() {
    const c = cfg();
    mount(h(`
      <section>
        <h1>Settings</h1>
        <p class="sub">Saved on this device only.</p>
        <div class="card"><h2>GitHub</h2>${tokenForm(true)}</div>
        <div class="card">
          <h2>Advanced</h2>
          <div class="switch"><div><div style="font-weight:600">Dry run</div><div class="small muted">Runs every step except the Claude calls and saves sample files. For testing.</div></div><input type="checkbox" id="dry" ${c.dry ? 'checked' : ''}></div>
          <label class="field"><span>Engine branch</span><input id="engine" type="text" autocapitalize="off" spellcheck="false" value="${esc(c.engine)}"></label>
          <label class="field"><span>Workflow branch</span><input id="ref" type="text" autocapitalize="off" spellcheck="false" value="${esc(c.ref)}"></label>
          <div class="row" style="margin-top:18px"><button class="btn" id="saveadv">Save</button></div>
        </div>
        <div class="card"><h2>This device</h2><button class="btn danger" id="forget">Remove the token from this device</button></div>
      </section>`));
    wireTokenForm(() => {});
    document.getElementById('saveadv').onclick = () => {
      store.set('dry', document.getElementById('dry').checked);
      store.set('engine', document.getElementById('engine').value.trim() || 'master');
      store.set('ref', document.getElementById('ref').value.trim() || 'master');
      toast('Saved');
    };
    document.getElementById('forget').onclick = () => { store.del('token'); toast('Token removed'); location.hash = '#/'; route(); };
  }

  /* ---------- home: new takeoff ---------- */
  function renderHome() {
    const c = cfg();
    let file = null;
    mount(h(`
      <section>
        <span class="eyebrow">${c.dry ? '<span class="chip dry">Dry run is on</span>' : 'New takeoff'}</span>
        <h1>Start a takeoff</h1>
        <p class="sub">Drop the drawing set as a PDF or a ZIP. It counts the windows and patio doors, checks itself and builds the workbook, the deck and the circled plans.</p>
        <div class="card">
          <div id="pick">
            <label class="drop" id="drop">
              <input type="file" id="file" accept=".pdf,.zip,application/pdf,application/zip,application/x-zip-compressed">
              <div class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></div>
              <div class="big">Drop the drawing set here</div>
              <div class="muted small">or tap to pick a PDF or ZIP, up to 2 GB</div>
            </label>
          </div>
          <label class="field"><span>Job name</span><input id="name" type="text" maxlength="80" placeholder="Lake Barton" autocomplete="off"></label>
          <label class="field"><span>Scope note (optional)</span><textarea id="note" maxlength="1000" placeholder="Anything about scope, like buildings to leave out"></textarea></label>
          <div style="margin-top:20px"><button class="btn primary block" id="go" disabled>Start takeoff</button></div>
          <div id="up" class="hidden" style="margin-top:20px">
            <div class="row between small"><span id="uptext" class="muted">Uploading</span><span class="pct" id="uppct">0%</span></div>
            <div class="bar live" style="margin-top:10px"><i id="upbar"></i></div>
            <p class="small faint" style="margin:12px 0 0">Keep this page open until the upload finishes. After that you can close it, the takeoff keeps running.</p>
          </div>
          <div id="err" style="margin-top:14px"></div>
        </div>
        <div id="recent"></div>
      </section>`));

    const $file = document.getElementById('file');
    const $drop = document.getElementById('drop');
    const $pick = document.getElementById('pick');
    const $name = document.getElementById('name');
    const $go = document.getElementById('go');
    function ready() { $go.disabled = !(file && $name.value.trim()); }
    function choose(f) {
      if (!f) return;
      if (!/\.(pdf|zip)$/i.test(f.name)) { document.getElementById('err').innerHTML = '<div class="note warn">Pick a PDF or a ZIP.</div>'; return; }
      if (f.size > MAX_SET) { document.getElementById('err').innerHTML = '<div class="note warn">That file is over 2 GB.</div>'; return; }
      document.getElementById('err').innerHTML = '';
      file = f;
      if (!$name.value.trim()) $name.value = f.name.replace(/\.(pdf|zip)$/i, '').replace(/[_]+/g, ' ').slice(0, 80);
      const ext = (f.name.match(/\.(pdf|zip)$/i) || ['', 'file'])[1].toUpperCase();
      $pick.replaceChildren(h(`<div class="file-pill"><span class="ext">${ext}</span><div class="grow"><div class="name">${esc(f.name)}</div><div class="small muted">${fmtBytes(f.size)}</div></div><button class="btn ghost small" id="swap">Change</button></div>`));
      document.getElementById('swap').onclick = (e) => { e.preventDefault(); renderHome(); };
      ready();
    }
    $file.onchange = () => choose($file.files[0]);
    ['dragenter', 'dragover'].forEach((t) => $drop.addEventListener(t, (e) => { e.preventDefault(); $drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => $drop.addEventListener(t, (e) => { e.preventDefault(); $drop.classList.remove('over'); }));
    $drop.addEventListener('drop', (e) => choose(e.dataTransfer.files[0]));
    $name.oninput = ready;
    $go.onclick = () => startJob(file, $name.value.trim(), document.getElementById('note').value.trim());
    loadRecent();
  }

  async function startJob(file, name, note) {
    const c = cfg();
    const id = newId(name);
    const $up = document.getElementById('up');
    const $bar = document.getElementById('upbar');
    const $pct = document.getElementById('uppct');
    const $txt = document.getElementById('uptext');
    const $err = document.getElementById('err');
    const $go = document.getElementById('go');
    $go.disabled = true;
    $up.classList.remove('hidden');
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
              $txt.textContent = 'Connection hiccup, trying part ' + (i + 1) + ' again';
              await new Promise((r) => setTimeout(r, 2000 * tries));
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL, n) }, worker));
      $txt.textContent = 'Starting the cloud run';
      const parts = shas.map((_, i) => 'input/part-' + String(i + 1).padStart(4, '0'));
      const now = new Date().toISOString();
      const job = { id, name, note, file_name: file.name, size: file.size, parts, created_at: now, dry_run: !!c.dry, engine_ref: c.engine };
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
      remember(id, { id, name, state: 'queued', started_at: now, dry_run: !!c.dry });
      toast('Takeoff started');
      location.hash = '#/job/' + id;
    } catch (e) {
      busy = false;
      $err.innerHTML = '<div class="note bad">' + esc(e.message || String(e)) + ' Nothing was started.</div>';
      $go.disabled = false;
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
      method: 'POST', body: { ref: c.ref || 'master', inputs: { job_id: id, dry_run: dry ? 'true' : 'false', engine_ref: c.engine || 'master' } },
    });
  }

  /* ---------- job list ---------- */
  function remember(id, s) { const all = store.get('jobs', {}); all[id] = Object.assign(all[id] || {}, s); store.set('jobs', all); }
  async function listJobs(limit) {
    const refs = await gh(repoPath() + '/git/matching-refs/heads/jobs/');
    const ids = (refs || []).map((r) => r.ref.replace('refs/heads/jobs/', '')).filter((x) => /^[a-z0-9-]+$/.test(x));
    const cache = store.get('jobs', {});
    // newest first by the time in the id, then fetch status for the newest ones
    ids.sort((a, b) => (stampOf(b) || '').localeCompare(stampOf(a) || ''));
    const pick = ids.slice(0, limit || 40);
    const out = [];
    let i = 0;
    async function w() {
      while (i < pick.length) {
        const id = pick[i++];
        const known = cache[id];
        if (known && (known.state === 'done') && known.summary !== undefined) { out.push(known); continue; }
        try {
          const s = await readFile(id, 'status.json');
          const row = { id, name: s.name || id, state: s.state, started_at: s.started_at, finished_at: s.finished_at, dry_run: s.dry_run, summary: s.summary || null };
          remember(id, row);
          out.push(row);
        } catch (e) { out.push({ id, name: id, state: 'queued' }); }
      }
    }
    await Promise.all([w(), w(), w(), w(), w(), w()]);
    out.sort((a, b) => (b.started_at || stampOf(b.id) || '').localeCompare(a.started_at || stampOf(a.id) || ''));
    return out;
  }
  function stampOf(id) {
    const m = String(id).match(/(\d{8})-(\d{4})-[a-z0-9]{3}$/);
    return m ? m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6) + 'T' + m[2].slice(0, 2) + ':' + m[2].slice(2) : '';
  }
  function jobRow(j) {
    const s = j.summary || {};
    const right = j.state === 'done' && s.windows != null
      ? `<div class="jw"><b>${fmtNum(s.windows)}</b><span>windows</span></div>`
      : `<span class="chip ${esc(j.state)}">${esc(STATE_WORD[j.state] || 'Queued')}</span>`;
    const verdict = j.state === 'done' && s.send != null ? (s.send ? ' · Send' : ' · Don\'t send') : '';
    return `<a class="job" href="#/job/${esc(j.id)}"><div class="grow"><div class="jn">${esc(j.name)}${j.dry_run ? ' <span class="chip dry">Dry run</span>' : ''}</div>
      <div class="jm">${esc(when(j.started_at) || '')}${esc(verdict)}</div></div>${right}</a>`;
  }
  async function loadRecent() {
    const box = document.getElementById('recent');
    if (!box) return;
    try {
      const jobs = await listJobs(6);
      if (!jobs.length || !document.getElementById('recent')) return;
      box.replaceChildren(h(`<div style="margin-top:30px"><div class="row between"><h2>Recent</h2><a class="small" href="#/jobs">All jobs</a></div><div class="jobs">${jobs.slice(0, 5).map(jobRow).join('')}</div></div>`));
    } catch (e) { /* the list is a nice to have here */ }
  }
  async function renderJobs() {
    mount(h(`<section><h1>Jobs</h1><p class="sub">Every takeoff run from any device.</p><div id="list"><div class="empty">Loading...</div></div></section>`));
    try {
      const jobs = await listJobs(60);
      const list = document.getElementById('list');
      if (!list) return;
      list.replaceChildren(h(jobs.length ? `<div class="jobs">${jobs.map(jobRow).join('')}</div>` : `<div class="empty">No takeoffs yet. <a href="#/">Start one</a>.</div>`));
    } catch (e) {
      const list = document.getElementById('list');
      if (list) list.replaceChildren(h(`<div class="note bad">${esc(e.message)}</div>`));
    }
  }

  /* ---------- one job ---------- */
  async function findRun(id) {
    try {
      const r = await gh(repoPath() + '/actions/workflows/takeoff.yml/runs?per_page=30&event=workflow_dispatch');
      return (r.workflow_runs || []).find((x) => (x.display_title || '').split(' ')[1] === id) || null;
    } catch (e) { return null; }
  }
  function renderJob(id) {
    mount(h(`<section id="job"><div class="empty">Loading...</div></section>`));
    let lastRunCheck = 0;
    let run = null;
    async function tick() {
      if (!document.getElementById('job') || location.hash.indexOf(id) < 0) return;
      let s = null;
      try { s = await readFile(id, 'status.json'); } catch (e) {
        if (e.status === 404) { document.getElementById('job').replaceChildren(h(`<div class="note bad">No job called ${esc(id)}.</div>`)); return; }
        if (!document.getElementById('job').dataset.shown) document.getElementById('job').replaceChildren(h(`<div class="note bad">${esc(e.message)}</div>`));
        later(tick, POLL_MS * 2);
        return;
      }
      if (s.state === 'done') { remember(id, { id, name: s.name, state: 'done', started_at: s.started_at, finished_at: s.finished_at, dry_run: s.dry_run, summary: s.summary || null }); return renderResult(id, s); }
      if (Date.now() - lastRunCheck > 20000) { lastRunCheck = Date.now(); run = await findRun(id); }
      // the run ended without saying so in status.json (it failed before its first write, or was cancelled)
      if (run && run.status === 'completed' && (s.state === 'queued' || s.state === 'running')) {
        s.state = run.conclusion === 'cancelled' ? 'stopped' : 'failed';
        s.message = run.conclusion === 'cancelled' ? 'The run was cancelled.' : 'The run stopped. Open the log on GitHub to see why.';
        s.run_url = s.run_url || run.html_url;
      }
      renderProgress(id, s, run);
      if (s.state === 'queued' || s.state === 'running') later(tick, POLL_MS);
    }
    tick();
  }
  function renderProgress(id, s, run) {
    const box = document.getElementById('job');
    if (!box) return;
    box.dataset.shown = '1';
    const live = s.state === 'running' || s.state === 'queued';
    const steps = (s.steps && s.steps.length) ? s.steps : [{ key: 'setup', label: 'Waiting for a cloud computer', state: 'running' }];
    const tick = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
    const runUrl = s.run_url || (run && run.html_url);
    box.replaceChildren(h(`
      <div>
        <div class="row between wrap"><span class="chip ${esc(s.state)}">${esc(STATE_WORD[s.state] || s.state)}</span>${s.dry_run ? '<span class="chip dry">Dry run</span>' : ''}</div>
        <h1 style="margin-top:12px">${esc(s.name || id)}</h1>
        <p class="sub">${esc(s.message || '')}</p>
        ${s.state === 'failed' || s.state === 'stopped' ? '' : `
        <div class="card">
          <div class="row between small"><span class="muted">${live ? 'Running for ' + esc(dur(s.started_at)) : ''}</span><span class="pct">${Math.max(1, s.percent || 1)}%</span></div>
          <div class="bar ${live ? 'live' : ''}" style="margin-top:10px"><i style="width:${Math.max(1, s.percent || 1)}%"></i></div>
          <p class="small faint" style="margin:12px 0 0">A full set takes about 30 to 90 minutes. You can close this page and come back, it keeps running in the cloud.</p>
        </div>`}
        <div class="card">
          <h2>Steps</h2>
          <ul class="steps">${steps.map((x) => `<li class="${esc(x.state)}"><span class="dot">${x.state === 'done' ? tick : (x.state === 'failed' ? '!' : '')}</span>${esc(x.label)}</li>`).join('')}</ul>
          ${s.log && s.log.length ? `<div class="log mono">${esc(s.log.join('\n'))}</div>` : ''}
        </div>
        <div class="row wrap">
          ${runUrl ? `<a class="btn" href="${esc(runUrl)}" target="_blank" rel="noopener">Open the run on GitHub</a>` : ''}
          ${(s.state === 'failed' || s.state === 'stopped') ? '<button class="btn primary" id="again">Run it again</button>' : ''}
          ${live && run && run.status !== 'completed' ? '<button class="btn danger" id="cancel">Cancel</button>' : ''}
        </div>
        <p class="small faint" style="margin-top:14px">Updated ${esc(when(s.updated_at))}</p>
      </div>`));
    const again = document.getElementById('again');
    if (again) again.onclick = async () => {
      again.disabled = true;
      try { await dispatch(id); toast('Started again'); later(() => renderJob(id), 1500); } catch (e) { toast(e.message); again.disabled = false; }
    };
    const cancel = document.getElementById('cancel');
    if (cancel) cancel.onclick = async () => {
      if (!confirm('Cancel this takeoff?')) return;
      cancel.disabled = true;
      try { await gh(repoPath() + '/actions/runs/' + run.id + '/cancel', { method: 'POST' }); toast('Cancelling'); } catch (e) { toast(e.message); cancel.disabled = false; }
    };
  }

  function bars(obj) {
    const rows = Object.entries(obj || {}).filter(([, v]) => typeof v === 'number');
    if (!rows.length) return '<div class="muted small">Nothing to show.</div>';
    rows.sort((a, b) => b[1] - a[1]);
    const max = Math.max(...rows.map((r) => r[1]), 1);
    return `<div class="bars">${rows.map(([k, v]) => `<div class="brow"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="t"><i style="width:${(100 * v / max).toFixed(1)}%"></i></span><span class="v">${fmtNum(v)}</span></div>`).join('')}</div>`;
  }
  async function renderResult(id, s) {
    const box = document.getElementById('job');
    let r;
    try { r = await readFile(id, 'result.json'); } catch (e) { box.replaceChildren(h(`<div class="note bad">${esc(e.message)}</div>`)); return; }
    if (!document.getElementById('job')) return;
    const t = r.totals || {};
    const v = r.verdict;
    const vcls = !v || v.send == null ? 'none' : (v.send ? 'send' : 'hold');
    const vtitle = !v || v.send == null ? 'No verdict yet' : (v.send ? 'Send' : 'Don\'t send');
    const vicon = !v || v.send == null ? '?' : (v.send ? '&#10003;' : '!');
    const blocking = (r.flags && r.flags.by_severity && r.flags.by_severity.changes_count) || 0;
    const ext = (n) => { const m = String(n).toLowerCase().match(/\.(xlsx|pdf|pptx)$/); return m ? m[1] : 'other'; };
    box.replaceChildren(h(`
      <div>
        <div class="row between wrap"><span class="chip done">Done</span>${r.dry_run ? '<span class="chip dry">Dry run, sample numbers</span>' : ''}</div>
        <h1 style="margin-top:12px">${esc(r.name || s.name || id)}</h1>
        <p class="sub">Finished ${esc(when(s.finished_at))}${s.started_at ? ', took ' + esc(dur(s.started_at, s.finished_at)) : ''}.</p>
        ${r.note ? `<div class="note" style="margin-bottom:18px"><b>Scope note:</b> ${esc(r.note)}</div>` : ''}
        <div class="verdict ${vcls}">
          <div class="vi">${vicon}</div>
          <div class="grow"><div class="vt">${vtitle}</div><div class="muted">${esc(v && v.headline ? v.headline : 'The independent check did not write a verdict. Read the review summary before sending.')}</div>
          ${v && v.problems && v.problems.length ? `<ul>${v.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</div>
        </div>
        <div class="stats">
          <div class="stat"><div class="n">${t.windows != null ? fmtNum(t.windows) : '...'}</div><div class="l">Windows</div></div>
          <div class="stat"><div class="n">${t.patio_doors != null ? fmtNum(t.patio_doors) : '...'}</div><div class="l">Patio doors</div></div>
          <div class="stat"><div class="n">${fmtNum(blocking)}</div><div class="l">Flags that change the count</div></div>
        </div>
        <div class="card"><h2>Downloads</h2><div class="files">${(r.files || []).map((f, i) => `
          <button class="file" data-i="${i}"><span class="fi ${ext(f.name)}">${ext(f.name) === 'other' ? 'WEB' : ext(f.name).toUpperCase()}</span>
          <span class="grow"><span class="fl">${esc(f.label)}</span><span class="fs" style="display:block">${esc(f.kind)} · ${fmtBytes(f.size)}</span></span></button>`).join('') || '<div class="muted small">No files were saved.</div>'}</div></div>
        <div class="two">
          <div class="card"><h2>Windows by type</h2>${bars(t.by_type)}</div>
          <div class="card"><h2>Windows by building</h2>${bars(t.by_building)}</div>
        </div>
        ${t.patio_doors_by_type && Object.keys(t.patio_doors_by_type).length ? `<div class="card" style="margin-top:18px"><h2>Patio doors by type</h2>${bars(t.patio_doors_by_type)}</div>` : ''}
        ${r.flags && r.flags.top && r.flags.top.length ? `<div class="card" style="margin-top:18px"><h2>Flags to look at first</h2><ul class="flags">${r.flags.top.map((f) => `<li><span class="sev ${esc(f.severity)}">${f.severity === 'changes_count' ? 'COUNT' : 'TYPE'}</span><span>${esc(f.title)}</span></li>`).join('')}</ul>
          ${r.flags.total > r.flags.top.length ? `<div class="small muted" style="margin-top:8px">${fmtNum(r.flags.total)} flags in all. The flags report has every one.</div>` : ''}</div>` : ''}
        ${r.audit && r.audit.areas ? `<div class="card" style="margin-top:18px"><h2>Blind recount</h2><div>${fmtNum(r.audit.agree)} of ${fmtNum(r.audit.areas)} random areas agree.</div></div>` : ''}
        <div class="row wrap" style="margin-top:18px">${s.run_url ? `<a class="btn" href="${esc(s.run_url)}" target="_blank" rel="noopener">Open the run on GitHub</a>` : ''}</div>
      </div>`));
    box.querySelectorAll('.file').forEach((b) => { b.onclick = () => download(id, r.files[+b.dataset.i], b); });
  }
  async function download(id, f, el) {
    el.classList.add('busy');
    const label = el.querySelector('.fs');
    const old = label.textContent;
    label.textContent = 'Downloading...';
    try {
      let blob;
      if (f.parts && f.parts.length) {
        const pieces = [];
        for (let i = 0; i < f.parts.length; i++) {
          label.textContent = 'Downloading part ' + (i + 1) + ' of ' + f.parts.length;
          pieces.push(await readFile(id, f.parts[i], 'blob'));
        }
        blob = new Blob(pieces);
      } else {
        blob = await readFile(id, f.path, 'blob');
      }
      const types = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', md: 'text/markdown', html: 'text/html' };
      const e = (f.name.match(/\.([a-z]+)$/i) || ['', ''])[1].toLowerCase();
      const typed = new Blob([blob], { type: types[e] || 'application/octet-stream' });
      const url = URL.createObjectURL(typed);
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
      toast(e.message || 'The download failed');
    } finally { el.classList.remove('busy'); }
  }

  route();
})();
