#!/usr/bin/env node
// Generates tasks/datatable/seed/data.json deterministically (same output every run).
// Built-in traps: orders 1–150 (string sort puts "9" after "10"), spend into the
// thousands (needs separators), names that differ only by case and exact
// duplicates (case-insensitive sort + id tie-break), and several cities with "ber".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let seed = 20261123;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];

const first = ['Ava', 'Ben', 'Chloe', 'Dan', 'Ella', 'Finn', 'Grace', 'Hugo', 'Isla', 'Jack', 'Kai', 'Lena', 'Mia', 'Noah', 'Olive', 'Paul', 'Quinn', 'Ruby', 'Sam', 'Tara', 'Uma', 'Vic', 'Will', 'Yara', 'Zoe'];
const last = ['Adler', 'Berger', 'Costa', 'Dahl', 'Evans', 'Fischer', 'Garcia', 'Hansen', 'Ito', 'Jensen', 'Klein', 'Lee', 'Moreau', 'Novak', 'Olsen', 'Petrov', 'Quist', 'Rossi', 'Silva', 'Tanaka'];
const cities = ['Berlin', 'Bergen', 'Bern', 'Lisbon', 'Oslo', 'Toronto', 'Osaka', 'Lyon', 'Austin', 'Cumberland', 'Melbourne', 'Seville', 'Hamburg', 'Kraków'];

const rows = [];
for (let id = 1; id <= 137; id++) {
  let name = `${pick(first)} ${pick(last)}`;
  if (id % 23 === 0) name = name.toLowerCase();       // differs from others only by case
  if (id % 31 === 0 && rows.length) name = rows[rows.length - 5].name; // exact duplicate → id tie-break
  const y = 2019 + Math.floor(rand() * 8);
  const m = 1 + Math.floor(rand() * 12);
  const d = 1 + Math.floor(rand() * 28);
  const signup = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const orders = id % 9 === 0 ? 1 + Math.floor(rand() * 9) : 1 + Math.floor(rand() * 150);
  const spend = Math.round((orders * (5 + rand() * 120)) * 100) / 100;
  rows.push({ id, name, city: pick(cities), signup, orders, spend });
}
// A few deliberate ties on the numeric columns.
rows[10].orders = rows[40].orders = rows[90].orders = 42;
rows[11].spend = rows[71].spend = 1234.5;

const out = path.join(ROOT, 'tasks', 'datatable', 'seed', 'data.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 2) + '\n');
console.log(`wrote ${rows.length} rows → ${path.relative(ROOT, out)}`);
