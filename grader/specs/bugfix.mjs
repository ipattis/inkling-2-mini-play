// Checks for tasks/bugfix/task.md: one per reported bug, plus regression checks
// for what already worked. The untouched seed must fail exactly the seven bug
// checks (see selftest below), which makes it a built-in negative control.
import fs from 'node:fs';
import path from 'node:path';

export const id = 'bugfix';
export const title = 'Bug fix: expense tracker';

const IDS = ['form', 'desc', 'amount', 'category', 'date', 'add', 'error', 'filter', 'total', 'list', 'empty', 'by-category'];

async function add(page, { desc, amount, category = 'Food', date = '2026-01-10' }) {
  await page.fill('#desc', desc);
  await page.fill('#amount', String(amount));
  await page.selectOption('#category', category);
  await page.fill('#date', date);
  await page.click('#add');
  await page.waitForTimeout(60);
}
const items = (page) => page.$$eval('#list .expense', (lis) => lis.map((li) => ({
  desc: li.querySelector('.desc')?.textContent ?? '',
  cat: li.querySelector('.cat')?.textContent ?? '',
  date: li.querySelector('.date')?.textContent ?? '',
  amount: li.querySelector('.amount')?.textContent ?? '',
})));
const errorShown = (page) => page.$eval('#error', (el) => !el.hidden && getComputedStyle(el).display !== 'none' && el.textContent.trim().length > 0).catch(() => false);
async function filter(page, value) {
  await page.selectOption('#filter', value);
  await page.waitForTimeout(60);
}

