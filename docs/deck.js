/* global window, document */
'use strict';

const D = window.BAKEOFF;
const MODEL_ORDER = ['inkling', 'qwen', 'haiku'];
const HARNESS_ORDER = ['claude-code', 'neutral'];
const TASK_ORDER = ['pomodoro', 'spreadsheet', 'datatable', 'bugfix', 'markdown'];
const COLOR = { inkling: 'var(--m-inkling)', qwen: 'var(--m-qwen)', haiku: 'var(--m-haiku)' };
const HNAME = { 'claude-code': 'Claude Code', neutral: 'Neutral loop' };
const model = (id) => D.models.find((m) => m.id === id);
const task = (id) => D.tasks.find((t) => t.id === id);
const run = (t, m, h) => D.runs.find((r) => r.task === t && r.model === m && r.harness === h);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); if (!v.length) return null; const k = Math.floor(v.length / 2); return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2; };
const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
const fmtDur = (ms) => {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
const fmtUsd = (v) => (v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
const key = (m) => `<i style="background:${COLOR[m]}"></i>`;

// ------------------------------------------------------------------ derived numbers
const totals = {};
for (const m of MODEL_ORDER) for (const h of HARNESS_ORDER) {
  const rs = TASK_ORDER.map((t) => run(t, m, h)).filter(Boolean);
  totals[`${m}|${h}`] = {
    time: sum(rs.map((r) => r.wallMs)), cost: sum(rs.map((r) => r.costUsd)),
    score: rs.reduce((a, r) => a + r.passed / r.total, 0) / rs.length,
    perfect: rs.filter((r) => r.passed === r.total).length, n: rs.length,
    tps: median(rs.map((r) => r.tokPerSec)), ttft: median(rs.map((r) => r.ttftMs)),
  };
}
const T = (m, h) => totals[`${m}|${h}`];
const perfectRuns = D.runs.filter((r) => r.passed === r.total).length;
const xHaiku = (m, h) => T(m, h).time / T('haiku', h).time;
const ratio = (m) => T(m, 'neutral').time / T(m, 'claude-code').time;

// ------------------------------------------------------------------ title + tl;dr
$('titleKeys').innerHTML = MODEL_ORDER.map((m) => `<span class="key">${key(m)}${esc(model(m).name)} <small style="color:var(--muted)">· ${model(m).kind === 'local' ? 'local' : 'Bedrock'}</small></span>`).join('');

$('tldrTiles').innerHTML = [
  { label: 'Runs that passed every check', value: `${perfectRuns} / ${D.runs.length}`, foot: '3 models × 2 harnesses × 5 tasks' },
  { label: `${key('haiku')}Haiku 5.5, all five tasks`, value: fmtDur(T('haiku', 'claude-code').time), foot: `in Claude Code · ${fmtDur(T('haiku', 'neutral').time)} in the neutral loop` },
  { label: `${key('inkling')}Inkling · ${key('qwen')}Qwen vs Haiku`, value: `${xHaiku('inkling', 'claude-code').toFixed(1)}× · ${xHaiku('qwen', 'claude-code').toFixed(1)}×`, foot: 'total time as a multiple of Haiku’s, in Claude Code' },
  { label: 'Haiku API cost, all five tasks', value: fmtUsd(T('haiku', 'claude-code').cost), foot: `Claude Code · ${fmtUsd(T('haiku', 'neutral').cost)} neutral · local runs $0 API` },
].map((x) => `<div class="tile"><div class="label">${x.label}</div><div class="value">${x.value}</div><div class="foot">${x.foot}</div></div>`).join('');
const K = {
  inkCC: `${xHaiku('inkling', 'claude-code').toFixed(1)}×`, qwenCC: `${xHaiku('qwen', 'claude-code').toFixed(1)}×`,
  haikuRatio: `${ratio('haiku').toFixed(2)}×`, qwenRatio: `${ratio('qwen').toFixed(2)}×`, inkRatio: `${ratio('inkling').toFixed(2)}×`,
};
document.querySelectorAll('[data-k]').forEach((el) => { el.textContent = K[el.dataset.k] ?? ''; });

// ------------------------------------------------------------------ models + machine
document.querySelectorAll('.model-card').forEach((c) => { c.querySelector('.sw').style.background = COLOR[c.dataset.model]; });
$('speedTiles').innerHTML = MODEL_ORDER.map((m) => {
  const t = T(m, 'claude-code');
  const foot = m === 'haiku' ? 'Anthropic’s servers on Bedrock; streaming rate seen by Claude Code' : `${model(m).quant} on llama.cpp, this Mac · first token ${fmtDur(t.ttft)} (median)`;
  return `<div class="tile"><div class="label">${key(m)}${esc(model(m).name)}</div><div class="value">${Math.round(t.tps)} <small style="font-size:15px;color:var(--muted)">tok/s</small></div><div class="foot">${foot}</div></div>`;
}).join('');

// ------------------------------------------------------------------ tasks
const TRAPS = {
  pomodoro: ['countdown at real speed (fake-clock check)', 'Space toggles start/pause', 'a session counter that survives a reload', 'a dark UI that fits at 360 and 1440 px'],
  spreadsheet: ['its own parser (no eval)', 'precedence, unary minus, ranges', 'recalculating dependent cells', '#CIRC! in every cell of a cycle; #REF! #DIV/0! #ERR!', 'no floating-point noise (0.1+0.2)'],
  datatable: ['137 seeded records with traps', 'orders 2–150: text sorting fails', 'case-only duplicate names; ties by id in both directions', 'en-dash status line; URL-hash restore'],
  bugfix: ['seeded app with 7 reported bugs', 'cents dropped, wrong item deleted, storage key typo, …', '4 regression checks: don’t break what works', 'the untouched seed scores 8/15'],
  markdown: ['its own parser (no library)', 'headings on consecutive lines', 'fenced code shown verbatim', 'link-scheme allow-list; raw HTML never runs', 'autosave + Copy HTML'],
};
$('taskGrid').innerHTML = TASK_ORDER.map((id) => {
  const t = task(id);
  return `<article class="card task">
    <h3>${esc(t.title)}</h3>
    <div class="meta"><span class="pill">${esc(t.level)}</span><span class="pill">${t.checks.length} checks</span>${t.seeded ? '<span class="pill">seeded files</span>' : ''}</div>
    <p>${esc(t.skill)}</p>
    <ul>${(TRAPS[id] || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <details><summary>Full prompt</summary><pre>${esc(t.prompt)}</pre></details>
  </article>`;
}).join('');

const totalChecks = sum(D.tasks.map((t) => t.checks.length));
$('graderStats').innerHTML = [
  [D.tasks.length, 'graders'], [totalChecks, 'checks in total'], [43, 'self-test cases, all passing'], [5, 'false negatives fixed'],
].map(([n, s]) => `<div><b>${n}</b><span>${s}</span></div>`).join('');

// ------------------------------------------------------------------ correctness matrix
{
  const head = `<thead><tr><th style="text-align:left">Model · harness</th>${TASK_ORDER.map((id) => `<th>${esc(task(id).title)}<small>${esc(task(id).level)} · ${task(id).checks.length} checks</small></th>`).join('')}<th>Mean score</th><th>Total time</th><th>Cost</th></tr></thead>`;
  const rows = [];
  for (const h of HARNESS_ORDER) for (const m of MODEL_ORDER) {
    const cells = TASK_ORDER.map((id) => {
      const r = run(id, m, h);
      if (!r) return '<td>–</td>';
      const full = r.passed === r.total;
      const miss = r.failed.map((f) => f.label).join('; ');
      return `<td><span class="score ${full ? 'ok' : 'part'}">${full ? '✓' : '◐'} ${r.passed}/${r.total}</span><span class="t">${fmtDur(r.wallMs)}</span>${miss ? `<span class="miss">✗ ${esc(miss)}</span>` : ''}</td>`;
    }).join('');
    const t = T(m, h);
    rows.push(`<tr class="${m === MODEL_ORDER[0] && h !== HARNESS_ORDER[0] ? 'harness-split' : ''}"><td class="who"><span class="key" style="padding:0;border:0;background:none">${key(m)}${esc(model(m).name)}</span><span class="h">${HNAME[h]}</span></td>${cells}<td class="total">${(t.score * 100).toFixed(1)}%</td><td class="total">${fmtDur(t.time)}</td><td class="total">${model(m).kind === 'local' ? '$0' : fmtUsd(t.cost)}</td></tr>`);
  }
  $('matrix').innerHTML = `${head}<tbody>${rows.join('')}</tbody>`;
  $('matrixNote').textContent = 'Both misses are confirmed bugs in the code itself. Qwen\'s spreadsheet skips repainting a formula cell that was focused but not changed. Its data explorer implements a descending sort as cmp(b, a), which also reverses the id tie-break.';
}

// ------------------------------------------------------------------ tooltip
const tip = $('tooltip');
function showTip(e, html) {
  tip.innerHTML = html;
  tip.classList.add('show');
  const pad = 14;
  let x = e.clientX + pad; let y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const hideTip = () => tip.classList.remove('show');
function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip));
    el.addEventListener('mouseleave', hideTip);
  });
}

