'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const MIN_ROW = 1;
const MAX_ROW = 12;
const STORAGE_KEY = 'mini-spreadsheet-sheet-v1';
const FUNCTIONS = new Set(['SUM', 'AVG', 'MAX']);
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// cells: address (e.g. "B3") -> raw text the user entered ("" is absent).
// A formula is any raw text starting with "=".
const cells = Object.create(null);
// inputs: address -> the <input> element for that cell.
const inputs = Object.create(null);

// ---------------------------------------------------------------------------
// Formula errors
// ---------------------------------------------------------------------------
class FormulaError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // one of "#REF!", "#ERR!", ...
  }
}
const fe = (code) => new FormulaError(code);

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------
const gridEl = document.getElementById('grid');

function buildGrid() {
  const frag = document.createDocumentFragment();

  const corner = document.createElement('div');
  corner.className = 'header corner';
  frag.appendChild(corner);

  for (const col of COLS) {
    const h = document.createElement('div');
    h.className = 'header col-header';
    h.textContent = col;
    frag.appendChild(h);
  }

  for (let row = MIN_ROW; row <= MAX_ROW; row++) {
    const rh = document.createElement('div');
    rh.className = 'header row-header';
    rh.textContent = row;
    frag.appendChild(rh);

    for (const col of COLS) {
      const addr = col + row;
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.cell = addr; // -> data-cell="A1"
      input.autocomplete = 'off';
      input.spellcheck = false;
      wireCell(addr, input);
      inputs[addr] = input;
      frag.appendChild(input);
    }
  }

  gridEl.appendChild(frag);
}

function wireCell(addr, input) {
  // While a cell is focused it shows the raw content that was entered.
  input.addEventListener('focus', () => {
    input.value = cells[addr] || '';
  });

  // An edit is committed when the cell loses focus.
  input.addEventListener('blur', () => commitCell(addr));

  // Enter also commits, and moves focus to the cell below.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitCell(addr);
    const below = cellBelow(addr);
    if (below && inputs[below]) inputs[below].focus();
  });
}

function cellBelow(addr) {
  const row = Number(addr.slice(1)) + 1;
  if (row > MAX_ROW) return null;
  return addr[0] + row;
}

function commitCell(addr) {
  const raw = inputs[addr].value.trim();
  if (raw === '') delete cells[addr];
  else cells[addr] = raw;
  saveSheet();
  refreshAll();
}

// ---------------------------------------------------------------------------
// Recalculation and display
// ---------------------------------------------------------------------------

// Re-evaluates every cell (which necessarily covers every cell that depends,
// directly or transitively, on the one that changed) and updates the inputs
// that are not currently being edited.
function refreshAll() {
  const results = evaluateAll();
  for (const addr of Object.keys(inputs)) {
    const input = inputs[addr];
    if (document.activeElement === input) continue; // editing: show raw
    const result = results[addr];
    input.value = displayOf(result);
    input.classList.toggle('numeric', isNumberResult(result));
    input.classList.toggle('error', Boolean(result && result.error));
  }
}

function evaluateAll() {
  const memo = Object.create(null);
  const visiting = new Set();

  function evalCell(addr) {
    if (addr in memo) return memo[addr];
    if (visiting.has(addr)) return { error: '#CIRC!' }; // back edge of a cycle
    visiting.add(addr);
    const result = evalRaw(cells[addr] || '', evalCell);
    visiting.delete(addr);
    memo[addr] = result;
    return result;
  }

  const results = Object.create(null);
  for (const addr of Object.keys(inputs)) results[addr] = evalCell(addr);
  return results;
}

// Compute the result for one cell's raw content.
// Returns { value: number|string } on success or { error: "#..." } on failure.
function evalRaw(raw, evalCell) {
  if (raw === '') return { value: 0 }; // empty cells count as 0
  if (raw[0] === '=') {
    try {
      const ast = parseFormula(raw.slice(1));
      return evalNode(ast, evalCell);
    } catch (err) {
      if (err instanceof FormulaError) return { error: err.code };
      throw err;
    }
  }
  if (NUMBER_RE.test(raw)) return { value: Number(raw) };
  return { value: raw }; // plain text
}