export async function run(t) {
  await t.check('files', 'index.html, styles.css and app.js still exist', () => {
    const missing = ['index.html', 'styles.css', 'app.js'].filter((f) => !fs.existsSync(path.join(t.dir, f)));
    return { pass: !missing.length, detail: missing.length ? `missing ${missing.join(', ')}` : '' };
  });

  const fresh = () => t.newPage();
  let first;
  try { first = await fresh(); } catch (e) {
    await t.check('loads', 'Page loads', () => ({ pass: false, detail: String(e.message).slice(0, 160) }));
    return;
  }

  await t.check('ids-kept', 'Existing element ids are kept', async () => {
    const missing = await first.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), IDS);
    return { pass: !missing.length, detail: missing.length ? `missing #${missing.join(', #')}` : '' };
  });

  await t.check('add-works', 'Adding an expense still works (regression)', async () => {
    await add(first, { desc: 'Groceries', amount: 20, category: 'Food', date: '2026-01-10' });
    const got = await items(first);
    const ok = got.length === 1 && got[0].desc === 'Groceries' && got[0].amount === '$20.00' && got[0].date === '2026-01-10' && got[0].cat === 'Food';
    return { pass: ok, detail: JSON.stringify(got[0] || null) };
  });
  await t.screenshot(first, 'desktop');
  await first.context().close();

  await t.check('cents', 'Bug 1: 12.50 is saved as $12.50', async () => {
    const p = await fresh();
    await add(p, { desc: 'Coffee', amount: '12.50' });
    const got = await items(p);
    await p.context().close();
    return { pass: got[0]?.amount === '$12.50', detail: `shows ${got[0]?.amount ?? 'nothing'}` };
  });

  await t.check('delete-right', 'Bug 2: Delete removes the clicked expense (with a filter on)', async () => {
    const p = await fresh();
    await add(p, { desc: 'Alpha', amount: 3, category: 'Food', date: '2026-01-01' });
    await add(p, { desc: 'Bravo', amount: 4, category: 'Transport', date: '2026-01-03' });
    await add(p, { desc: 'Charlie', amount: 5, category: 'Food', date: '2026-01-02' });
    await filter(p, 'Food');
    const li = p.locator('#list .expense').filter({ has: p.locator('.desc', { hasText: /^Charlie$/ }) }).first();
    await li.locator('.del').click();
    await p.waitForTimeout(60);
    await filter(p, 'All');
    const left = (await items(p)).map((x) => x.desc).sort();
    await p.context().close();
    return { pass: JSON.stringify(left) === JSON.stringify(['Alpha', 'Bravo']), detail: `left: ${left.join(', ') || 'nothing'}` };
  });

  await t.check('persist', 'Bug 3: expenses survive a reload', async () => {
    const p = await fresh();
    await add(p, { desc: 'Rent', amount: 900, category: 'Housing' });
    await p.reload({ waitUntil: 'load' });
    await p.waitForTimeout(200);
    const got = await items(p);
    await p.context().close();
    return { pass: got.some((x) => x.desc === 'Rent'), detail: `${got.length} item(s) after reload` };
  });

  await t.check('filtered-total', 'Bug 4: Total matches the filtered list', async () => {
    const p = await fresh();
    await add(p, { desc: 'Pizza', amount: 10, category: 'Food' });
    await add(p, { desc: 'Bus', amount: 5, category: 'Transport' });
    await filter(p, 'Food');
    const food = (await p.textContent('#total')).trim();
    await filter(p, 'All');
    const all = (await p.textContent('#total')).trim();
    await p.context().close();
    return { pass: food === '$10.00' && all === '$15.00', detail: `Food filter: ${food}, All: ${all}` };
  });

  await t.check('escape', 'Bug 5: descriptions are shown as typed, never as HTML', async () => {
    const p = await fresh();
    await add(p, { desc: '<b>lunch</b>', amount: 9 });
    await add(p, { desc: '<img src="data:," onerror="window.__pwned=1">', amount: 2 });
    const descs = (await items(p)).map((x) => x.desc);
    const bold = await p.$$eval('#list b, #list img', (els) => els.length);
    const pwned = await p.evaluate(() => window.__pwned === 1);
    await p.context().close();
    return { pass: descs.includes('<b>lunch</b>') && bold === 0 && !pwned, detail: `texts: ${descs.join(' | ')}; injected elements: ${bold}; script ran: ${pwned}` };
  });

  await t.check('newest-first', 'Bug 6: newest expenses are at the top', async () => {
    const p = await fresh();
    await add(p, { desc: 'Jan', amount: 1, date: '2026-01-01' });
    await add(p, { desc: 'Mar', amount: 1, date: '2026-03-01' });
    await add(p, { desc: 'Feb', amount: 1, date: '2026-02-01' });
    const order = (await items(p)).map((x) => x.desc);
    await p.context().close();
    return { pass: order.join(',') === 'Mar,Feb,Jan', detail: order.join(', ') };
  });

  await t.check('reject-nonpositive', 'Bug 7: zero and negative amounts show the error', async () => {
    const p = await fresh();
    await add(p, { desc: 'Zero', amount: 0 });
    const e0 = await errorShown(p);
    await add(p, { desc: 'Negative', amount: -5 });
    const e1 = await errorShown(p);
    const n = (await items(p)).length;
    await p.context().close();
    return { pass: e0 && e1 && n === 0, detail: `error after 0: ${e0}, after -5: ${e1}, items added: ${n}` };
  });

  await t.check('empty-desc', 'Empty description still shows the error (regression)', async () => {
    const p = await fresh();
    await add(p, { desc: '', amount: 10 });
    const e = await errorShown(p);
    const n = (await items(p)).length;
    await p.context().close();
    return { pass: e && n === 0, detail: `error: ${e}, items: ${n}` };
  });

  await t.check('filter-works', 'Category filter shows only that category (regression)', async () => {
    const p = await fresh();
    await add(p, { desc: 'Taco', amount: 3, category: 'Food' });
    await add(p, { desc: 'Train', amount: 7, category: 'Transport' });
    await filter(p, 'Transport');
    const shown = (await items(p)).map((x) => x.desc);
    await p.context().close();
    return { pass: shown.join(',') === 'Train', detail: shown.join(', ') };
  });

  await t.check('by-category', 'Per-category totals still correct (regression)', async () => {
    const p = await fresh();
    await add(p, { desc: 'A', amount: 10, category: 'Food' });
    await add(p, { desc: 'B', amount: 4, category: 'Food' });
    await add(p, { desc: 'C', amount: 3, category: 'Fun' });
    await filter(p, 'Fun'); // per-category totals are for everything, whatever the filter
    const get = (c) => p.$eval(`#by-category [data-category="${c}"]`, (el) => el.textContent).catch(() => '');
    const food = await get('Food'); const fun = await get('Fun'); const tr = await get('Transport');
    await p.context().close();
    return { pass: food.includes('$14.00') && fun.includes('$3.00') && tr.includes('$0.00'), detail: `${food} · ${fun} · ${tr}` };
  });

  await t.check('no-external', 'No external requests', () => ({ pass: t.external.size === 0, detail: [...t.external].join(', ') }));
  await t.check('no-errors', 'No JavaScript errors', () => ({ pass: t.errors.length === 0, detail: t.errors.slice(0, 2).join(' | ') }));
}

// The seed (bugs intact) and a regression are the negative controls.
const BUGS = ['cents', 'delete-right', 'persist', 'filtered-total', 'escape', 'newest-first', 'reject-nonpositive'];
export const selftest = (edit) => [
  ['reference (all 7 fixed)', [], () => {}],
  ['seed, nothing fixed', BUGS, 'seed'],
  ['fixed but per-category totals dropped', ['by-category'], edit('app.js', 'byCategory.appendChild(li);', '')],
  ['fixed but #total renamed to #sum', ['ids-kept', 'filtered-total'], (dir) => {
    edit('index.html', '<strong id="total">', '<strong id="sum">')(dir);
    edit('app.js', "$('total')", "$('sum')")(dir);
  }],
];
