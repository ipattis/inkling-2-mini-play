'use strict';

/* ============================================================
 * Mini spreadsheet — no frameworks, no eval, custom parser.
 * ============================================================ */

const COLS = 'ABCDEFGH';
const ROWS = 12;
const STORAGE_KEY = 'mini-spreadsheet-sheet-v1';
const FUNC_NAMES = ['SUM', 'AVG', 'MAX'];

const ERR_DIV  = '#DIV/0!';
const ERR_REF  = '#REF!';
const ERR_CIRC = '#CIRC!';
const ERR_ERR  = '#ERR!';

/* ---- state ------------------------------------------------
 * state[addr]    : raw string the user typed ("" when empty)
 * computed[addr] : { kind: 'number' | 'text' | 'error', value }
 * ---------------------------------------------------------- */
let state = {};
let computed = {};
const cells = {}; // addr -> <input>

/* ============================================================
 * Value helpers
 * ============================================================ */

function numValue(v) {
  if (v.kind === 'error') throw new Error(v.value);
  if (v.kind === 'text') throw new Error(ERR_ERR);
  return v.value;
}

function round10(x) {
  return Math.round(x * 1e10) / 1e10;
}

function applyOp(op, a, b) {
  const x = numValue(a);
  const y = numValue(b);
  let r;
  switch (op) {
    case '+': r = x + y; break;
    case '-': r = x - y; break;
    case '*': r = x * y; break;
    case '/':
      if (y === 0) throw new Error(ERR_DIV);
      r = x / y;
      break;
    default: throw new Error(ERR_ERR);
  }
  if (!isFinite(r)) throw new Error(ERR_ERR);
  return { kind: 'number', value: round10(r) };
}

/* ============================================================
 * Tokenizer
 * ============================================================ */

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (text === '.' || (text.match(/\./g) || []).length > 1) {
        throw new Error(ERR_ERR);
      }
      toks.push({ t: 'num', v: parseFloat(text) });
      i = j;
    } else if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j).toUpperCase() });
      i = j;
    } else if ('+-*/(),:'.indexOf(c) !== -1) {
      toks.push({ t: c });
      i++;
    } else {
      throw new Error(ERR_ERR);
    }
  }
  toks.push({ t: 'end' });
  return toks;
}

/* ============================================================
 * Cell address helpers
 * ============================================================ */

function addrToRC(addr) {
  // addr like "B7" -> { c: 1, r: 6 } (0-based)
  const m = /^([A-Ha-h])([1-9][0-9]?)$/.exec(addr);
  if (!m) throw new Error(ERR_REF);
  const c = COLS.indexOf(m[1].toUpperCase());
  const r = parseInt(m[2], 10);
  if (c < 0 || r > ROWS) throw new Error(ERR_REF);
  return { c: c, r: r - 1 };
}

function rcToAddr(c, r) {
  return COLS.charAt(c) + (r + 1);
}

/* ============================================================
 * Parser / evaluator (recursive descent)
 *
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := ('-'|'+') factor | atom
 *   atom   := NUMBER | '(' expr ')' | FUNC '(' arglist ')' | cellref
 *   arg    := cellref ':' cellref | expr
 * ============================================================ */

class Parser {
  constructor(src, chain) {
    this.toks = tokenize(src);
    this.i = 0;
    this.chain = chain;
  }

  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }

  expect(t) {
    if (this.peek().t === t) return this.next();
    throw new Error(ERR_ERR);
  }

  parseTop() {
    const v = this.expr();
    if (this.peek().t !== 'end') throw new Error(ERR_ERR);
    return v;
  }

  expr() {
    let v = this.term();
    while (this.peek().t === '+' || this.peek().t === '-') {
      const op = this.next().t;
      v = applyOp(op, v, this.term());
    }
    return v;
  }

  term() {
    let v = this.factor();
    while (this.peek().t === '*' || this.peek().t === '/') {
      const op = this.next().t;
      v = applyOp(op, v, this.factor());
    }
    return v;
  }

  factor() {
    const t = this.peek();
    if (t.t === '-') {
      this.next();
      const v = this.factor();
      if (v.kind === 'number') return { kind: 'number', value: round10(-v.value) };
      return v; // error propagates; unary minus on text is an error
    }
    if (t.t === '+') {
      this.next();
      return this.factor();
    }
    return this.atom();
  }

  atom() {
    const t = this.next();
    if (t.t === 'num') return { kind: 'number', value: t.v };
    if (t.t === '(') {
      const v = this.expr();
      this.expect(')');
      return v;
    }
    if (t.t === 'ident') {
      if (this.peek().t === '(') return this.call(t.v);
      return this.ref(t.v);
    }
    throw new Error(ERR_ERR);
  }

  ref(name) {
    const rc = addrToRC(name); // throws #REF! for out-of-range / bad refs
    const addr = rcToAddr(rc.c, rc.r);
    return evalCell(addr, this.chain);
  }

  call(name) {
    this.expect('(');
    if (FUNC_NAMES.indexOf(name) === -1) throw new Error(ERR_ERR);

    const args = [];
    if (this.peek().t !== ')') {
      args.push(this.arg());
      while (this.peek().t === ',') {
        this.next();
        args.push(this.arg());
      }
    }
    this.expect(')');

    // Flatten arguments into a list of numbers.
    const nums = [];
    for (const a of args) {
      if (a.isRange) {
        const [c1, r1, c2, r2] = a.bounds;
        for (let c = c1; c <= c2; c++) {
          for (let r = r1; r <= r2; r++) {
            nums.push(numValue(evalCell(rcToAddr(c, r), this.chain)));
          }
        }
      } else {
        nums.push(numValue(a.value));
      }
    }

    if (name === 'SUM') {
      let s = 0;
      for (const n of nums) s += n;
      return { kind: 'number', value: round10(s) };
    }
    if (name === 'AVG') {
      if (nums.length === 0) throw new Error(ERR_ERR);
      let s = 0;
      for (const n of nums) s += n;
      return { kind: 'number', value: round10(s / nums.length) };
    }
    if (name === 'MAX') {
      if (nums.length === 0) throw new Error(ERR_ERR);
      let m = nums[0];
      for (const n of nums) if (n > m) m = n;
      return { kind: 'number', value: m };
    }
    throw new Error(ERR_ERR);
  }

  arg() {
    const t = this.peek();
    if (t.t === 'ident' && this.toks[this.i + 1] && this.toks[this.i + 1].t === ':') {
      this.next(); // ident
      const a = addrToRC(t.v);
      this.expect(':');
      const bTok = this.next();
      if (bTok.t !== 'ident') throw new Error(ERR_ERR);
      const b = addrToRC(bTok.v);
      return {
        isRange: true,
        bounds: [Math.min(a.c, b.c), Math.min(a.r, b.r), Math.max(a.c, b.c), Math.max(a.r, b.r)]
      };
    }
    return { isRange: false, value: this.expr() };
  }
}

