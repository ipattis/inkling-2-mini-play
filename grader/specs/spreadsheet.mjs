// Checks for tasks/spreadsheet/task.md, one per stated requirement.
import fs from 'node:fs';
import path from 'node:path';

export const id = 'spreadsheet';
export const title = 'Mini spreadsheet';

const sel = (a) => `[data-cell="${a}"]`;
const eqNum = (shown, n) => shown != null && shown !== '' && Math.abs(Number(String(shown).replace(/,/g, '')) - n) < 1e-9;

async function setCell(page, addr, text) {
  await page.click(sel(addr));
  await page.fill(sel(addr), text);
  await page.press(sel(addr), 'Enter');
  await page.waitForTimeout(40);
}
async function blur(page) {
  await page.evaluate(() => document.activeElement && document.activeElement !== document.body && document.activeElement.blur());
  await page.waitForTimeout(40);
}
async function show(page, addr) {
  await blur(page);
  return page.$eval(sel(addr), (el) => String(el.value ?? el.textContent ?? '').trim());
}
async function showMany(page, addrs) {
  await blur(page);
  return page.$$eval(addrs.map(sel).join(','), (els) => Object.fromEntries(els.map((el) => [el.dataset.cell, String(el.value ?? el.textContent ?? '').trim()])));
}
const report = (got, want) => Object.entries(want).map(([a, w]) => `${a}=${got[a] ?? '∅'}${String(got[a]) === String(w) ? '' : ` (want ${w})`}`).join(' ');

