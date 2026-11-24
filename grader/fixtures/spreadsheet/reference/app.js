// Known-good reference for the spreadsheet task (used by grader/selftest.mjs).
const COLS = 'ABCDEFGH';
const ROWS = 12;
const KEY = 'reference-sheet';
const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
const inputs = {};

class SheetError extends Error { constructor(code) { super(code); this.code = code; } }

// ---------------------------------------------------------------- grid
const grid = document.getElementById('grid');
const head = grid.insertRow();
head.appendChild(document.createElement('th'));
for (const c of COLS) { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); }
for (let r = 1; r <= ROWS; r++) {
  const tr = grid.insertRow();
  const th = document.createElement('th'); th.textContent = r; tr.appendChild(th);
  for (const c of COLS) {
    const addr = `${c}${r}`;
    const input = document.createElement('input');
    input.dataset.cell = addr;
    input.addEventListener('focus', () => { input.value = raw[addr] || ''; });
    input.addEventListener('blur', () => commit(addr, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit(addr, input.value);
      const below = inputs[`${c}${r + 1}`];
      if (below) below.focus(); else input.blur();
    });
    inputs[addr] = input;
    const td = tr.insertCell();
    td.appendChild(input);
  }
}

function commit(addr, text) {
  if (text === '') delete raw[addr]; else raw[addr] = text;
  localStorage.setItem(KEY, JSON.stringify(raw));
  renderAll();
}

document.getElementById('clear').addEventListener('click', () => {
  for (const k of Object.keys(raw)) delete raw[k];
  localStorage.removeItem(KEY);
  renderAll();
});

// ---------------------------------------------------------------- evaluation
const NUM = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
let cache = {};

function valueOf(addr, stack) {
  if (addr in cache) return cache[addr];
  const text = raw[addr];
  let v;
  if (text == null || text === '') v = null;
  else if (text.startsWith('=')) {
    if (stack.has(addr)) throw new SheetError('#CIRC!');
    stack.add(addr);
    try { v = evaluate(text.slice(1), stack); } catch (e) { v = { error: e.code || '#ERR!' }; }
    stack.delete(addr);
  } else if (NUM.test(text)) v = Number(text);
  else v = text;
  cache[addr] = v;
  return v;
}

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+\.?\d*|\.\d+)|([A-Za-z]+\d+)|([A-Za-z]+)|(.))/y;
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[0].trim() === '') break;
    if (m[1]) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) out.push({ t: 'ref', v: m[2].toUpperCase() });
    else if (m[3]) out.push({ t: 'name', v: m[3].toUpperCase() });
    else out.push({ t: 'op', v: m[4] });
  }
  return out;
}

function checkRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m || m[1].length !== 1 || !COLS.includes(m[1]) || +m[2] < 1 || +m[2] > ROWS) throw new SheetError('#REF!');
  return ref;
}

function num(v) {
  if (v && v.error) throw new SheetError(v.error);
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  throw new SheetError('#ERR!');
}

function evaluate(src, stack) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const eat = (v) => { if (toks[i] && toks[i].v === v) { i++; return true; } return false; };
  // Re-entering a cell that is still being evaluated throws #CIRC!; every cell
  // on the cycle catches it in valueOf() and reports #CIRC! itself.
  const refValue = (ref) => valueOf(checkRef(ref), stack);
  function expr() {
    let v = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) { const op = toks[i++].v; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() && (peek().v === '*' || peek().v === '/')) {
      const op = toks[i++].v; const r = factor();
      if (op === '/' && r === 0) throw new SheetError('#DIV/0!');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function factor() {
    if (eat('-')) return -factor();
    if (eat('+')) return factor();
    return primary();
  }
  function primary() {
    const t = toks[i++];
    if (!t) throw new SheetError('#ERR!');
    if (t.t === 'num') return t.v;
    if (t.t === 'ref') return num(refValue(t.v));
    if (t.t === 'name') {
      if (!eat('(')) throw new SheetError('#ERR!');
      const vals = [];
      if (!eat(')')) {
        do { vals.push(...arg()); } while (eat(','));
        if (!eat(')')) throw new SheetError('#ERR!');
      }
      if (t.v === 'SUM') return vals.reduce((a, b) => a + b, 0);
      if (t.v === 'AVG') { if (!vals.length) throw new SheetError('#DIV/0!'); return vals.reduce((a, b) => a + b, 0) / vals.length; }
      if (t.v === 'MAX') { if (!vals.length) return 0; return Math.max(...vals); }
      throw new SheetError('#ERR!');
    }
    if (t.v === '(') { const v = expr(); if (!eat(')')) throw new SheetError('#ERR!'); return v; }
    throw new SheetError('#ERR!');
  }
  function arg() {
    if (peek()?.t === 'ref' && toks[i + 1]?.v === ':') {
      const a = checkRef(toks[i].v); i += 2;
      const bt = toks[i++];
      if (!bt || bt.t !== 'ref') throw new SheetError('#ERR!');
      const b = checkRef(bt.v);
      const [c1, c2] = [a[0], b[0]].map((c) => COLS.indexOf(c)).sort((x, y) => x - y);
      const [r1, r2] = [+a.slice(1), +b.slice(1)].sort((x, y) => x - y);
      const out = [];
      for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) out.push(num(refValue(`${COLS[c]}${r}`)));
      return out;
    }
    return [expr()];
  }
  const v = expr();
  if (i !== toks.length) throw new SheetError('#ERR!');
  if (!Number.isFinite(v)) throw new SheetError('#ERR!');
  return v;
}

function format(v) {
  if (v == null) return '';
  if (v.error) return v.error;
  if (typeof v === 'number') return String(parseFloat(v.toPrecision(12)));
  return String(v);
}

function renderAll() {
  cache = {};
  for (const [addr, input] of Object.entries(inputs)) {
    const v = valueOf(addr, new Set());
    if (document.activeElement !== input) input.value = format(v);
  }
}

renderAll();
