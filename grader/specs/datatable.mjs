// Checks for tasks/datatable/task.md. Expected results are computed here from
// the same seed data.json the model was given.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = 'datatable';
export const title = 'Data explorer';

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tasks', 'datatable', 'seed', 'data.json');
const DATA = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const COLS = { name: 'Name', city: 'City', signup: 'Signup date', orders: 'Orders', spend: 'Spend' };

// Text comparison: accept either locale-aware (base sensitivity) or plain
// case-folded code-point order; both are reasonable readings of "case-insensitive".
const textCmp = {
  locale: (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }),
  folded: (a, b) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; },
};
function expected(key, dir, q = '', how = 'locale') {
  const ql = q.toLowerCase();
  const rows = DATA.filter((r) => !ql || r.name.toLowerCase().includes(ql) || r.city.toLowerCase().includes(ql));
  return rows.sort((a, b) => {
    let c = 0;
    if (key === 'orders' || key === 'spend') c = a[key] - b[key];
    else if (key === 'signup') c = a.signup < b.signup ? -1 : a.signup > b.signup ? 1 : 0;
    else if (key) c = textCmp[how](a[key], b[key]);
    if (dir === 'desc') c = -c;
    return c || a.id - b.id;
  });
}
const sig = (r) => `${r.name}|${r.city}|${r.signup}`;
const matchesEither = (shown, key, dir, q, from = 0) => ['locale', 'folded'].some((how) => {
  const want = expected(key, dir, q, how).slice(from, from + shown.length).map(sig);
  return want.length === shown.length && want.every((w, i) => w === shown[i]);
});

// Compare only the sorted column's values, so tie order is checked in one place (sort-ties).
const COL_INDEX = { name: 0, city: 1, signup: 2, orders: 3, spend: 4 };
const shownValue = (key, cells) => (key === 'name' || key === 'city' ? cells[COL_INDEX[key]].toLowerCase() : cells[COL_INDEX[key]]);
const recValue = (key, r) => (key === 'name' || key === 'city' ? r[key].toLowerCase() : key === 'spend' ? money(r.spend) : String(r[key]));
const valuesMatch = (rows, key, dir, q = '', from = 0) => ['locale', 'folded'].some((how) => {
  const want = expected(key, dir, q, how).slice(from, from + rows.length).map((r) => recValue(key, r));
  return want.length === rows.length && rows.every((c, i) => shownValue(key, c) === want[i]);
});

async function dataRows(page) {
  return page.$$eval('table tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent.trim())).filter((c) => c.length >= 5));
}
const rowSig = (cells) => `${cells[0]}|${cells[1]}|${cells[2]}`;
async function status(page) {
  return page.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/Showing\s+(\d+)\s*[–—-]\s*(\d+)\s+of\s+(\d+)/);
    // Normalised to an en dash: only 'status-format' checks the exact character.
    if (m) return `Showing ${m[1]}–${m[2]} of ${m[3]}`;
    return /No results/i.test(txt) ? 'No results' : null;
  });
}
// Click the header the way a person would: on its button/link if it has one
// (the accessible pattern, often narrower than the cell), else on the cell.
async function clickHeader(page, key) {
  const th = page.locator('thead th').filter({ hasText: new RegExp(`^\\s*${COLS[key]}`, 'i') }).first();
  const inner = th.locator('button, a, [role="button"]').first();
  await ((await inner.count()) ? inner : th).click();
  await page.waitForTimeout(80);
}
const ariaSort = (page, key) => page.locator('thead th').filter({ hasText: new RegExp(`^\\s*${COLS[key]}`, 'i') }).first().getAttribute('aria-sort');
// Sort by `key` in direction `dir` by clicking its header (at most twice). An app
// may start already sorted by a column, so the first click can legitimately flip it.
async function sortBy(page, key, dir) {
  for (let i = 0; i < 2; i++) {
    await clickHeader(page, key);
    const a = await ariaSort(page, key);
    if (a === (dir === 'asc' ? 'ascending' : 'descending')) return true;
    if (a == null && valuesMatch(await dataRows(page), key, dir)) return true;
  }
  return false;
}

