#!/usr/bin/env node
// Re-grade every archived run with the current grader, so all results come from
// the same grader version. Rewrites results/runs/<runId>/grade.json + screenshots
// and the grade field in results/runs.jsonl (the old index is kept as
// runs.jsonl.bak-<timestamp>).
//   node grader/regrade.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeSite } from './grade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specCache = {};
const specFor = async (taskId) => (specCache[taskId] ||= await import(`./specs/${taskId}.mjs`));
const INDEX = path.join(ROOT, 'results', 'runs.jsonl');

const lines = fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean);
fs.copyFileSync(INDEX, `${INDEX}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const out = [];
for (const line of lines) {
  const rec = JSON.parse(line);
  const dir = path.join(ROOT, 'results', 'runs', rec.runId);
  const before = rec.grade?.total ? `${rec.grade.passed}/${rec.grade.total}` : '–';
  if (fs.existsSync(path.join(dir, 'site'))) {
    rec.taskId ||= 'pomodoro'; // runs from before tasks existed
    rec.taskTitle ||= 'Pomodoro timer';
    const g = await gradeSite(path.join(dir, 'site'), await specFor(rec.taskId), { outDir: dir });
    fs.writeFileSync(path.join(dir, 'grade.json'), JSON.stringify(g, null, 2));
    rec.grade = {
      score: g.score, passed: g.passed, total: g.total,
      failed: g.checks.filter((c) => !c.pass).map(({ id, label, detail }) => ({ id, label, detail })),
      checks: Object.fromEntries(g.checks.map((c) => [c.id, c.pass])),
      screenshots: g.screenshots,
    };
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(rec, null, 2));
    // Keep the dashboard's saved column state in step if this was the model's latest run.
    const stateFile = path.join(ROOT, 'runs', rec.model, 'state.json');
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (st.runId === rec.runId) {
        const g = rec.grade;
        const line = `Autograder: ${g.passed}/${g.total}${g.failed.length ? ` · failed ${g.failed.map((f) => f.id).join(', ')}` : ''} (regraded)`;
        const activity = (st.activity || []).map((a) => (/^Autograder:/.test(a.text) ? { ...a, kind: g.failed.length ? 'warn' : 'done', text: line } : a));
        fs.writeFileSync(stateFile, JSON.stringify({ ...st, grade: g, activity }));
      }
    } catch { /* no saved state */ }
  }
  const after = rec.grade?.total ? `${rec.grade.passed}/${rec.grade.total}` : '–';
  console.log(`${(rec.taskId || 'pomodoro').padEnd(12)} ${rec.modelName.padEnd(18)} ${rec.harness.padEnd(12)} r${rec.repeat}  ${before} → ${after}${rec.grade?.failed?.length ? `  failed: ${rec.grade.failed.map((f) => f.id).join(', ')}` : ''}`);
  out.push(JSON.stringify(rec));
}
fs.writeFileSync(INDEX, out.join('\n') + '\n');