// Bar with a 4px rounded data-end and a square baseline. dir: +1 grows right, -1 left.
function barPath(x0, x1, y, h, r = 4) {
  const w = Math.abs(x1 - x0);
  const rr = Math.min(r, h / 2, w);
  if (x1 >= x0) return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

// ------------------------------------------------------------------ time charts (small multiples, log x)
{
  $('timeLegend').innerHTML = MODEL_ORDER.map((m) => `<span>${key(m)}${esc(model(m).name)}</span>`).join('');
  const W = 560; const L = 128; const R = 14; const TOP = 6; const B = 26;
  const BAR = 9; const GAP = 2; const BAND = 3 * BAR + 2 * GAP + 18;
  const H = TOP + TASK_ORDER.length * BAND + B;
  const dMin = 8_000; const dMax = 3_600_000;
  const x = (ms) => L + (Math.log(Math.max(ms, dMin)) - Math.log(dMin)) / (Math.log(dMax) - Math.log(dMin)) * (W - L - R);
  const ticks = [[10_000, '10s'], [30_000, '30s'], [60_000, '1m'], [180_000, '3m'], [600_000, '10m'], [1_800_000, '30m'], [3_600_000, '1h']];
  const panel = (h) => {
    let g = '';
    for (const [v, lab] of ticks) g += `<line class="gridline" x1="${x(v)}" x2="${x(v)}" y1="${TOP}" y2="${H - B}"/><text x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${lab}</text>`;
    g += `<line class="baseline" x1="${L}" x2="${L}" y1="${TOP}" y2="${H - B}"/>`;
    TASK_ORDER.forEach((id, i) => {
      const y0 = TOP + i * BAND + 9;
      g += `<text class="lbl" x="${L - 10}" y="${y0 + (3 * BAR + 2 * GAP) / 2 + 4}" text-anchor="end">${esc(task(id).title)}</text>`;
      MODEL_ORDER.forEach((m, j) => {
        const r = run(id, m, h);
        if (!r) return;
        const y = y0 + j * (BAR + GAP);
        const tipHtml = `<span class="tt-k" style="background:${COLOR[m]}"></span><b>${esc(model(m).name)}</b> · ${HNAME[h]}<br>${esc(task(id).title)}: <b>${fmtDur(r.wallMs)}</b><small>${r.passed}/${r.total} checks · ${r.apiRequests} API calls · ${Math.round((r.outputTokens || 0) / 1000)}k output tokens</small>`;
        g += `<rect class="hit" x="${L}" y="${y - 1}" width="${W - L - R}" height="${BAR + GAP}" data-tip="${esc(tipHtml)}"/>`;
        g += `<path class="bar" d="${barPath(L, x(r.wallMs), y, BAR)}" fill="${COLOR[m]}" pointer-events="none"/>`;
      });
    });
    return `<figure class="card chart-card"><p class="panel-title">${HNAME[h]}</p><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Time per task in ${HNAME[h]}, log scale">${g}</svg></figure>`;
  };
  $('timeCharts').innerHTML = HARNESS_ORDER.map(panel).join('');
  bindTips($('timeCharts'));
}

// ------------------------------------------------------------------ harness effect: ratio bars (log, baseline 1×)
{
  const W = 520; const L = 116; const R = 60; const TOP = 26; const B = 26; const BAR = 18; const BAND = 46;
  const H = TOP + MODEL_ORDER.length * BAND + B;
  const lo = 0.25; const hi = 4;
  const x = (v) => L + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * (W - L - R);
  let g = '';
  for (const [v, lab] of [[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']]) {
    g += `<line class="${v === 1 ? 'baseline' : 'gridline'}" x1="${x(v)}" x2="${x(v)}" y1="${TOP - 6}" y2="${H - B}"/><text x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${lab}</text>`;
  }
  g += `<text x="${x(1) - 8}" y="12" text-anchor="end">← faster in the neutral loop</text><text x="${x(1) + 8}" y="12">slower →</text>`;
  MODEL_ORDER.forEach((m, i) => {
    const v = ratio(m);
    const y = TOP + i * BAND + (BAND - BAR) / 2;
    const tipHtml = `<span class="tt-k" style="background:${COLOR[m]}"></span><b>${esc(model(m).name)}</b><br>Claude Code ${fmtDur(T(m, 'claude-code').time)} → neutral ${fmtDur(T(m, 'neutral').time)}<small>${v.toFixed(2)}× the time</small>`;
    g += `<text class="lbl" x="${L - 10}" y="${y + BAR / 2 + 4}" text-anchor="end">${esc(model(m).name)}</text>`;
    g += `<rect class="hit" x="${L}" y="${y - 6}" width="${W - L - R + 40}" height="${BAR + 12}" data-tip="${esc(tipHtml)}"/>`;
    g += `<path class="bar" d="${barPath(x(1), x(v), y, BAR)}" fill="${COLOR[m]}" pointer-events="none"/>`;
    const tx = v < 1 ? x(v) - 6 : x(v) + 6;
    g += `<text class="val" x="${tx}" y="${y + BAR / 2 + 4}" text-anchor="${v < 1 ? 'end' : 'start'}">${v.toFixed(2)}×</text>`;
  });
  $('ratioChart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Neutral-loop time divided by Claude Code time per model">${g}</svg>`;
  bindTips($('ratioChart'));
}

// ------------------------------------------------------------------ dumbbell: × Haiku's time
{
  const locals = MODEL_ORDER.filter((m) => model(m).kind === 'local');
  const W = 520; const L = 116; const R = 40; const TOP = 26; const B = 26; const BAND = 56;
  const H = TOP + locals.length * BAND + B;
  const maxV = Math.ceil(Math.max(...locals.flatMap((m) => HARNESS_ORDER.map((h) => xHaiku(m, h)))) / 5) * 5;
  const x = (v) => L + (v / maxV) * (W - L - R);
  let g = '';
  for (let v = 0; v <= maxV; v += 5) g += `<line class="gridline" x1="${x(v)}" x2="${x(v)}" y1="${TOP - 6}" y2="${H - B}"/><text x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${v}×</text>`;
  g += `<line class="baseline" x1="${x(1)}" x2="${x(1)}" y1="${TOP - 6}" y2="${H - B}"/><text x="${x(1) + 4}" y="12">Haiku = 1×</text>`;
  locals.forEach((m, i) => {
    const y = TOP + i * BAND + BAND / 2;
    const a = xHaiku(m, 'claude-code'); const b = xHaiku(m, 'neutral');
    const tipHtml = `<span class="tt-k" style="background:${COLOR[m]}"></span><b>${esc(model(m).name)}</b><br>Claude Code: ${a.toFixed(1)}× Haiku (${fmtDur(T(m, 'claude-code').time)} vs ${fmtDur(T('haiku', 'claude-code').time)})<br>Neutral: ${b.toFixed(1)}× Haiku (${fmtDur(T(m, 'neutral').time)} vs ${fmtDur(T('haiku', 'neutral').time)})`;
    g += `<text class="lbl" x="${L - 10}" y="${y + 4}" text-anchor="end">${esc(model(m).name)}</text>`;
    g += `<rect class="hit" x="${L}" y="${y - 18}" width="${W - L - R}" height="36" data-tip="${esc(tipHtml)}"/>`;
    g += `<line x1="${x(a)}" x2="${x(b)}" y1="${y}" y2="${y}" stroke="${COLOR[m]}" stroke-width="2" stroke-linecap="round" pointer-events="none"/>`;
    g += `<circle cx="${x(a)}" cy="${y}" r="6" fill="var(--surface)" stroke="${COLOR[m]}" stroke-width="2.5" pointer-events="none"/>`;
    g += `<circle cx="${x(b)}" cy="${y}" r="6.5" fill="${COLOR[m]}" stroke="var(--surface)" stroke-width="2" pointer-events="none"/>`;
    const left = Math.min(a, b); const right = Math.max(a, b);
    g += `<text class="val" x="${x(left) - 11}" y="${y + 4}" text-anchor="end">${left.toFixed(1)}×</text>`;
    g += `<text class="val" x="${x(right) + 11}" y="${y + 4}">${right.toFixed(1)}×</text>`;
  });
  $('dumbbellChart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Local model total time as a multiple of Haiku's, Claude Code versus neutral loop">${g}</svg>`;
  bindTips($('dumbbellChart'));
}

// ------------------------------------------------------------------ gallery
{
  const tabs = $('galleryTabs');
  tabs.innerHTML = TASK_ORDER.map((id, i) => `<button role="tab" aria-selected="${i === 0}" data-task="${id}">${esc(task(id).title)}</button>`).join('');
  const show = (id) => {
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.task === id)));
    $('galleryGrid').innerHTML = HARNESS_ORDER.flatMap((h) => MODEL_ORDER.map((m) => {
      const r = run(id, m, h);
      if (!r || !r.shot) return '';
      return `<figure class="shot"><a href="${esc(r.shot)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(r.shot)}" alt="${esc(`${model(m).name}, ${HNAME[h]}: ${task(id).title}`)}"></a>
        <figcaption><span>${key(m)}${esc(model(m).name)} · ${HNAME[h]}</span><span class="mono">${r.passed}/${r.total} · ${fmtDur(r.wallMs)}</span></figcaption></figure>`;
    })).join('');
  };
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button[data-task]'); if (b) show(b.dataset.task); });
  show(TASK_ORDER[0]);
}

// ------------------------------------------------------------------ navigation
{
  const slides = [...document.querySelectorAll('.slide')];
  const dots = $('dots');
  dots.innerHTML = slides.map((s, i) => `<a href="#${s.id}" title="${esc(s.dataset.title || s.id)}" aria-label="Slide ${i + 1}: ${esc(s.dataset.title || s.id)}"></a>`).join('');
  let current = 0;
  const setCurrent = (i) => {
    current = i;
    $('counter').textContent = `${i + 1} / ${slides.length}`;
    $('progressBar').style.width = `${((i + 1) / slides.length) * 100}%`;
    dots.querySelectorAll('a').forEach((a, k) => a.classList.toggle('on', k === i));
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) setCurrent(slides.indexOf(en.target));
  }, { threshold: 0.55 });
  slides.forEach((s) => io.observe(s));
  // Update the position immediately, so quick repeated key presses don't read a
  // stale slide from the scroll observer mid-animation.
  const go = (i) => { const k = Math.max(0, Math.min(slides.length - 1, i)); setCurrent(k); slides[k].scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  document.addEventListener('keydown', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if ((el && el.closest('input, textarea, select, summary, [contenteditable]')) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['ArrowRight', 'PageDown', 'n'].includes(e.key)) { e.preventDefault(); go(current + 1); }
    else if (['ArrowLeft', 'PageUp', 'p'].includes(e.key)) { e.preventDefault(); go(current - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
  });
  setCurrent(0);
}
