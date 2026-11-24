'use strict';

const state = { models: [], runs: {}, servers: {}, cols: {}, task: '', mode: 'sequential', harnesses: [], batch: null, tasks: [], currentTasks: [] };
const taskTitle = (id) => state.tasks.find((t) => t.id === id)?.title || id;
const harnessName = (id) => state.harnesses.find((h) => h.id === id)?.short || id;
const ACTIVE = ['queued', 'waiting', 'running'];
const TERMINAL = ['done', 'error', 'stopped'];
const HAIKU_PRICING = { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 };

// ------------------------------------------------------------------ formatting
const fmtClock = (ms) => {
  if (ms == null || ms < 0) return '–';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtDur = (ms) => {
  if (ms == null) return '–';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const fmtUsd = (v) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${(v || 0).toFixed(4)}`);
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (col, sel) => col.el.querySelector(sel);

const modelById = (id) => state.models.find((m) => m.id === id);
const elapsed = (r) => (r?.startedAt ? (r.endedAt || Date.now()) - r.startedAt : null);
const priceAt = (p, t) => ((t.input || 0) * p.input + (t.cacheWrite || 0) * p.cacheWrite + (t.cacheRead || 0) * p.cacheRead + (t.output || 0) * p.output) / 1e6;

// ------------------------------------------------------------------ columns
function buildColumns(models) {
  const grid = document.getElementById('grid');
  const tpl = document.getElementById('colTpl');
  grid.innerHTML = '';
  for (const m of models) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = m.id;
    el.querySelector('.name').textContent = m.name;
    el.querySelector('.vendor').textContent = m.vendor;
    const chips = el.querySelector('.chips');
    const chip = (t, cls = '') => chips.insertAdjacentHTML('beforeend', `<span class="chip ${cls}">${esc(t)}</span>`);
    if (m.kind === 'local') {
      chip('local · llama.cpp', 'local'); chip(m.quant); chip(m.params); chip(`${Math.round(m.ctx / 1024)}k ctx`);
      chip(`reasoning: ${m.reasoningEffort || 'template default'}`);
    } else {
      chip('Anthropic API', 'api'); chip(m.model); chip(`$${m.pricing.input} in · $${m.pricing.output} out / MTok`);
      chip('reasoning: Claude Code default');
    }
    const url = `http://localhost:${m.sitePort}/`;
    el.querySelector('.url-text').textContent = url;
    el.querySelector('.open-btn').href = url;
    const iframe = el.querySelector('iframe');
    iframe.src = url;
    grid.appendChild(el);

    const col = { el, iframe, url, desktop: false, lastReload: 0, feedLen: -1 };
    state.cols[m.id] = col;
    el.querySelector('.reload-btn').onclick = () => reloadFrame(m.id, true);
    el.querySelector('.col-run').onclick = () => startRun([m.id]);
    el.querySelector('.viewport-btn').onclick = (e) => {
      col.desktop = !col.desktop;
      e.currentTarget.classList.toggle('on', col.desktop);
      layoutFrame(m.id);
    };
    new ResizeObserver(() => layoutFrame(m.id)).observe(el);
  }
}

function layoutFrame(id) {
  const col = state.cols[id];
  const vp = col.iframe.parentElement;
  if (!col.desktop) {
    Object.assign(col.iframe.style, { width: '100%', height: '100%', transform: '' });
    return;
  }
  const scale = vp.clientWidth / 1280;
  Object.assign(col.iframe.style, { width: '1280px', height: `${vp.clientHeight / scale}px`, transform: `scale(${scale})` });
}

function reloadFrame(id, force = false) {
  const col = state.cols[id];
  const now = Date.now();
  if (!force && now - col.lastReload < 500) {
    clearTimeout(col.reloadTimer);
    col.reloadTimer = setTimeout(() => reloadFrame(id, true), 500);
    return;
  }
  col.lastReload = now;
  col.iframe.src = `${col.url}?v=${now}`;
}