async function search(page, q) {
  const box = page.locator('input[type="search"]').first();
  await box.fill(q);
  await box.press('End'); // also fires keyup for apps that listen to it
  await page.waitForTimeout(120);
}
async function setSize(page, n) {
  const s = page.locator('select').filter({ has: page.locator('option', { hasText: /^\s*50\s*$/ }) }).first();
  await s.selectOption(String(n));
  await page.waitForTimeout(80);
}
async function next(page) {
  await page.getByRole('button', { name: /next/i }).first().click();
  await page.waitForTimeout(80);
}

export async function run(t) {
  await t.check('files', 'index.html, styles.css and app.js exist; data.json unchanged', () => {
    const missing = ['index.html', 'styles.css', 'app.js', 'data.json'].filter((f) => !fs.existsSync(path.join(t.dir, f)));
    if (missing.length) return { pass: false, detail: `missing ${missing.join(', ')}` };
    let same = false;
    try { same = JSON.stringify(JSON.parse(fs.readFileSync(path.join(t.dir, 'data.json'), 'utf8'))) === JSON.stringify(DATA); } catch { /* invalid JSON */ }
    return { pass: same, detail: same ? '' : 'data.json was modified' };
  });

  const fresh = async (opts = {}) => {
    const p = await t.newPage(opts);
    await p.waitForSelector('table tbody tr', { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(150);
    return p;
  };
  let page;
  try { page = await fresh(); } catch (e) {
    await t.check('loads', 'Page loads', () => ({ pass: false, detail: String(e.message).slice(0, 160) }));
    return;
  }

  await t.check('first-page', 'Loads data.json: 10 rows and "Showing 1–10 of 137"', async () => {
    const rows = await dataRows(page);
    const s = await status(page);
    return { pass: rows.length === 10 && s === 'Showing 1–10 of 137', detail: `${rows.length} rows, status "${s}"` };
  });

  await t.check('columns', 'Columns Name, City, Signup date, Orders, Spend; $ and date formats', async () => {
    const heads = await page.$$eval('thead th', (ths) => ths.map((th) => th.textContent.replace(/[▲▼↑↓⇅]/g, '').trim()));
    const order = heads.slice(0, 5).map((h) => h.toLowerCase());
    const okHeads = ['name', 'city', 'signup date', 'orders', 'spend'].every((w, i) => (order[i] || '').startsWith(w));
    const rows = await dataRows(page);
    const bad = rows.filter((c) => {
      const rec = DATA.find((r) => r.name === c[0] && r.city === c[1] && r.signup === c[2]);
      return !rec || c[3] !== String(rec.orders) || c[4] !== money(rec.spend);
    });
    return { pass: okHeads && rows.length > 0 && !bad.length, detail: `${heads.join(' | ')}${bad.length ? ` · bad row: ${bad[0].join(' / ')}` : ''}` };
  });

  await t.check('sort-name', 'Name header sorts ascending (case-insensitive, ties by id)', async () => {
    await sortBy(page, 'name', 'asc');
    const rows = await dataRows(page);
    return { pass: rows.length === 10 && valuesMatch(rows, 'name', 'asc'), detail: rows.slice(0, 3).map((c) => c[0]).join(' · ') };
  });

  await t.check('aria-sort', 'Sorted header carries aria-sort; clicking again toggles it', async () => {
    const asc = await ariaSort(page, 'name');
    await clickHeader(page, 'name'); // toggle from ascending
    const desc = await ariaSort(page, 'name');
    return { pass: asc === 'ascending' && desc === 'descending', detail: `while ascending: ${asc}, after one more click: ${desc}` };
  });

  await t.check('sort-name-desc', 'Second click sorts descending', async () => {
    const rows = await dataRows(page);
    return { pass: rows.length === 10 && valuesMatch(rows, 'name', 'desc'), detail: rows.slice(0, 3).map((c) => c[0]).join(' · ') };
  });

  await t.check('sort-orders', 'Orders sorts numerically (9 before 10)', async () => {
    await sortBy(page, 'orders', 'asc');
    const rows = await dataRows(page);
    return { pass: rows.length === 10 && valuesMatch(rows, 'orders', 'asc'), detail: `orders: ${rows.map((c) => c[3]).join(',')}` };
  });

  await t.check('sort-date', 'Signup date sorts chronologically (desc on 2nd click)', async () => {
    await sortBy(page, 'signup', 'desc');
    const rows = await dataRows(page);
    return { pass: rows.length === 10 && valuesMatch(rows, 'signup', 'desc'), detail: `dates: ${rows.slice(0, 4).map((c) => c[2]).join(',')}` };
  });

  await t.check('sort-ties', 'Ties are ordered by id ascending, also when descending (full City ↓ order, all pages)', async () => {
    await setSize(page, 50);
    await sortBy(page, 'city', 'desc');
    const all = [];
    for (let i = 0; i < 5; i++) {
      all.push(...(await dataRows(page)).map(rowSig));
      const btn = page.getByRole('button', { name: /next/i }).first();
      if (all.length >= DATA.length || (await btn.isDisabled().catch(() => true))) break;
      await btn.click();
      await page.waitForTimeout(60);
    }
    const firstBad = ['locale', 'folded'].map((how) => expected('city', 'desc', '', how).map(sig).findIndex((w, i) => w !== all[i])).reduce((a, b) => (a === -1 || b === -1 ? -1 : Math.max(a, b)));
    await setSize(page, 10);
    return { pass: all.length === DATA.length && firstBad === -1, detail: `${all.length} rows${firstBad >= 0 ? `, first mismatch at #${firstBad + 1}` : ''}` };
  });

  await t.check('sort-spend', 'Spend sorts numerically (ties by id)', async () => {
    await sortBy(page, 'spend', 'asc');
    const rows = await dataRows(page);
    return { pass: rows.length === 10 && valuesMatch(rows, 'spend', 'asc'), detail: `spend: ${rows.slice(0, 4).map((c) => c[4]).join(',')}` };
  });
  await page.context().close();

  await t.check('pagination', 'Next/Previous pages; last page "Showing 131–137 of 137"', async () => {
    const p = await fresh();
    await next(p);
    const s2 = await status(p);
    for (let i = 0; i < 15; i++) {
      const btn = p.getByRole('button', { name: /next/i }).first();
      if (await btn.isDisabled().catch(() => true)) break;
      await btn.click();
      await p.waitForTimeout(40);
    }
    const sLast = await status(p);
    const rowsLast = await dataRows(p);
    await p.getByRole('button', { name: /prev/i }).first().click();
    await p.waitForTimeout(60);
    const sPrev = await status(p);
    await p.context().close();
    return {
      pass: s2 === 'Showing 11–20 of 137' && sLast === 'Showing 131–137 of 137' && rowsLast.length === 7 && sPrev === 'Showing 121–130 of 137',
      detail: `page 2 "${s2}", last "${sLast}" (${rowsLast.length} rows), back "${sPrev}"`,
    };
  });

  await t.check('page-size', 'Page size 25/50 works and returns to page 1', async () => {
    const p = await fresh();
    await next(p);
    await setSize(p, 25);
    const rows = await dataRows(p);
    const s = await status(p);
    await setSize(p, 50);
    const rows50 = await dataRows(p);
    await p.context().close();
    return { pass: rows.length === 25 && s === 'Showing 1–25 of 137' && rows50.length === 50, detail: `25 → ${rows.length} rows "${s}", 50 → ${rows50.length} rows` };
  });

  await t.check('search', 'Search matches name or city, case-insensitive', async () => {
    const p = await fresh();
    await search(p, 'BER');
    const want = expected(null, 'asc', 'ber');
    const s = await status(p);
    const rows = await dataRows(p);
    const allMatch = rows.every((c) => `${c[0]} ${c[1]}`.toLowerCase().includes('ber'));
    await p.context().close();
    return { pass: s === `Showing 1–10 of ${want.length}` && allMatch && rows.length === 10, detail: `"${s}" (want 1–10 of ${want.length})` };
  });

  await t.check('search-resets', 'Searching returns to page 1', async () => {
    const p = await fresh();
    await next(p);
    await next(p);
    await search(p, 'o');
    const s = await status(p);
    await p.context().close();
    return { pass: /^Showing 1–/.test(s || ''), detail: `"${s}"` };
  });

  await t.check('no-results', '"No results" and no data rows when nothing matches', async () => {
    const p = await fresh();
    await search(p, 'zzzzqq');
    const rows = await dataRows(p);
    const shown = await p.evaluate(() => /No results/i.test(document.body.innerText));
    await p.context().close();
    return { pass: rows.length === 0 && shown, detail: `${rows.length} data rows, "No results" visible: ${shown}` };
  });

  await t.check('totals', 'Footer totals cover all matching rows, not just the page', async () => {
    const p = await fresh();
    await search(p, 'ber');
    const want = expected(null, 'asc', 'ber');
    const orders = String(want.reduce((s, r) => s + r.orders, 0));
    const sum = want.reduce((s, r) => s + r.spend, 0);
    const cents = want.reduce((s, r) => s + Math.round(r.spend * 100), 0) / 100;
    const spends = [...new Set([money(sum), money(Math.round(sum * 100) / 100), money(cents)])];
    const spend = spends[0];
    const foot = await p.$eval('tfoot', (el) => el.textContent.replace(/\s+/g, ' ')).catch(() => '');
    await p.context().close();
    const hasOrders = new RegExp(`(^|[^\\d,])${orders.replace(/\B(?=(\d{3})+(?!\d))/g, ',?')}([^\\d]|$)`).test(foot);
    return { pass: hasOrders && spends.some((x) => foot.includes(x)), detail: `tfoot "${foot.trim().slice(0, 80)}" (want ${orders} and ${spend})` };
  });

  await t.check('hash-write', 'State is written to the URL hash (sort, dir, q, page, size)', async () => {
    const p = await fresh();
    await sortBy(p, 'spend', 'desc');
    await setSize(p, 25);
    await search(p, 'on');
    const h = new URLSearchParams((await p.evaluate(() => location.hash)).slice(1));
    await p.context().close();
    const got = Object.fromEntries(['sort', 'dir', 'q', 'page', 'size'].map((k) => [k, h.get(k)]));
    const ok = got.sort === 'spend' && got.dir === 'desc' && got.q === 'on' && (got.page === '1' || got.page === null) && got.size === '25';
    return { pass: ok, detail: JSON.stringify(got) };
  });

  await t.check('hash-restore', 'Opening a URL with a hash restores that exact state', async () => {
    const p = await fresh({ hash: 'sort=signup&dir=asc&q=an&page=2&size=10' });
    const rows = await dataRows(p);
    const s = await status(p);
    await p.context().close();
    const want = expected('signup', 'asc', 'an');
    const ok = rows.length === 10 && valuesMatch(rows, 'signup', 'asc', 'an', 10) && s === `Showing 11–20 of ${want.length}`;
    return { pass: ok, detail: `"${s}" first date: ${rows[0]?.[2] || '–'} (want ${want[10]?.signup})` };
  });

  await t.check('status-format', 'Status line uses an en dash exactly ("Showing 11–20 of 137")', async () => {
    const p = await fresh();
    const exact = await p.evaluate(() => /Showing 1–10 of 137/.test(document.body.innerText));
    await t.screenshot(p, 'desktop');
    await p.context().close();
    return { pass: exact, detail: exact ? '' : 'no "Showing 1–10 of 137" with an en dash' };
  });

  await t.check('layout-360', 'At 360px the table scrolls in its own container (no page scroll)', async () => {
    const p = await fresh({ viewport: { width: 360, height: 740 } });
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    await t.screenshot(p, 'mobile');
    await p.context().close();
    return { pass: m.sw <= m.iw + 1, detail: `page scrollWidth ${m.sw}/${m.iw}` };
  });

  await t.check('no-external', 'No external requests (no CDNs / libraries)', () => ({ pass: t.external.size === 0, detail: [...t.external].join(', ') }));
  await t.check('no-errors', 'No JavaScript errors', () => ({ pass: t.errors.length === 0, detail: t.errors.slice(0, 2).join(' | ') }));
}

export const selftest = (edit) => [
  ['reference', [], () => {}],
  ['orders sorted as text', ['sort-orders'], edit('app.js', "if (k === 'orders' || k === 'spend') c = a[k] - b[k];", "if (k === 'spend') c = a[k] - b[k];\n  else if (k === 'orders') c = String(a[k]).localeCompare(String(b[k]));")],
  ['hyphen in status', ['status-format'], edit('app.js', '`Showing ${start + 1}–${start + pageRows.length} of ${rows.length}`', '`Showing ${start + 1}-${start + pageRows.length} of ${rows.length}`')],
  ['hash not restored', ['hash-restore'], edit('app.js', "window.addEventListener('hashchange', () => { readHash(); render(); });\n\nreadHash();", "window.addEventListener('hashchange', () => { readHash(); render(); });\n\nhistory.replaceState(null, '', location.pathname);")],
  ['totals per page only', ['totals'], edit('app.js', "$('tot-orders').textContent = String(rows.reduce", "$('tot-orders').textContent = String(pageRows.reduce")],
  ['search keeps page', ['search-resets'], edit('app.js', "state.q = e.target.value; state.page = 1;", 'state.q = e.target.value;')],
  // Positive control (Haiku's real markup): sort handlers on a <button> inside each <th>.
  ['header buttons (accessible pattern)', [], (dir) => {
    for (const [k, label] of [['name', 'Name'], ['city', 'City'], ['signup', 'Signup date'], ['orders', 'Orders'], ['spend', 'Spend']]) {
      edit('index.html', `<th data-key="${k}">${label}</th>`, `<th data-key="${k}"><button type="button">${label}</button></th>`)(dir);
    }
    edit('app.js', "document.querySelectorAll('th[data-key]').forEach((th) => th.addEventListener('click', () => {", "document.querySelectorAll('th[data-key]').forEach((th) => th.querySelector('button').addEventListener('click', () => {")(dir);
  }],
  // Positive controls (Inkling's real behaviour): starts sorted by Name ascending;
  // shows "No results" while the status line says "Showing 0–0 of 0".
  ['starts sorted by Name', [], (dir) => {
    edit('app.js', "let state = { sort: null, dir: 'asc', q: '', page: 1, size: 10 };", "let state = { sort: 'name', dir: 'asc', q: '', page: 1, size: 10 };")(dir);
    edit('app.js', "sort: KEYS.includes(sort) ? sort : null,", "sort: KEYS.includes(sort) ? sort : 'name',")(dir);
  }],
  ['"No results" plus a 0–0 status', [], edit('app.js', ": 'No results';", ": 'Showing 0–0 of 0';")],
  ['never says "No results"', ['no-results'], (dir) => {
    edit('app.js', ": 'No results';", ": '';")(dir);
    edit('index.html', '<p id="empty" hidden>No results</p>', '<p id="empty" hidden>Nothing here</p>')(dir);
  }],
  ['ties by id desc', ['sort-ties'], edit('app.js', 'if (state.dir === \'desc\') c = -c;\n  return c || a.id - b.id;', "return state.dir === 'desc' ? -(c || a.id - b.id) : (c || a.id - b.id);")],
];