/* ============================================================
 * Per-cell evaluation
 * ============================================================ */

function evalCell(addr, chain) {
  const raw = state[addr] !== undefined ? state[addr] : '';

  if (raw === '') return { kind: 'number', value: 0 };

  if (raw.charAt(0) !== '=') {
    const trimmed = raw.trim();
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
      return { kind: 'number', value: parseFloat(trimmed) };
    }
    return { kind: 'text', value: raw };
  }

  if (chain.has(addr)) throw new Error(ERR_CIRC);
  const nextChain = new Set(chain);
  nextChain.add(addr);

  const p = new Parser(raw.slice(1), nextChain);
  return p.parseTop();
}

function recalcAll() {
  for (let c = 0; c < COLS.length; c++) {
    for (let r = 0; r < ROWS; r++) {
      const addr = rcToAddr(c, r);
      let v;
      try {
        v = evalCell(addr, new Set());
      } catch (e) {
        v = { kind: 'error', value: e && typeof e.message === 'string' ? e.message : ERR_ERR };
      }
      computed[addr] = v;
    }
  }
}

/* ============================================================
 * Display
 * ============================================================ */

function formatValue(v) {
  if (v.kind === 'number') {
    const n = round10(v.value);
    return String(Object.is(n, -0) ? 0 : n);
  }
  return v.value;
}

function paintCell(addr) {
  const input = cells[addr];
  const v = computed[addr];
  input.value = formatValue(v);
  input.classList.toggle('text', v.kind === 'text');
  input.classList.toggle('error', v.kind === 'error');
}

function paintAll() {
  for (const addr in cells) {
    if (document.activeElement === cells[addr]) continue; // keep raw content while editing
    paintCell(addr);
  }
}

/* ============================================================
 * Persistence
 * ============================================================ */

function save() {
  const clean = {};
  for (const addr in state) {
    if (state[addr] !== '') clean[addr] = state[addr];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch (e) { /* storage unavailable — ignore */ }
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (data && typeof data === 'object') {
      for (const addr in data) {
        try {
          addrToRC(addr);
        } catch (e) {
          continue; // ignore invalid addresses from old/broken saves
        }
        if (typeof data[addr] === 'string') state[addr] = data[addr];
      }
    }
  } catch (e) { /* corrupted save — start fresh */ }
}

/* ============================================================
 * Editing
 * ============================================================ */

function commit(addr) {
  const input = cells[addr];
  const raw = input.value.trim();
  if (raw === (state[addr] || '')) return;
  if (raw === '') delete state[addr];
  else state[addr] = raw;
  save();
  recalcAll();
  paintAll();
}

function focusCell(addr) {
  const input = cells[addr];
  input.value = state[addr] || ''; // show raw content while editing
  input.focus();
}

function onEnter(e, addr) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  commit(addr);
  const addrRe = /^([A-H])(\d+)$/.exec(addr);
  const row = parseInt(addrRe[2], 10);
  if (row < ROWS) {
    focusCell(addrRe[1] + (row + 1));
    // The old cell is no longer focused — show its computed value again.
    paintCell(addr);
  }
}

/* ============================================================
 * Building the DOM
 * ============================================================ */

function buildGrid() {
  const table = document.createElement('table');
  table.className = 'sheet';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  headRow.appendChild(corner);
  for (const c of COLS) {
    const th = document.createElement('th');
    th.textContent = c;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  for (let r = 1; r <= ROWS; r++) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = String(r);
    tr.appendChild(th);
    for (const c of COLS) {
      const addr = c + r;
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.cell = addr;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'cell ' + addr);

      input.addEventListener('focus', function () {
        this.value = state[addr] || '';
      });
      input.addEventListener('blur', function () {
        commit(addr);
      });
      input.addEventListener('keydown', function (e) {
        onEnter(e, addr);
      });

      cells[addr] = input;
      tr.appendChild(input);
    }
    tbody.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  document.getElementById('grid').appendChild(table);
}

document.getElementById('clear').addEventListener('click', function () {
  if (document.activeElement && document.activeElement.classList) {
    document.activeElement.blur();
  }
  state = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) { /* ignore */ }
  recalcAll();
  paintAll();
});

/* ============================================================
 * Init
 * ============================================================ */

buildGrid();
load();
recalcAll();
paintAll();