// ------------------------------------------------------------------ metrics
const STATUS_LABEL = { idle: 'Idle', queued: 'Queued', waiting: 'Waiting', running: 'Running', done: 'Completed', error: 'Failed', stopped: 'Stopped' };
const KIND_ICON = { tool: '⏺', think: '✻', text: '›', error: '✖', warn: '!', done: '✔', info: '·' };

// Wall time split into: waiting for the model (request → first token),
// generating (first → last token) and everything else (tool calls, Claude Code itself).
function timeSplit(r) {
  const wall = elapsed(r) || 0;
  const nowRel = wall;
  let wait = 0; let gen = 0;
  const segs = [];
  for (const s of r.timeline || []) {
    const waitEnd = s.first ?? s.end ?? nowRel;
    wait += Math.max(0, waitEnd - s.req);
    segs.push(['wait', s.req, waitEnd]);
    if (s.first != null) {
      const genEnd = s.end ?? (r.endedAt ? s.first : nowRel);
      gen += Math.max(0, genEnd - s.first);
      segs.push(['gen', s.first, genEnd]);
    }
  }
  return { wall, wait, gen, other: Math.max(0, wall - wait - gen), segs };
}

function render(id) {
  const m = modelById(id);
  const r = state.runs[id];
  const s = state.servers[id] || {};
  const col = state.cols[id];
  if (!m || !r || !col) return;
  const el = col.el;
  el.classList.remove('running', 'done', 'error');
  if (['running', 'done', 'error'].includes(r.status)) el.classList.add(r.status);

  // status line
  const pill = $(col, '.pill');
  pill.className = `pill ${r.status}`;
  pill.textContent = STATUS_LABEL[r.status] || r.status;
  let current = '';
  if (r.status === 'running') current = r.current || (r.firstTokenAt ? 'Working…' : 'Starting Claude Code…');
  else if (r.status === 'done') current = short((r.resultText || 'Finished').replace(/\s+/g, ' '), 140);
  else if (r.status === 'error') current = r.error || 'Failed';
  else if (r.status === 'idle') current = 'Ready';
  else current = r.detail || '';
  $(col, '.m-current').textContent = current;
  $(col, '.m-current').title = current;
  renderThink(col, r);
  const srv = $(col, '.server');
  if (m.kind === 'local') {
    srv.className = `server ${s.status}`;
    srv.textContent = `llama-server :${m.llamaPort} · ${s.status}${s.status === 'ready' && s.loadMs ? ` (${fmtDur(s.loadMs)} load)` : ''}`;
    srv.title = s.detail || '';
  } else {
    srv.className = 'server ready';
    srv.textContent = 'api.anthropic.com';
  }

  // tiles
  $(col, '.v-time').textContent = fmtClock(elapsed(r));
  $(col, '.n-time').textContent = r.status === 'done' && r.durationMs ? `Claude Code: ${fmtDur(r.durationMs)}` : r.status === 'running' ? 'wall clock, live' : r.status === 'queued' ? 'not started' : '';
  const t = r.tokens || {};
  if (m.kind === 'local') {
    $(col, '.v-cost').textContent = '$0.00';
    const eq = priceAt(HAIKU_PRICING, t);
    $(col, '.n-cost').textContent = r.startedAt ? `local · ≈${fmtUsd(eq)} at Haiku 5.5 rates` : 'local · no API cost';
  } else {
    $(col, '.v-cost').textContent = r.startedAt ? fmtUsd(r.costUsd || 0) : '–';
    $(col, '.n-cost').textContent = r.costFinal ? 'Claude Code total_cost_usd' : r.startedAt ? 'live estimate' : `$${m.pricing.input} / $${m.pricing.output} per MTok`;
  }
  $(col, '.v-tps').textContent = r.genMs > 500 ? ((r.streamOut || 0) / (r.genMs / 1000)).toFixed(1) : '–';
  $(col, '.v-ttft').textContent = r.firstTokenAt && r.startedAt ? fmtDur(r.firstTokenAt - r.startedAt) : '–';

  renderTimeline(col, r);

  // tokens
  const rows = [
    ['Input', t.input, '#58a6ff', 'Uncached prompt tokens'],
    ['Cache write', t.cacheWrite, '#a371f7', 'Prompt tokens written to the prompt cache'],
    ['Cache read', t.cacheRead, '#39c5cf', 'Prompt tokens served from cache (KV-cache reuse on llama.cpp)'],
    ['Output', t.output, '#3fb950', 'Generated tokens, including reasoning'],
    ['↳ thinking', r.thinkTokens, '#8b96a5', 'Reasoning tokens (estimated while running)'],
  ];
  const max = Math.max(1, ...rows.map((x) => x[1] || 0));
  $(col, '.tok-rows').innerHTML = rows.map(([k, v, c, tip]) => `
    <div class="tok-row" title="${esc(tip)}"><span>${k}</span>
      <span class="bar"><i style="width:${((v || 0) / max) * 100}%;background:${c}"></i></span>
      <b>${fmtTok(v || 0)}</b></div>`).join('');
  $(col, '.ctx').textContent = r.contextPeak ? `peak context ${fmtTok(r.contextPeak)}` : '';

  // work
  const toolTotal = Object.values(r.toolCounts || {}).reduce((a, b) => a + b, 0);
  const byTool = Object.entries(r.toolCounts || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const files = r.siteFiles || [];
  const kv = (k, v, cls = '') => `<div class="kv ${cls}"><span>${k}</span><b title="${esc(v)}">${esc(v)}</b></div>`;
  $(col, '.work').innerHTML = [
    kv('API requests', String(r.turns || 0)),
    r.turnsReported != null ? kv('Agent turns', String(r.turnsReported)) : '',
    kv('Tool calls', toolTotal ? `${toolTotal} (${byTool})` : '0'),
    kv('Tool errors', String(r.toolErrors || 0), r.toolErrors ? 'err' : ''),
    ...files.slice(0, 6).map((f) => `<div class="file"><span>${esc(f.name)}</span><span>${f.lines != null ? `${f.lines} ln · ` : ''}${fmtBytes(f.bytes)}</span></div>`),
  ].join('');
  $(col, '.work-sub').textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''} · ${fmtBytes(files.reduce((a, f) => a + f.bytes, 0))}` : '';

  // activity feed (newest at the bottom)
  const act = r.activity || [];
  $(col, '.act-sub').textContent = act.length ? `${act.length} steps` : '';
  if (col.feedLen !== act.length || col.feedRun !== r.startedAt) {
    const feed = $(col, '.feed');
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30;
    feed.innerHTML = act.slice(-40).map((a) => `
      <li class="${a.kind}"><span class="t">${fmtClock(a.t).replace(/\.\d$/, '')}</span><span class="k">${KIND_ICON[a.kind] || '·'}</span><span class="x" title="${esc(a.text)}">${esc(a.text)}</span></li>`).join('');
    if (stick || col.feedLen === -1) feed.scrollTop = feed.scrollHeight;
    col.feedLen = act.length;
    col.feedRun = r.startedAt;
  }

  // harness tag
  const tag = $(col, '.harness-tag');
  tag.textContent = r.startedAt || ACTIVE.includes(r.status) ? `${taskTitle(r.task)} · ${harnessName(r.harness)}${state.batch?.repeats > 1 ? ` · #${r.repeat}` : ''}` : '';
  tag.className = `harness-tag ${r.harness === 'neutral' ? 'neutral' : ''}`;

  renderGrade(col, r);

  // controls / header dot
  el.querySelector('.col-run').disabled = ACTIVE.includes(r.status);
  el.querySelector('.dot').style.background = { running: 'var(--yellow)', done: 'var(--green)', error: 'var(--red)' }[r.status]
    || (m.kind === 'local' && s.status !== 'ready' ? 'var(--yellow)' : 'var(--dim)');
}

// Autograder strip: one square per check, green = pass.
function renderGrade(col, r) {
  const g = r.grade;
  const score = $(col, '.grade-score');
  const cells = $(col, '.grade-cells');
  const failed = $(col, '.grade-failed');
  const sub = $(col, '.grade-sub');
  if (r.grading) { score.textContent = '…'; score.className = 'grade-score'; sub.textContent = 'grading in headless Chromium'; cells.innerHTML = ''; failed.textContent = ''; return; }
  if (!g) {
    score.textContent = '–'; score.className = 'grade-score'; cells.innerHTML = ''; failed.textContent = '';
    sub.textContent = r.startedAt && TERMINAL.includes(r.status) ? 'not graded' : 'runs when the model finishes';
    return;
  }
  if (g.error) { score.textContent = 'err'; score.className = 'grade-score part'; sub.textContent = ''; cells.innerHTML = ''; failed.textContent = g.error; return; }
  score.textContent = `${g.passed}/${g.total}`;
  score.className = `grade-score ${g.passed === g.total ? 'full' : 'part'}`;
  sub.textContent = `${Math.round(g.score * 100)}% of requirements`;
  cells.innerHTML = Object.entries(g.checks || {}).map(([id, ok]) => `<i class="${ok ? 'p' : 'f'}" title="${esc(id)}: ${ok ? 'pass' : 'fail'}"></i>`).join('');
  failed.textContent = g.failed?.length ? `✗ ${g.failed.map((f) => f.label + (f.detail ? ` (${f.detail})` : '')).join(' · ')}` : '';
  failed.title = failed.textContent;
}

// Tail of the live reasoning text, so a long think reads as progress, not a hang.
function renderThink(col, r) {
  const box = $(col, '.m-think');
  const on = r.status === 'running' && r.thinkStart;
  box.classList.toggle('show', !!on);
  if (!on) return;
  const secs = Math.round((Date.now() - r.thinkStart) / 1000);
  const tail = (r.thinkTail || '').replace(/\s+/g, ' ').trim() || '(reasoning text not returned by this API)';
  // direction: rtl keeps the newest text visible; the LRM marks stop punctuation from jumping
  box.innerHTML = `&lrm;${esc(tail)} <b>· thinking ${secs}s</b>&lrm;`;
}

function renderTimeline(col, r) {
  const tl = $(col, '.timeline');
  const sp = timeSplit(r);
  tl.classList.toggle('empty', !r.startedAt);
  if (!r.startedAt || !sp.wall) { tl.innerHTML = ''; $(col, '.split').innerHTML = ''; return; }
  tl.innerHTML = sp.segs.map(([k, a, b]) => {
    const left = (a / sp.wall) * 100;
    const w = Math.max(0.4, ((b - a) / sp.wall) * 100);
    return `<i class="${k}" style="left:${left}%;width:${w}%"></i>`;
  }).join('');
  const pct = (x) => `${Math.round((x / sp.wall) * 100)}%`;
  $(col, '.split').innerHTML = `
    <span>waiting <b>${fmtDur(sp.wait)}</b> ${pct(sp.wait)}</span>
    <span>generating <b>${fmtDur(sp.gen)}</b> ${pct(sp.gen)}</span>
    <span>tools + harness <b>${fmtDur(sp.other)}</b> ${pct(sp.other)}</span>`;
}

// Rankings stay hidden until every model in the current job has finished and
// been graded. Order: autograder score first, then time to complete.
function renderCompare() {
  const all = state.models.map((m) => ({ m, r: state.runs[m.id] }));
  const sameJob = all.every(({ r }) => r && r.batchId === all[0].r?.batchId && r.task === all[0].r?.task && r.harness === all[0].r?.harness && r.repeat === all[0].r?.repeat);
  const finished = sameJob && all.every(({ r }) => r?.startedAt && TERMINAL.includes(r.status) && !r.grading);
  const banner = document.getElementById('banner');
  for (const { m } of all) {
    state.cols[m.id].el.querySelector('.place').textContent = '';
    const box = state.cols[m.id].el.querySelector('.compare');
    box.classList.remove('show');
    box.innerHTML = '';
  }
  const b = state.batch;
  const progress = b && b.status === 'running'
    ? `<b>Job ${b.index + 1} of ${b.jobs.length}</b> · ${esc(taskTitle(b.jobs[b.index]?.task))} · ${esc(harnessName(b.jobs[b.index]?.harness))}${b.repeats > 1 ? `, repeat ${b.jobs[b.index]?.repeat} of ${b.repeats}` : ''}. `
    : '';
  if (!finished) {
    const active = all.filter(({ r }) => ACTIVE.includes(r?.status) || r?.grading);
    if (active.length || progress) {
      const sched = state.mode === 'parallel'
        ? 'All three run at the same time; the two local models share the GPU.'
        : 'Haiku runs alongside the first local model; the second local model starts when the first finishes.';
      banner.innerHTML = `${progress}${esc(sched)} Rankings appear once all three finish and are graded.`;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
    return;
  }
  const score = (r) => (r.grade && !r.grade.error ? r.grade.score : -1);
  const done = all.filter(({ r }) => r.status === 'done')
    .sort((a, b2) => score(b2.r) - score(a.r) || elapsed(a.r) - elapsed(b2.r));
  const medals = ['🥇 1st', '🥈 2nd', '🥉 3rd'];
  const fastest = [...done].sort((a, b2) => elapsed(a.r) - elapsed(b2.r))[0];
  for (const { m, r } of all) {
    const col = state.cols[m.id];
    const box = col.el.querySelector('.compare');
    const i = done.findIndex((x) => x.m.id === m.id);
    if (i < 0) {
      col.el.querySelector('.place').textContent = 'did not finish';
      box.innerHTML = `<b>Did not finish</b> · ${esc(r.error || r.status)}${r.grade?.total ? ` · autograder ${r.grade.passed}/${r.grade.total}` : ''}`;
    } else {
      col.el.querySelector('.place').textContent = medals[i] || `${i + 1}th`;
      const t = elapsed(r);
      const rows = [`<span>autograder <b>${r.grade?.total ? `${r.grade.passed}/${r.grade.total}` : '–'}</b></span>`];
      if (fastest.m.id === m.id) rows.push('<span><b>fastest</b></span>');
      else rows.push(`<span><b>${(t / elapsed(fastest.r)).toFixed(1)}×</b> ${esc(fastest.m.name)}'s time</span>`);
      rows.push(`<span><b>${fmtTok(r.tokens?.output || 0)}</b> output tokens</span>`);
      rows.push(`<span><b>${m.kind === 'local' ? '$0.00' : fmtUsd(r.costUsd || 0)}</b> spent</span>`);
      box.innerHTML = `<b>${medals[i] || ''}</b> <small>(score, then time)</small><div class="rows">${rows.join('')}</div>`;
    }
    box.classList.add('show');
  }
  const h = `${taskTitle(all[0].r.task)} · ${harnessName(all[0].r.harness)}`;
  banner.innerHTML = `${progress}🏁 <b>${esc(h)}: all three finished.</b> ` + done.map(({ m, r }, i) => `${i + 1}. <b>${esc(m.name)}</b> ${r.grade?.total ? `${r.grade.passed}/${r.grade.total}` : ''} in ${fmtDur(elapsed(r))} (${m.kind === 'local' ? '$0.00 local' : fmtUsd(r.costUsd || 0)})`).join(' · ')
    + ' · <a href="/compare.html">all results →</a>';
  banner.classList.add('show');
}