function isNumberResult(result) {
  return Boolean(result) && !result.error && typeof result.value === 'number';
}

function displayOf(result) {
  if (!result) return '';
  if (result.error) return result.error;
  return typeof result.value === 'number' ? formatNumber(result.value) : String(result.value);
}

// Strip floating-point noise: 0.30000000000000004 -> "0.3".
function formatNumber(n) {
  if (n === 0) return '0'; // also normalises -0
  return String(Number(n.toPrecision(12)));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let seenDot = false;
      while (j < source.length) {
        const c = source[j];
        if (c >= '0' && c <= '9') j++;
        else if (c === '.' && !seenDot) { seenDot = true; j++; }
        else break;
      }
      const text = source.slice(i, j);
      if (!/\d/.test(text)) throw fe('#ERR!');
      tokens.push({ type: 'num', value: Number(text) });
      i = j;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let j = i;
      while (
        j < source.length &&
        ((source[j] >= 'a' && source[j] <= 'z') ||
          (source[j] >= 'A' && source[j] <= 'Z') ||
          (source[j] >= '0' && source[j] <= '9'))
      ) {
        j++;
      }
      const text = source.slice(i, j);
      const m = /^([A-Za-z]+)(\d+)$/.exec(text);
      if (m) {
        tokens.push({ type: 'ref', col: m[1].toUpperCase(), row: Number(m[2]) });
      } else if (/^[A-Za-z]+$/.test(text)) {
        tokens.push({ type: 'name', value: text.toUpperCase() });
      } else {
        throw fe('#ERR!');
      }
      i = j;
      continue;
    }
    if ('+-*/(),:'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    throw fe('#ERR!');
  }
  tokens.push({ type: 'end' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
//
//   expression := term (('+' | '-') term)*
//   term       := factor (('*' | '/') factor)*
//   factor     := ('-' | '+') factor | primary
//   primary    := number | ref | call | '(' expression ')'
//   call       := NAME '(' arg (',' arg)* ')'
//   arg        := ref ':' ref | expression
// ---------------------------------------------------------------------------
function parseFormula(source) {
  const parser = new Parser(tokenize(source));
  const ast = parser.parseExpression();
  if (parser.peek().type !== 'end') throw fe('#ERR!');
  return ast;
}

// Validate a reference token against the A1:H12 range.
function refAddress(tok) {
  const col = tok.col;
  const row = tok.row;
  if (col.length !== 1 || !COLS.includes(col) || row < MIN_ROW || row > MAX_ROW) {
    throw fe('#REF!');
  }
  return col + row;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    return this.tokens[this.pos++];
  }
  peekOp(op) {
    const t = this.peek();
    return t.type === 'op' && t.value === op;
  }
  expectOp(op) {
    const t = this.next();
    if (t.type !== 'op' || t.value !== op) throw fe('#ERR!');
  }
  parseExpression() {
    let node = this.parseTerm();
    while (this.peekOp('+') || this.peekOp('-')) {
      const op = this.next().value;
      node = { kind: 'binary', op, left: node, right: this.parseTerm() };
    }
    return node;
  }
  parseTerm() {
    let node = this.parseFactor();
    while (this.peekOp('*') || this.peekOp('/')) {
      const op = this.next().value;
      node = { kind: 'binary', op, left: node, right: this.parseFactor() };
    }
    return node;
  }
  parseFactor() {
    if (this.peekOp('-') || this.peekOp('+')) {
      const op = this.next().value;
      return { kind: 'unary', op, operand: this.parseFactor() };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.next();
    if (t.type === 'num') return { kind: 'number', value: t.value };
    if (t.type === 'ref') return { kind: 'ref', address: refAddress(t) };
    if (t.type === 'name') {
      if (!FUNCTIONS.has(t.value) || !this.peekOp('(')) throw fe('#ERR!');
      this.next(); // consume "("
      const args = [];
      if (!this.peekOp(')')) {
        args.push(this.parseArg());
        while (this.peekOp(',')) {
          this.next();
          args.push(this.parseArg());
        }
      }
      this.expectOp(')');
      return { kind: 'call', name: t.value, args };
    }
    if (t.type === 'op' && t.value === '(') {
      const inner = this.parseExpression();
      this.expectOp(')');
      return inner;
    }
    throw fe('#ERR!');
  }
  parseArg() {
    const t = this.peek();
    if (t.type === 'ref') {
      this.next();
      if (this.peekOp(':')) {
        this.next();
        const endTok = this.next();
        if (endTok.type !== 'ref') throw fe('#ERR!');
        return { kind: 'range', from: refAddress(t), to: refAddress(endTok) };
      }
      return { kind: 'ref', address: refAddress(t) };
    }
    return this.parseExpression();
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------
function numResult(value) {
  return Number.isFinite(value) ? { value } : { error: '#ERR!' };
}

function evalNode(node, evalCell) {
  switch (node.kind) {
    case 'number':
      return { value: node.value };

    case 'ref':
      return evalCell(node.address);

    case 'unary': {
      const operand = evalNode(node.operand, evalCell);
      if (operand.error) return operand;
      if (typeof operand.value === 'string') return { error: '#ERR!' };
      return numResult(node.op === '-' ? -operand.value : operand.value);
    }

    case 'binary': {
      const left = evalNode(node.left, evalCell);
      if (left.error) return left;
      const right = evalNode(node.right, evalCell);
      if (right.error) return right;
      if (typeof left.value === 'string' || typeof right.value === 'string') {
        return { error: '#ERR!' }; // text in arithmetic
      }
      switch (node.op) {
        case '+': return numResult(left.value + right.value);
        case '-': return numResult(left.value - right.value);
        case '*': return numResult(left.value * right.value);
        case '/':
          if (right.value === 0) return { error: '#DIV/0!' };
          return numResult(left.value / right.value);
      }
      return { error: '#ERR!' };
    }

    case 'call':
      return evalCall(node, evalCell);
  }
  return { error: '#ERR!' };
}

function evalCall(node, evalCell) {
  const values = [];
  for (const arg of node.args) {
    if (arg.kind === 'range') {
      for (const addr of rangeCells(arg.from, arg.to)) {
        const r = evalCell(addr);
        if (r.error) return r; // errors propagate
        if (typeof r.value === 'number') values.push(r.value);
      }
    } else {
      const r = evalNode(arg, evalCell);
      if (r.error) return r;
      if (typeof r.value === 'number') values.push(r.value);
    }
  }
  if (values.length === 0) return { error: '#ERR!' };
  const sum = values.reduce((a, b) => a + b, 0);
  switch (node.name) {
    case 'SUM': return numResult(sum);
    case 'AVG': return numResult(sum / values.length);
    case 'MAX': return numResult(Math.max(...values));
  }
  return { error: '#ERR!' };
}

// Expand a (validated) rectangular range into addresses, row by row.
function rangeCells(from, to) {
  const c1 = COLS.indexOf(from[0]);
  const r1 = Number(from.slice(1));
  const c2 = COLS.indexOf(to[0]);
  const r2 = Number(to.slice(1));
  const loC = Math.min(c1, c2);
  const hiC = Math.max(c1, c2);
  const loR = Math.min(r1, r2);
  const hiR = Math.max(r1, r2);
  const out = [];
  for (let r = loR; r <= hiR; r++) {
    for (let c = loC; c <= hiC; c++) out.push(COLS[c] + r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function saveSheet() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cells));
  } catch (err) {
    // Storage unavailable (private mode, quota): the sheet simply is not saved.
  }
}

function loadSheet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        if (typeof data[key] === 'string' && data[key] !== '') cells[key] = data[key];
      }
    }
  } catch (err) {
    // Corrupted or unavailable storage: start with an empty sheet.
  }
}

function clearSheet() {
  for (const key of Object.keys(cells)) delete cells[key];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    // ignore
  }
  const focused = document.activeElement;
  if (focused && inputs[focused.dataset ? focused.dataset.cell : '']) {
    focused.value = '';
  }
  refreshAll();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
document.getElementById('clear').addEventListener('click', clearSheet);
loadSheet();
buildGrid();
refreshAll();
