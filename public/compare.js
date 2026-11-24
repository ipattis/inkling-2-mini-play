'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const median = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
};
const sum = (xs) => (xs.some((x) => x == null) || !xs.length ? null : xs.reduce((a, b) => a + b, 0));
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmtDur = (ms) => {
  if (ms == null) return '–';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const fmtTok = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const fmtUsd = (v) => (v == null ? '–' : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const cls = (x) => (x == null ? '' : x >= 0.999 ? 'good' : x >= 0.75 ? 'mid' : 'bad');

let data = null;
const labels = {}; // taskId -> {checkId: label}
let blind = false;

async function load() {
  data = await (await fetch('/api/results')).json();
  const batches = [...new Set(data.runs.map((r) => r.batchId))].sort().reverse();
  document.getElementById('batch').innerHTML = [
    ...batches.map((b, i) => `<option value="${esc(b)}">${i === 0 ? 'Latest · ' : ''}${esc(b.replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2'))} (${data.runs.filter((r) => r.batchId === b).length} runs)</option>`),
    '<option value="*">All batches pooled</option>',
  ].join('');
  const withRuns = data.tasks.filter((t) => data.runs.some((r) => r.taskId === t.id));
  document.getElementById('task').innerHTML = `<option value="*">All tasks (${withRuns.length})</option>`
    + withRuns.map((t) => `<option value="${esc(t.id)}">${esc(t.title)} · ${esc(t.level)}</option>`).join('');
  // Check labels come from one grade.json per task (identical across runs of a task).
  for (const t of withRuns) {
    const any = data.runs.find((r) => r.taskId === t.id && r.grade && !r.grade.error);
    if (!any) continue;
    try {
      const g = await (await fetch(`/results/runs/${encodeURIComponent(any.runId)}/grade.json`)).json();
      labels[t.id] = Object.fromEntries(g.checks.map((c) => [c.id, c.label]));
    } catch { /* optional */ }
  }
  document.getElementById('batch').onchange = render;
  document.getElementById('task').onchange = render;
  render();
}

const batchRuns = () => { const b = document.getElementById('batch').value; return data.runs.filter((r) => b === '*' || r.batchId === b); };
const taskSel = () => document.getElementById('task').value;

// Per (model, harness, task): medians over repeats.
function cell(rs) {
  const graded = rs.filter((r) => r.grade && !r.grade.error);
  return {
    n: rs.length, finished: rs.filter((r) => r.status === 'done').length,
    score: median(graded.map((r) => r.grade.score)),
    allPass: graded.filter((r) => r.grade.passed === r.grade.total).length,
    passed: median(graded.map((r) => r.grade.passed)), total: graded[0]?.grade.total ?? null,
    time: median(rs.map((r) => r.wallMs)), ttft: median(rs.map((r) => r.ttftMs)),
    out: median(rs.map((r) => r.tokens?.output)), calls: median(rs.map((r) => r.apiRequests)),
    errs: median(rs.map((r) => r.toolErrors)), tps: median(rs.map((r) => r.tokPerSec)), cost: median(rs.map((r) => r.costUsd)),
  };
}
// Across tasks: mean score, summed time / tokens / calls / cost of the per-task medians.
function combine(cells) {
  return {
    n: cells.reduce((a, c) => a + c.n, 0), finished: cells.reduce((a, c) => a + c.finished, 0), tasks: cells.length,
    score: mean(cells.map((c) => c.score)), allPass: cells.filter((c) => c.score != null && c.score >= 0.999).length,
    time: sum(cells.map((c) => c.time)), ttft: median(cells.map((c) => c.ttft)), out: sum(cells.map((c) => c.out)),
    calls: sum(cells.map((c) => c.calls)), errs: sum(cells.map((c) => c.errs)), tps: median(cells.map((c) => c.tps)), cost: sum(cells.map((c) => c.cost)),
  };
}

function render() {
  const all = batchRuns();
  const sel = taskSel();
  const runs = sel === '*' ? all : all.filter((r) => r.taskId === sel);
  const { models, harnesses } = data;
  const tasks = data.tasks.filter((t) => all.some((r) => r.taskId === t.id));
  const hName = (id) => harnesses.find((h) => h.id === id)?.short || id;
  const hCls = (id) => (id === 'neutral' ? 'h-neutral' : 'h-cc');
  const pairs = [];
  for (const m of models) for (const h of harnesses) if (all.some((r) => r.model === m.id && r.harness === h.id)) pairs.push({ m, h });
  const statFor = (m, h, rs) => {
    const mine = rs.filter((r) => r.model === m.id && r.harness === h.id);
    if (!mine.length) return null;
    const byTask = [...new Set(mine.map((r) => r.taskId))].map((tid) => cell(mine.filter((r) => r.taskId === tid)));
    return sel === '*' ? combine(byTask) : byTask[0];
  };

  document.getElementById('note').innerHTML = all.length
    ? `${all.length} runs across ${tasks.length} task${tasks.length > 1 ? 's' : ''}. Score = share of a task's autograder checks passed (each grader is calibrated against a reference solution and deliberately broken variants).
       ${sel === '*' ? 'With “All tasks”, score is the mean over tasks and time / tokens / cost are summed over tasks (medians over repeats within a task).' : 'Medians are over repeats; with n = 1 they are single runs.'}
       Times are wall clock on this Mac for local models and Bedrock for Haiku. Local cost is $0 API spend (hardware and power not counted).`
    : 'No graded runs yet. Run a batch from the dashboard.';

  // ---- overview matrix (all tasks)
  const ov = document.getElementById('overviewSec');
  ov.style.display = tasks.length > 1 ? '' : 'none';
  if (tasks.length > 1) {
    document.getElementById('overview').innerHTML = `<table>
      <tr><th>Model</th><th class="l">Harness</th>${tasks.map((t) => `<th>${esc(t.title)}<span class="sub">${esc(t.level)}</span></th>`).join('')}<th>Mean score</th><th>Tasks 100%</th><th>Total time</th><th>Total cost</th></tr>
      ${pairs.map(({ m, h }) => {
        const cs = tasks.map((t) => { const rs = all.filter((r) => r.model === m.id && r.harness === h.id && r.taskId === t.id); return rs.length ? cell(rs) : null; });
        const tot = combine(cs.filter(Boolean));
        return `<tr><td class="model">${esc(m.name)}</td><td class="l ${hCls(h.id)}">${esc(h.short)}</td>
          ${cs.map((c) => (c ? `<td class="mono"><span class="${cls(c.score)}">${c.passed != null ? `${c.passed}/${c.total}` : '–'}</span><span class="sub">${fmtDur(c.time)}</span></td>` : '<td class="mono">–</td>')).join('')}
          <td class="mono ${cls(tot.score)}">${pct(tot.score)}</td><td class="mono">${tot.allPass}/${cs.filter(Boolean).length}</td>
          <td class="mono">${cs.every(Boolean) ? fmtDur(tot.time) : '–'}</td><td class="mono">${m.kind === 'local' ? '$0' : fmtUsd(tot.cost)}</td></tr>`;
      }).join('')}</table>`;
  }

  // ---- summary
  document.getElementById('summaryTitle').textContent = sel === '*' ? 'Summary across all tasks' : `Summary: ${tasks.find((t) => t.id === sel)?.title || sel} (medians across repeats)`;
  const rowsSum = pairs.map(({ m, h }) => ({ m, h, s: statFor(m, h, runs) })).filter((x) => x.s);
  document.getElementById('summary').innerHTML = rowsSum.length ? `<table>
    <tr><th>Model</th><th class="l">Harness</th><th>Runs</th><th>Autograder</th><th>${sel === '*' ? 'Tasks 100%' : 'All checks passed'}</th><th>Time</th><th>First token</th><th>Output tokens</th><th>API calls</th><th>Tool errors</th><th>tok/s</th><th>Cost</th></tr>
    ${rowsSum.map(({ m, h, s }) => `<tr><td class="model">${esc(m.name)}<span class="sub">${esc(m.kind === 'local' ? `${m.quant} · llama.cpp` : 'Bedrock')}</span></td>
        <td class="l ${hCls(h.id)}">${esc(h.short)}</td>
        <td class="mono">${s.finished}/${s.n}</td>
        <td class="mono ${cls(s.score)}">${pct(s.score)}</td>
        <td class="mono">${sel === '*' ? `${s.allPass}/${s.tasks}` : `${s.allPass}/${s.n}`}</td>
        <td class="mono">${fmtDur(s.time)}</td><td class="mono">${fmtDur(s.ttft)}</td><td class="mono">${fmtTok(s.out)}</td>
        <td class="mono">${s.calls ?? '–'}</td><td class="mono">${s.errs ?? '–'}</td>
        <td class="mono">${s.tps ? s.tps.toFixed(1) : '–'}</td><td class="mono">${m.kind === 'local' ? '$0' : fmtUsd(s.cost)}</td></tr>`).join('')}</table>`
    : '<div class="empty">Nothing yet.</div>';

  // ---- harness effect
  const rowsEff = models.map((m) => {
    const a = statFor(m, { id: 'claude-code' }, runs); const b = statFor(m, { id: 'neutral' }, runs);
    if (!a || !b) return null;
    const ratio = a.time && b.time ? b.time / a.time : null;
    const dScore = a.score != null && b.score != null ? b.score - a.score : null;
    const dOut = a.out && b.out ? b.out / a.out : null;
    return `<tr><td class="model">${esc(m.name)}</td>
      <td class="mono">${pct(a.score)} → ${pct(b.score)} <span class="${dScore > 0 ? 'good' : dScore < 0 ? 'bad' : ''}">(${dScore == null ? '–' : `${dScore >= 0 ? '+' : ''}${Math.round(dScore * 100)} pts`})</span></td>
      <td class="mono">${fmtDur(a.time)} → ${fmtDur(b.time)} <span class="${ratio < 1 ? 'good' : ratio > 1 ? 'bad' : ''}">(${ratio ? `${ratio.toFixed(2)}×` : '–'})</span></td>
      <td class="mono">${fmtTok(a.out)} → ${fmtTok(b.out)} (${dOut ? `${dOut.toFixed(2)}×` : '–'})</td>
      <td class="mono">${a.calls ?? '–'} → ${b.calls ?? '–'}</td></tr>`;
  }).filter(Boolean);
  document.getElementById('effect').innerHTML = rowsEff.length ? `<table>
    <tr><th>Model</th><th>Autograder (Claude Code → neutral)</th><th>Time</th><th>Output tokens</th><th>API calls</th></tr>${rowsEff.join('')}</table>
    <p class="note" style="margin:8px 0 0">If Claude Code favours Claude models, Haiku should gain relatively less (or lose more) in the neutral loop than the local models do.</p>`
    : '<div class="empty">Needs runs in both harnesses.</div>';

  // ---- requirement heatmap (one task at a time)
  const heat = document.getElementById('heat');
  if (sel === '*') {
    heat.innerHTML = '<div class="empty">Pick a task above to see its requirement-by-requirement pass rates.</div>';
  } else {
    const L = labels[sel] || {};
    const ids = Object.keys(L).length ? Object.keys(L) : [...new Set(runs.flatMap((r) => Object.keys(r.grade?.checks || {})))];
    const groups = pairs.map(({ m, h }) => ({ m, h, rs: runs.filter((r) => r.model === m.id && r.harness === h.id) })).filter((g) => g.rs.length);
    heat.innerHTML = groups.length && ids.length ? `<table class="heat">
      <tr><th class="l">Requirement</th>${groups.map(({ m, h }) => `<th>${esc(m.name)}<span class="sub ${hCls(h.id)}">${esc(h.short)}</span></th>`).join('')}</tr>
      ${ids.map((id) => `<tr><td class="l">${esc(L[id] || id)}</td>${groups.map(({ rs }) => {
        const g = rs.filter((r) => r.grade?.checks && id in r.grade.checks);
        if (!g.length) return '<td class="cell">–</td>';
        const p = g.filter((r) => r.grade.checks[id]).length;
        return `<td class="cell ${cls(p / g.length)}">${p}/${g.length}</td>`;
      }).join('')}</tr>`).join('')}</table>` : '<div class="empty">Nothing graded yet.</div>';
  }

  // ---- gallery
  let shots = runs.filter((r) => r.grade?.screenshots?.desktop);
  if (blind) shots = shots.map((r) => [Math.random(), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const gal = document.getElementById('gallery');
  gal.className = `gallery ${blind ? 'blind' : ''}`;
  gal.innerHTML = shots.map((r, i) => `
    <div class="shot">
      <a href="/results/runs/${encodeURIComponent(r.runId)}/desktop.png" target="_blank"><img loading="lazy" src="/results/runs/${encodeURIComponent(r.runId)}/desktop.png" alt=""></a>
      <div class="cap"><span class="who">${blind ? `Entry ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}` : `<b>${esc(r.modelName)}</b> <span class="${hCls(r.harness)}">${esc(hName(r.harness))}</span>${sel === '*' ? ` · ${esc(r.taskTitle)}` : ''} #${r.repeat}`}</span>
      <span class="mono">${blind ? '' : `${r.grade.passed}/${r.grade.total}`}</span></div>
    </div>`).join('') || '<div class="empty">No screenshots yet.</div>';

  // ---- runs
  document.getElementById('runs').innerHTML = runs.length ? `<table>
    <tr><th class="l">Started</th><th class="l">Task</th><th class="l">Model</th><th class="l">Harness</th><th>#</th><th class="l">Status</th><th>Autograder</th><th class="l">Failed checks</th><th>Time</th><th>Output</th><th>Calls</th><th>Cost</th></tr>
    ${[...runs].sort((a, b) => a.at.localeCompare(b.at)).map((r) => `<tr>
      <td class="l mono">${esc(r.at.slice(5, 16).replace('T', ' '))}</td>
      <td class="l">${esc(r.taskTitle)}</td>
      <td class="l">${esc(r.modelName)}</td>
      <td class="l ${hCls(r.harness)}">${esc(hName(r.harness))}</td>
      <td class="mono">${r.repeat}</td>
      <td class="l ${r.status === 'done' ? 'good' : 'bad'}">${esc(r.status)}${r.error ? ` <span class="sub">${esc(r.error.slice(0, 60))}</span>` : ''}</td>
      <td class="mono ${cls(r.grade?.score)}">${r.grade?.total ? `${r.grade.passed}/${r.grade.total}` : esc(r.grade?.error ? 'err' : '–')}</td>
      <td class="l" style="white-space:normal;max-width:360px;color:var(--muted)">${esc((r.grade?.failed || []).map((f) => f.id).join(', '))}</td>
      <td class="mono">${fmtDur(r.wallMs)}</td>
      <td class="mono">${fmtTok(r.tokens?.output)}</td>
      <td class="mono">${r.apiRequests ?? '–'}</td>
      <td class="mono">${r.model === 'haiku' ? fmtUsd(r.costUsd) : '$0'}</td></tr>`).join('')}</table>` : '<div class="empty">No runs yet.</div>';
}

document.getElementById('blind').onclick = (e) => {
  blind = !blind;
  e.currentTarget.textContent = `Blind mode: ${blind ? 'on (names hidden, order shuffled)' : 'off'}`;
  render();
};

load();
