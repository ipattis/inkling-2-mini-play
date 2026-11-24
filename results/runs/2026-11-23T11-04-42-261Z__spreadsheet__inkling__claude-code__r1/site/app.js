(() => {
'use strict';

const COLS = 8;
const ROWS = 12;
const COL_LETTERS = 'ABCDEFGH';
const LS_KEY = 'mini-spreadsheet-v1';

const sheetEl = document.getElementById('sheet');
const clearBtn = document.getElementById('clear-btn');

// ---------- storage ----------
function loadStored() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    return {};
  }
}
let stored = loadStored();

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(stored));
  } catch (e) { /* storage unavailable */ }
}

function cellAddress(col, row) {
  return COL_LETTERS[col - 1] + row; // col: 1..8, row: 1..12
}

// ---------- build grid ----------
function buildGrid() {
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner-cell';
  corner.scope = 'col';
  headRow.appendChild(corner);
  for (let c = 1; c <= COLS; c++) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = COL_LETTERS[c - 1];
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  sheetEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 1; r <= ROWS; r++) {
    const tr = document.createElement('tr');
    const rowHead = document.createElement('td');
    rowHead.className = 'row-header';
    rowHead.textContent = r;
    rowHead.setAttribute('scope', 'row');
    tr.appendChild(rowHead);
    for (let c = 1; c <= COLS; c++) {
      const addr = cellAddress(c, r);
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cell';
      input.dataset.cell = addr;
      input.setAttribute('aria-label', 'Cell ' + addr);
      input.spellcheck = false;
      td.appendChild(input);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  sheetEl.appendChild(tbody);
}

// ---------- formula parser ----------
class ParseError extends Error {
  constructor(msg) { super(msg); this.code = '#ERR!'; }
}
class EvalError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = src.slice(i).match(/^(\d+(\.\d*)?|\.\d+)/);
      if (!m) throw new ParseError('bad number');
      tokens.push({ type: 'num', value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z]+\d+|^[A-Za-z]+/);
      const text = m[0];
      if (/^[A-Za-z]+\d+$/.test(text)) {
        tokens.push({ type: 'ref', value: text.toUpperCase() });
      } else {
        const upper = text.toUpperCase();
        if (upper === 'SUM' || upper === 'AVG' || upper === 'MAX') {
          tokens.push({ type: 'func', value: upper });
        } else {
          throw new ParseError('unknown function ' + text);
        }
      }
      i += text.length;
      continue;
    }
    if ('+-*/(),:'.includes(c)) {
      tokens.push({ type: c, value: c });
      i++;
      continue;
    }
    throw new ParseError('unexpected character ' + c);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];
  const expect = (type) => {
    if (peek().type !== type) {
      throw new ParseError('expected ' + type + ' got ' + peek().type);
    }
    return advance();
  };

  function parseExpr() {
    let node = parseTerm();
    for (;;) {
      if (peek().type === '+' || peek().type === '-') {
        const op = advance().type;
        node = { type: 'bin', op, left: node, right: parseTerm() };
      } else return node;
    }
  }

  function parseTerm() {
    let node = parseUnary();
    for (;;) {
      if (peek().type === '*' || peek().type === '/') {
        const op = advance().type;
        node = { type: 'bin', op, left: node, right: parseUnary() };
      } else return node;
    }
  }

  function parseUnary() {
    if (peek().type === '-') { advance(); return { type: 'neg', arg: parseUnary() }; }
    if (peek().type === '+') { advance(); return parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (tok.type === 'num') { advance(); return { type: 'num', value: tok.value }; }
    if (tok.type === 'ref') {
      advance();
      if (peek().type === ':') {
        advance();
        const end = expect('ref');
        return { type: 'range', start: tok.value, end: end.value };
      }
      return { type: 'ref', value: tok.value };
    }
    if (tok.type === 'func') {
      advance();
      const name = tok.value;
      expect('(');
      const args = [];
      if (peek().type !== ')') {
        args.push(parseExpr());
        for (;;) {
          if (peek().type === ',') { advance(); args.push(parseExpr()); continue; }
          break;
        }
      }
      expect(')');
      return { type: 'call', name, args };
    }
    if (tok.type === '(') {
      advance();
      const node = parseExpr();
      expect(')');
      return node;
    }
    throw new ParseError('unexpected token ' + tok.type);
  }

  const node = parseExpr();
  if (peek().type !== 'eof') throw new ParseError('unexpected trailing token ' + peek().type);
  return node;
}

