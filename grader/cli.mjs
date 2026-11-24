#!/usr/bin/env node
// Grade a site folder from the command line:
//   node grader/cli.mjs <siteDir> [--out <dir>] [--spec pomodoro] [--json]
import path from 'node:path';
import fs from 'node:fs';
import { gradeSite } from './grade.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = args.find((a, i) => !a.startsWith('--') && !['--out', '--spec'].includes(args[i - 1]));
if (!dir) { console.error('usage: node grader/cli.mjs <siteDir> [--out dir] [--spec pomodoro] [--json]'); process.exit(2); }

const spec = await import(`./specs/${opt('--spec') || 'pomodoro'}.mjs`);
const outDir = opt('--out');
const g = await gradeSite(path.resolve(dir), spec, { outDir });
if (outDir) fs.writeFileSync(path.join(outDir, 'grade.json'), JSON.stringify(g, null, 2));
if (args.includes('--json')) { console.log(JSON.stringify(g)); process.exit(0); }
console.log(`${spec.title}: ${g.passed}/${g.total} (${Math.round(g.score * 100)}%) in ${(g.ms / 1000).toFixed(1)}s — ${dir}`);
for (const c of g.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.label}${c.detail ? `  — ${c.detail}` : ''}`);
