#!/usr/bin/env node
// Negative controls for every autograder spec. For each case: start from the
// task's seed (tasks/<id>/seed, if any), lay the known-good reference
// (grader/fixtures/<id>/reference) on top, apply the case's mutation, grade,
// and require that exactly the expected checks fail.
//   node grader/selftest.mjs              all tasks
//   node grader/selftest.mjs datatable    one task
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeSite } from './grade.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ALL = fs.readdirSync(path.join(here, 'specs')).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''));
const only = process.argv.slice(2);

const edit = (file, from, to) => (dir) => {
  const p = path.join(dir, file);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 60)}`);
  fs.writeFileSync(p, src.replace(from, to));
};

let failures = 0;
let total = 0;
for (const id of only.length ? only : ALL) {
  const spec = await import(`./specs/${id}.mjs`);
  if (!spec.selftest) { console.log(`\n${id}: no selftest cases`); continue; }
  const seed = path.join(ROOT, 'tasks', id, 'seed');
  const ref = path.join(here, 'fixtures', id, 'reference');
  console.log(`\n${spec.title} (${id})`);
  for (const [name, expectFail, mutate] of spec.selftest(edit)) {
    total += 1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `grader-${id}-`));
    if (fs.existsSync(seed)) fs.cpSync(seed, dir, { recursive: true });
    if (mutate !== 'seed') fs.cpSync(ref, dir, { recursive: true });
    if (typeof mutate === 'function') mutate(dir);
    const g = await gradeSite(dir, spec);
    const failed = g.checks.filter((c) => !c.pass).map((c) => c.id).sort();
    const ok = JSON.stringify(failed) === JSON.stringify([...expectFail].sort());
    if (!ok) failures += 1;
    console.log(`${ok ? '✓' : '✗'} ${name.padEnd(36)} ${g.passed}/${g.total}  failed: ${failed.join(', ') || '—'}${ok ? '' : `   (expected: ${expectFail.join(', ') || '—'})`}`);
    if (!ok) for (const c of g.checks.filter((x) => !x.pass)) console.log(`      ${c.id}: ${c.detail}`);
  }
}
console.log(failures ? `\n${failures} of ${total} case(s) did not match` : `\nall ${total} cases matched`);
process.exit(failures ? 1 : 0);