// ---------- evaluation ----------
let cache = new Map();
const visiting = new Set();

function normalizeRange(a, b) {
  // a, b like 'A1'. Return {c0, r0, c1, r1} min/max.
  const colOf = (s) => s.charCodeAt(0) - 64;
  const rowOf = (s) => parseInt(s.slice(1), 10);
  const c0 = colOf(a), r0 = rowOf(a), c1 = colOf(b), r1 = rowOf(b);
  return {
    c0: Math.min(c0, c1), r0: Math.min(r0, r1),
    c1: Math.max(c0, c1), r1: Math.max(r0, r1),
  };
}

function parseNumberCell(raw) {
  const trimmed = raw.trim();
  if (/^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function evalCell(address) {
  const addr = address.toUpperCase();
  if (cache.has(addr)) return cache.get(addr);

  const raw = (stored[addr] || '');
  const trimmed = raw.trim();

  if (trimmed === '') {
    const res = { type: 'empty' };
    cache.set(addr, res);
    return res;
  }

  if (!trimmed.startsWith('=')) {
    const num = parseNumberCell(trimmed);
    const res = num !== null
      ? { type: 'num', value: num }
      : { type: 'text', value: trimmed };
    cache.set(addr, res);
    return res;
  }

  if (visiting.has(addr)) {
    throw new EvalError('#CIRC!');
  }

  visiting.add(addr);
  try {
    const tokens = tokenize(trimmed.slice(1));
    const ast = parse(tokens);
    const value = requireNumber(evalNode(ast));
    const res = { type: 'num', value };
    cache.set(addr, res);
    return res;
  } catch (e) {
    const code = (e && e.code) ? e.code : '#ERR!';
    const res = { type: 'error', value: code };
    cache.set(addr, res);
    return res;
  } finally {
    visiting.delete(addr);
  }
}

function requireNumber(v) {
  if (Array.isArray(v)) throw new EvalError('#ERR!'); // range used as scalar
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new EvalError('#ERR!');
  return v;
}

function refValue(addr) {
  const m = /^([A-H])([0-9]{1,2})$/.exec(addr);
  if (!m) throw new EvalError('#REF!');
  const col = m[1].charCodeAt(0) - 64;
  const row = parseInt(m[2], 10);
  if (col < 1 || col > COLS || row < 1 || row > ROWS) throw new EvalError('#REF!');
  const cell = evalCell(addr);
  if (cell.type === 'error') throw new EvalError(cell.value);
  if (cell.type === 'text') throw new EvalError('#ERR!');
  if (cell.type === 'empty') return 0;
  return cell.value;
}

function rangeValues(start, end) {
  const r = normalizeRange(start, end);
  if (r.c0 < 1 || r.c0 > COLS || r.r0 < 1 || r.r0 > ROWS ||
      r.c1 < 1 || r.c1 > COLS || r.r1 < 1 || r.r1 > ROWS) {
    throw new EvalError('#REF!');
  }
  const values = [];
  for (let row = r.r0; row <= r.r1; row++) {
    for (let col = r.c0; col <= r.c1; col++) {
      const cell = evalCell(cellAddress(col, row));
      if (cell.type === 'error') throw new EvalError(cell.value);
      if (cell.type === 'text') throw new EvalError('#ERR!');
      if (cell.type === 'empty') { values.push(0); continue; }
      values.push(cell.value);
    }
  }
  return values;
}

function evalNode(node) {
  switch (node.type) {
    case 'num':
      return node.value;

    case 'ref':
      return refValue(node.value);

    case 'range':
      return rangeValues(node.start, node.end);

    case 'neg': {
      const v = requireNumber(evalNode(node.arg));
      return -v;
    }

    case 'bin': {
      const l = requireNumber(evalNode(node.left));
      const r = requireNumber(evalNode(node.right));
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      if (node.op === '/') {
        if (r === 0) throw new EvalError('#DIV/0!');
        return l / r;
      }
      throw new EvalError('#ERR!');
    }

    case 'call': {
      const values = [];
      for (const arg of node.args) {
        const v = evalNode(arg);
        if (Array.isArray(v)) {
          for (const x of v) values.push(x);
        } else {
          values.push(requireNumber(v));
        }
      }
      if (values.length === 0) throw new EvalError('#ERR!');
      if (node.name === 'SUM') {
        return values.reduce((s, x) => s + x, 0);
      }
      if (node.name === 'AVG') {
        const sum = values.reduce((s, x) => s + x, 0);
        return sum / values.length;
      }
      if (node.name === 'MAX') {
        return Math.max(...values);
      }
      throw new EvalError('#ERR!');
    }

    default:
      throw new EvalError('#ERR!');
  }
}

// ---------- formatting ----------
function formatNumber(n) {
  const rounded = parseFloat(n.toPrecision(12));
  return String(rounded);
}

// ---------- rendering ----------
function recalcAndRender(focusTarget) {
  cache = new Map();
  visiting.clear();
  const inputs = sheetEl.querySelectorAll('input.cell');
  const active = document.activeElement;

  for (const input of inputs) {
    if (input === active) continue;
    const addr = input.dataset.cell;
    const res = evalCell(addr);
    if (res.type === 'empty') {
      input.value = '';
      input.className = 'cell';
    } else if (res.type === 'num') {
      input.value = formatNumber(res.value);
      input.className = 'cell num';
    } else if (res.type === 'text') {
      input.value = res.value;
      input.className = 'cell';
    } else {
      input.value = res.value;
      input.className = 'cell error';
    }
  }

  if (focusTarget) {
    const f = sheetEl.querySelector(`input[data-cell="${focusTarget}"]`);
    if (f) f.focus();
  }
}

function commitInput(input) {
  const addr = input.dataset.cell;
  const raw = input.value;
  if (raw.trim() === '') {
    delete stored[addr];
  } else {
    stored[addr] = raw;
  }
  save();
  recalcAndRender();
}

// ---------- events ----------
function wireEvents() {
  sheetEl.addEventListener('focusin', (e) => {
    const input = e.target;
    if (!input || input.tagName !== 'INPUT') return;
    const addr = input.dataset.cell;
    const raw = stored[addr] || '';
    input.value = raw;
    input.className = 'cell';
    // move caret to end
    requestAnimationFrame(() => {
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (err) {}
    });
  });

  sheetEl.addEventListener('keydown', (e) => {
    const input = e.target;
    if (!input || input.tagName !== 'INPUT') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const addr = input.dataset.cell;
      const m = /^([A-H])([0-9]{1,2})$/.exec(addr);
      const col = m[1];
      const row = parseInt(m[2], 10);
      commitInput(input);
      if (row < ROWS) {
        const target = col + (row + 1);
        const next = sheetEl.querySelector(`input[data-cell="${target}"]`);
        if (next) next.focus();
      }
    }
  });

  sheetEl.addEventListener('focusout', (e) => {
    const input = e.target;
    if (!input || input.tagName !== 'INPUT') return;
    commitInput(input);
  });

  clearBtn.addEventListener('click', () => {
    stored = {};
    save();
    recalcAndRender();
  });
}

// ---------- init ----------
buildGrid();
wireEvents();
recalcAndRender();

})();