function renderAll() {
  for (const m of state.models) render(m.id);
  renderCompare();
  const busy = Object.values(state.runs).some((r) => ACTIVE.includes(r.status) || r.grading) || state.batch?.status === 'running';
  document.getElementById('run').disabled = busy;
  document.getElementById('stop').disabled = !busy;
}

// ------------------------------------------------------------------ wiring
function setTask(task) {
  state.task = task;
  const ta = document.getElementById('task');
  if (document.activeElement !== ta) ta.value = task;
  document.getElementById('taskPreview').textContent = task.replace(/\s+/g, ' ');
}

// Task picker: "all" runs every task with its own prompt; one task shows its
// prompt in the box, where it can be edited (the task's autograder still applies).
function buildTaskSelect() {
  const sel = document.getElementById('taskSel');
  sel.innerHTML = `<option value="all">Task: all ${state.tasks.length}</option>`
    + state.tasks.map((t) => `<option value="${esc(t.id)}">Task: ${esc(t.title)} (${esc(t.level)})</option>`).join('');
  sel.value = state.currentTasks.length === 1 ? state.currentTasks[0] : 'all';
  sel.onchange = showSelectedTask;
  showSelectedTask();
}
function showSelectedTask() {
  const v = document.getElementById('taskSel').value;
  const ta = document.getElementById('task');
  if (v === 'all') {
    ta.readOnly = true;
    setTask(state.tasks.map((t) => `${t.title} (${t.level}): ${t.skill}`).join('\n'));
  } else {
    ta.readOnly = false;
    setTask(state.tasks.find((t) => t.id === v)?.prompt || '');
  }
  document.getElementById('run').textContent = v === 'all' ? `▶ Run all ${state.tasks.length} tasks` : '▶ Run all three';
}