export async function run(t) {
  await t.check('files', 'index.html, styles.css and app.js exist', () => {
    const missing = ['index.html', 'styles.css', 'app.js'].filter((f) => !fs.existsSync(path.join(t.dir, f)));
    return { pass: !missing.length, detail: missing.length ? `missing ${missing.join(', ')}` : '' };
  });

  await t.check('no-eval', 'No eval() / new Function() (own parser)', () => {
    const js = fs.readdirSync(t.dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(t.dir, f), 'utf8')).join('\n');
    const hit = js.match(/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['"`]/);
    return { pass: !hit, detail: hit ? `found ${hit[0]}` : '' };
  });

  let page;
  try { page = await t.newPage(); } catch (e) {
    await t.check('loads', 'Page loads', () => ({ pass: false, detail: String(e.message).slice(0, 160) }));
    return;
  }

  // How a never-touched cell displays ('' for most apps, '0' for some). Clear is
  // judged against this, so "empty shows 0" isn't double-counted as a Clear bug.
  const emptyLook = await page.$eval(sel('H11'), (el) => String(el.value ?? el.textContent ?? '').trim()).catch(() => '');

  await t.check('grid', '8×12 grid of <input data-cell="A1"…"H12">', async () => {
    const cells = await page.$$eval('[data-cell]', (els) => els.map((el) => `${el.tagName}:${el.dataset.cell}`));
    const want = [];
    for (let r = 1; r <= 12; r++) for (const c of 'ABCDEFGH') want.push(`${c}${r}`);
    const got = new Set(cells.filter((x) => x.startsWith('INPUT:')).map((x) => x.slice(6).toUpperCase()));
    const missing = want.filter((a) => !got.has(a));
    return { pass: !missing.length && cells.length === 96, detail: `${cells.length} cells${missing.length ? `, missing ${missing.slice(0, 4).join(' ')}` : ''}` };
  });

  await t.check('values', 'Numbers and text show as entered', async () => {
    await setCell(page, 'A1', '5');
    await setCell(page, 'A2', 'hello');
    const got = await showMany(page, ['A1', 'A2']);
    return { pass: got.A1 === '5' && got.A2 === 'hello', detail: report(got, { A1: 5, A2: 'hello' }) };
  });

  await t.check('precedence', 'Arithmetic: precedence, parentheses, unary minus', async () => {
    await setCell(page, 'B1', '=2+3*4');
    await setCell(page, 'B2', '=(2+3)*4');
    await setCell(page, 'B3', '=-A1+10');
    await setCell(page, 'B4', '=2*-3');
    const got = await showMany(page, ['B1', 'B2', 'B3', 'B4']);
    const want = { B1: 14, B2: 20, B3: 5, B4: -6 };
    return { pass: Object.entries(want).every(([a, n]) => eqNum(got[a], n)), detail: report(got, want) };
  });

  await t.check('recalc', 'Changing a cell updates everything that depends on it', async () => {
    await setCell(page, 'C1', '=A1*2');
    await setCell(page, 'C2', '=C1+1');
    const before = await showMany(page, ['C1', 'C2']);
    await setCell(page, 'A1', '7');
    const after = await showMany(page, ['C1', 'C2']);
    return {
      pass: eqNum(before.C1, 10) && eqNum(before.C2, 11) && eqNum(after.C1, 14) && eqNum(after.C2, 15),
      detail: `before ${report(before, { C1: 10, C2: 11 })} · after A1=7 ${report(after, { C1: 14, C2: 15 })}`,
    };
  });

  await t.check('case', 'References are case-insensitive (=a1+1)', async () => {
    await setCell(page, 'C3', '=a1+1');
    const v = await show(page, 'C3');
    return { pass: eqNum(v, 8), detail: `C3=${v} (want 8)` };
  });

  await t.check('functions', 'SUM / AVG / MAX over ranges and argument lists', async () => {
    for (let i = 1; i <= 5; i++) await setCell(page, `D${i}`, String(i));
    await setCell(page, 'E1', '=SUM(D1:D5)');
    await setCell(page, 'E2', '=AVG(D1:D5)');
    await setCell(page, 'E3', '=MAX(D1:D5)');
    await setCell(page, 'E4', '=SUM(D1, D2, 10)');
    await setCell(page, 'E5', '=SUM(D1:D2, 4)');
    const got = await showMany(page, ['E1', 'E2', 'E3', 'E4', 'E5']);
    const want = { E1: 15, E2: 3, E3: 5, E4: 13, E5: 7 };
    return { pass: Object.entries(want).every(([a, n]) => eqNum(got[a], n)), detail: report(got, want) };
  });

  await t.check('empty-zero', 'Empty cells count as 0', async () => {
    await setCell(page, 'F1', '=H12+1');
    const v = await show(page, 'F1');
    return { pass: eqNum(v, 1), detail: `F1=${v} (want 1)` };
  });

  await t.check('float', 'No floating-point noise (=0.1+0.2 → 0.3)', async () => {
    await setCell(page, 'F2', '=0.1+0.2');
    const v = await show(page, 'F2');
    return { pass: v === '0.3', detail: `F2=${v}` };
  });

  await t.check('div0', '#DIV/0! for division by zero', async () => {
    await setCell(page, 'F3', '=1/0');
    const v = await show(page, 'F3');
    return { pass: v === '#DIV/0!', detail: `F3=${v}` };
  });

  await t.check('ref', '#REF! for references outside A1:H12', async () => {
    await setCell(page, 'F4', '=Z99+1');
    await setCell(page, 'F5', '=I1*2');
    const got = await showMany(page, ['F4', 'F5']);
    return { pass: got.F4 === '#REF!' && got.F5 === '#REF!', detail: report(got, { F4: '#REF!', F5: '#REF!' }) };
  });

  await t.check('circ', '#CIRC! in every cell of a cycle (and self-reference)', async () => {
    await setCell(page, 'G1', '=G2+1');
    await setCell(page, 'G2', '=G1+1');
    await setCell(page, 'G3', '=G3');
    const got = await showMany(page, ['G1', 'G2', 'G3']);
    const want = { G1: '#CIRC!', G2: '#CIRC!', G3: '#CIRC!' };
    return { pass: Object.entries(want).every(([a, w]) => got[a] === w), detail: report(got, want) };
  });

  await t.check('err', '#ERR! for bad syntax and text in arithmetic', async () => {
    await setCell(page, 'G4', '=2+*3');
    await setCell(page, 'G5', '=A2+1');
    const got = await showMany(page, ['G4', 'G5']);
    return { pass: got.G4 === '#ERR!' && got.G5 === '#ERR!', detail: report(got, { G4: '#ERR!', G5: '#ERR!' }) };
  });

  await t.check('propagate', 'Errors propagate to dependent formulas', async () => {
    await setCell(page, 'G6', '=F3+1');
    const v = await show(page, 'G6');
    return { pass: /^#/.test(v), detail: `G6=${v} (F3 is #DIV/0!)` };
  });

  await t.check('raw-on-focus', 'Focused cell shows the raw formula, blurred shows the value', async () => {
    await blur(page);
    await page.focus(sel('C1'));
    await page.waitForTimeout(40);
    const focused = await page.$eval(sel('C1'), (el) => el.value);
    const shown = await show(page, 'C1');
    return { pass: focused.replace(/\s/g, '').toUpperCase() === '=A1*2' && eqNum(shown, 14), detail: `focused "${focused}", blurred "${shown}"` };
  });

  await t.check('enter', 'Enter commits and moves to the cell below', async () => {
    await page.click(sel('H1'));
    await page.fill(sel('H1'), '42');
    await page.press(sel('H1'), 'Enter');
    await page.waitForTimeout(40);
    const active = await page.evaluate(() => document.activeElement?.dataset?.cell || document.activeElement?.tagName);
    const v = await show(page, 'H1');
    return { pass: String(active).toUpperCase() === 'H2' && eqNum(v, 42), detail: `focus → ${active}, H1=${v}` };
  });

  await t.check('persist', 'Sheet survives a reload (values and formulas)', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    const got = await showMany(page, ['A1', 'C1', 'C2', 'E1']);
    await page.focus(sel('C1'));
    const rawC1 = await page.$eval(sel('C1'), (el) => el.value);
    await blur(page);
    return {
      pass: eqNum(got.A1, 7) && eqNum(got.C1, 14) && eqNum(got.C2, 15) && eqNum(got.E1, 15) && rawC1.replace(/\s/g, '').toUpperCase() === '=A1*2',
      detail: `${report(got, { A1: 7, C1: 14, C2: 15, E1: 15 })}, C1 raw "${rawC1}"`,
    };
  });

  await t.check('clear', '"Clear" empties every cell and the saved sheet', async () => {
    const btn = page.getByRole('button', { name: /clear/i }).first();
    if (!(await btn.count())) return { pass: false, detail: 'no Clear button' };
    await btn.click();
    await page.waitForTimeout(100);
    const notBlank = (look) => page.$$eval('[data-cell]', (els, l) => els.filter((el) => String(el.value ?? el.textContent).trim() !== l).length, look);
    const rawOf = async (a) => { await page.focus(sel(a)); await page.waitForTimeout(30); const v = await page.$eval(sel(a), (el) => el.value); await blur(page); return v; };
    const left = await notBlank(emptyLook);
    const rawC1 = await rawOf('C1');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    const leftAfterReload = await notBlank(emptyLook);
    const rawC1After = await rawOf('C1');
    return {
      pass: left === 0 && leftAfterReload === 0 && rawC1 === '' && rawC1After === '',
      detail: `cells unlike an untouched one ("${emptyLook}"): ${left} after clear, ${leftAfterReload} after reload; C1 raw "${rawC1}" / "${rawC1After}"`,
    };
  });

  await t.screenshot(page, 'desktop');
  await page.context().close();

  await t.check('no-external', 'No external requests (no CDNs / libraries)', () => ({ pass: t.external.size === 0, detail: [...t.external].join(', ') }));
  await t.check('no-errors', 'No JavaScript errors', () => ({ pass: t.errors.length === 0, detail: t.errors.slice(0, 2).join(' | ') }));
}

// Negative controls for grader/selftest.mjs (applied to fixtures/spreadsheet/reference).
export const selftest = (edit) => [
  ['reference', [], () => {}],
  ['uses eval()', ['no-eval'], edit('app.js', 'function format(v) {', "const _unused = () => eval('1');\nfunction format(v) {")],
  ['float noise', ['float'], edit('app.js', "return String(parseFloat(v.toPrecision(12)));", 'return String(v);')],
  ['no #CIRC! code', ['circ'], edit('app.js', "if (stack.has(addr)) throw new SheetError('#CIRC!');", "if (stack.has(addr)) throw new SheetError('#ERR!');")],
  ['not saved', ['persist'], edit('app.js', 'localStorage.setItem(KEY, JSON.stringify(raw));', '')],
  ['Enter stays put', ['enter'], edit('app.js', 'if (below) below.focus(); else input.blur();', 'input.blur(); input.focus();')],
  ['#REF! missing', ['ref'], edit('app.js', "throw new SheetError('#REF!');", "throw new SheetError('#ERR!');")],
  // Positive control (Qwen's real behaviour): empty cells display "0"; Clear still works.
  ['empty cells show 0', [], edit('app.js', "if (v == null) return '';", "if (v == null) return '0';")],
  ['Clear keeps formulas', ['clear'], edit('app.js', 'for (const k of Object.keys(raw)) delete raw[k];', 'for (const k of Object.keys(raw)) if (!raw[k].startsWith("=")) delete raw[k];')],
];