function connect() {
  const es = new EventSource('/events');
  es.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'snapshot') {
      if (!state.models.length) buildColumns(data.models);
      const first = !state.tasks.length;
      Object.assign(state, { models: data.models, runs: data.runs, servers: data.servers, mode: data.mode, harnesses: data.harnesses || [], batch: data.batch, tasks: data.tasks || [], currentTasks: data.currentTasks || [] });
      if (first) buildTaskSelect();
      document.getElementById('mode').value = data.mode;
      renderAll();
    } else if (data.type === 'state') {
      state.runs[data.id] = data.run;
      state.servers[data.id] = data.server;
      if (data.mode) state.mode = data.mode;
      renderAll();
    } else if (data.type === 'batch') {
      state.batch = data.batch;
      renderAll();
    } else if (data.type === 'clear') {
      state.cols[data.id].feedLen = -1;
      reloadFrame(data.id, true);
    } else if (data.type === 'reload') {
      reloadFrame(data.id);
    }
  };
}

async function startRun(only) {
  const v = document.getElementById('taskSel').value;
  const tasks = v === 'all' ? state.tasks.map((t) => t.id) : [v];
  const typed = document.getElementById('task').value.trim();
  const original = state.tasks.find((t) => t.id === v)?.prompt;
  const prompt = v !== 'all' && typed && typed !== original ? typed : null;
  const mode = document.getElementById('mode').value;
  const h = document.getElementById('harness').value;
  const harnesses = h === 'both' ? ['claude-code', 'neutral'] : [h];
  const repeats = Math.max(1, Math.min(10, +document.getElementById('repeats').value || 1));
  state.mode = mode;
  await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks, prompt, mode, only, harnesses, repeats }) });
  document.getElementById('taskBox').open = false;
}
document.getElementById('run').onclick = () => startRun(null);
document.getElementById('stop').onclick = () => fetch('/api/stop', { method: 'POST' });
document.getElementById('task').addEventListener('input', (e) => setTask(e.target.value));

// live clocks + timeline between server updates
setInterval(() => {
  for (const m of state.models) {
    const r = state.runs[m.id];
    if (r?.status !== 'running') continue;
    const col = state.cols[m.id];
    $(col, '.v-time').textContent = fmtClock(elapsed(r));
    renderTimeline(col, r);
    renderThink(col, r);
  }
}, 200);

connect();
