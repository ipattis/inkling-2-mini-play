(() => {
  'use strict';

  const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const ROWS = 12;
  const STORAGE_KEY = 'mini-sheet-v1';
  const NUMERIC_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
  const FUNCTIONS = new Set(['SUM', 'AVG', 'MAX']);

  // ---------------------------------------------------------------------------
  // Values and errors
  //   A cell's value is: null (empty), a number, a string (text), or a CellError.
  // ---------------------------------------------------------------------------

  class CellError {
    constructor(code) {
      this.code = code;
    }
  }

  // Thrown inside formula evaluation; converted to a CellError by evalCell().
  class FormulaError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  const fail = (code) => {
    throw new FormulaError(code);
  };

  // ---------------------------------------------------------------------------
  // Tokenizer
  // ---------------------------------------------------------------------------

  // Reference token value: { col: 0..7 (or -1 if invalid), row: integer }.
  // Bounds are checked at evaluation time so out-of-range refs give #REF!.
  function tokenize(src) {
    const tokens = [];
    let i = 0;

    while (i < src.length) {
      const ch = src[i];

      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      const rest = src.slice(i);
      let m;

      if ((m = /^(?:\d+\.?\d*|\.\d+)/.exec(rest))) {
        tokens.push({ type: 'num', value: parseFloat(m[0]) });
        i += m[0].length;
      } else if ((m = /^[A-Za-z][A-Za-z0-9]*/.exec(rest))) {
        const word = m[0];
        if (/\d/.test(word)) {
          const ref = /^([A-Za-z]+)(\d+)$/.exec(word);
          if (!ref) fail('#ERR!');
          const letters = ref[1].toUpperCase();
          tokens.push({
            type: 'ref',
            value: {
              col: letters.length === 1 ? letters.charCodeAt(0) - 65 : -1,
              row: parseInt(ref[2], 10),
            },
          });
        } else {
          tokens.push({ type: 'name', value: word });
        }
        i += word.length;
      } else if ('+-*/(),:'.includes(ch)) {
        tokens.push({ type: 'op', value: ch });
        i++;
      } else {
        fail('#ERR!');
      }
    }

    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Parser (recursive descent)
  //
  //   expr    := term (('+' | '-') term)*
  //   term    := unary (('*' | '/') unary)*
  //   unary   := ('-' | '+') unary | primary
  //   primary := NUMBER
  //            | REF [':' REF]
  //            | NAME '(' [expr (',' expr)*] ')'
  //            | '(' expr ')'
  // ---------------------------------------------------------------------------

  function parseFormula(src) {
    const tokens = tokenize(src);
    let pos = 0;

    const isOp = (value) => {
      const t = tokens[pos];
      return t !== undefined && t.type === 'op' && t.value === value;
    };
    const next = () => tokens[pos++];
    const expect = (value) => {
      if (!isOp(value)) fail('#ERR!');
      pos++;
    };

    function parseExpr() {
      let node = parseTerm();
      while (isOp('+') || isOp('-')) {
        const op = next().value;
        node = { type: 'bin', op, left: node, right: parseTerm() };
      }
      return node;
    }

    function parseTerm() {
      let node = parseUnary();
      while (isOp('*') || isOp('/')) {
        const op = next().value;
        node = { type: 'bin', op, left: node, right: parseUnary() };
      }
      return node;
    }

    function parseUnary() {
      if (isOp('-')) {
        next();
        return { type: 'neg', arg: parseUnary() };
      }
      if (isOp('+')) {
        next();
        return parseUnary();
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const t = next();
      if (t === undefined) fail('#ERR!');

      if (t.type === 'num') {
        return { type: 'num', value: t.value };
      }

      if (t.type === 'ref') {
        if (isOp(':')) {
          next();
          const end = next();
          if (end === undefined || end.type !== 'ref') fail('#ERR!');
          return { type: 'range', from: t.value, to: end.value };
        }
        return { type: 'ref', ref: t.value };
      }

      if (t.type === 'name') {
        expect('(');
        const args = [];
        if (!isOp(')')) {
          args.push(parseExpr());
          while (isOp(',')) {
            next();
            args.push(parseExpr());
          }
        }
        expect(')');
        return { type: 'call', name: t.value.toUpperCase(), args };
      }

      if (t.type === 'op' && t.value === '(') {
        const node = parseExpr();
        expect(')');
        return node;
      }

      fail('#ERR!');
    }

    const ast = parseExpr();
    if (pos !== tokens.length) fail('#ERR!');
    return ast;
  }

  // ---------------------------------------------------------------------------
  // Sheet state and evaluation
  // ---------------------------------------------------------------------------

  let raw = {};            // address ("B3") -> raw entered text
  let cache = new Map();   // address -> computed value, valid for one recalc pass
  const visiting = new Set(); // addresses currently being evaluated (cycle detection)

  const inBounds = (ref) =>
    Number.isInteger(ref.col) && ref.col >= 0 && ref.col < COLS.length &&
    Number.isInteger(ref.row) && ref.row >= 1 && ref.row <= ROWS;

  const refKey = (ref) => COLS[ref.col] + ref.row;

  // Converts a computed value to a number for use in arithmetic.
  function toNumber(value) {
    if (value instanceof CellError) fail(value.code);
    if (value === null) return 0;
    if (typeof value === 'string') fail('#ERR!');
    return value;
  }

  // Expands a range into its numeric values. Empty cells count as 0,
  // text cells are skipped, and error cells propagate.
  function rangeNumbers(node) {
    if (!inBounds(node.from) || !inBounds(node.to)) fail('#REF!');

    const c1 = Math.min(node.from.col, node.to.col);
    const c2 = Math.max(node.from.col, node.to.col);
    const r1 = Math.min(node.from.row, node.to.row);
    const r2 = Math.max(node.from.row, node.to.row);

    const values = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = evalCell(COLS[c] + r);
        if (v instanceof CellError) fail(v.code);
        if (typeof v === 'string') continue;
        values.push(v === null ? 0 : v);
      }
    }
    return values;
  }

  function evalCall(node) {
    if (!FUNCTIONS.has(node.name)) fail('#ERR!');
    if (node.args.length === 0) fail('#ERR!');

    const nums = [];
    for (const arg of node.args) {
      if (arg.type === 'range') {
        nums.push(...rangeNumbers(arg));
      } else {
        nums.push(evalNum(arg));
      }
    }

    switch (node.name) {
      case 'SUM':
        return nums.reduce((sum, x) => sum + x, 0);
      case 'AVG':
        if (nums.length === 0) fail('#DIV/0!');
        return nums.reduce((sum, x) => sum + x, 0) / nums.length;
      case 'MAX':
        return nums.length ? Math.max(...nums) : 0;
      default:
        fail('#ERR!');
    }
  }

  // Evaluates an AST node that must produce a single number.
  function evalNum(node) {
    switch (node.type) {
      case 'num':
        return node.value;

      case 'ref': {
        if (!inBounds(node.ref)) fail('#REF!');
        return toNumber(evalCell(refKey(node.ref)));
      }

      case 'neg':
        return -evalNum(node.arg);

      case 'bin': {
        const a = evalNum(node.left);
        const b = evalNum(node.right);
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/':
            if (b === 0) fail('#DIV/0!');
            return a / b;
          default: fail('#ERR!');
        }
        break;
      }

      case 'call':
        return evalCall(node);

      case 'range':
        // A range is only meaningful as a function argument.
        fail('#ERR!');
        break;

      default:
        fail('#ERR!');
    }
  }

  function evalFormula(src) {
    const result = evalNum(parseFormula(src));
    if (!Number.isFinite(result)) fail('#ERR!');
    return result;
  }

  // Literal (non-formula) content: a number if it looks like one, else text.
  function parseLiteral(src) {
    const trimmed = src.trim();
    return NUMERIC_LITERAL.test(trimmed) ? Number(trimmed) : src;
  }

  // Computes the value of one cell, using the per-pass cache.
  function evalCell(addr) {
    if (cache.has(addr)) return cache.get(addr);
    if (visiting.has(addr)) return new CellError('#CIRC!');

    const src = raw[addr];
    if (src === undefined || src === '') return null;

    visiting.add(addr);
    let result;
    try {
      result = src[0] === '=' ? evalFormula(src.slice(1)) : parseLiteral(src);
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      result = new CellError(err.code);
    } finally {
      visiting.delete(addr);
    }

    cache.set(addr, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  // Rounds away floating-point noise (0.1 + 0.2 -> 0.3) by keeping 15
  // significant digits, the precision a double can reliably represent.
  function formatNumber(n) {
    return String(Number(n.toPrecision(15)));
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  const VALID_ADDRESS = /^[A-H](?:[1-9]|1[0-2])$/;

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (data && typeof data === 'object') {
        for (const [addr, value] of Object.entries(data)) {
          if (VALID_ADDRESS.test(addr) && typeof value === 'string' && value !== '') {
            raw[addr] = value;
          }
        }
      }
    } catch (err) {
      // Corrupt or unavailable storage: start with an empty sheet.
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
    } catch (err) {
      // Storage full or unavailable: keep working in memory.
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const table = document.getElementById('grid');
  const clearButton = document.getElementById('clear');
  const inputs = [];
  const inputByAddr = new Map();

  function buildGrid() {
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(document.createElement('th'));
    for (const col of COLS) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = col;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let row = 1; row <= ROWS; row++) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = String(row);
      tr.appendChild(th);

      for (const col of COLS) {
        const addr = col + row;
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.cell = addr;
        input.setAttribute('aria-label', 'Cell ' + addr);
        input.autocomplete = 'off';
        input.spellcheck = false;
        td.appendChild(input);
        tr.appendChild(td);

        inputs.push(input);
        inputByAddr.set(addr, input);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  // Recomputes every cell and updates the inputs. The element `keep` (if any)
  // is left alone, as is whichever input currently has focus.
  function render(keep) {
    cache = new Map();
    visiting.clear();

    for (const input of inputs) {
      const v = evalCell(input.dataset.cell);

      let kind;
      let text;
      if (v === null) {
        kind = 'empty';
        text = '';
      } else if (v instanceof CellError) {
        kind = 'error';
        text = v.code;
      } else if (typeof v === 'number') {
        kind = 'number';
        text = formatNumber(v);
      } else {
        kind = 'text';
        text = v;
      }

      input.dataset.kind = kind;
      if (input !== keep && input !== document.activeElement) {
        input.value = text;
      }
    }
  }

  function setRaw(addr, value) {
    if (value === '') {
      delete raw[addr];
    } else {
      raw[addr] = value;
    }
    save();
  }

  // Stores the input's text as the cell's content and recalculates.
  function commit(input, keep) {
    setRaw(input.dataset.cell, input.value);
    render(keep);
  }

  function attachHandlers(input) {
    const addr = input.dataset.cell;

    input.addEventListener('focus', () => {
      // Show the raw content while editing.
      input.value = raw[addr] || '';
    });

    input.addEventListener('blur', () => {
      commit(input, null);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(input, input);
        const below = inputByAddr.get(addr[0] + (Number(addr.slice(1)) + 1));
        if (below) {
          below.focus();
        } else {
          input.blur();
        }
      } else if (e.key === 'Escape') {
        input.value = raw[addr] || '';
        input.blur();
      }
    });
  }

  function clearSheet() {
    raw = {};
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // Ignore storage errors.
    }
    render(null);
  }

  buildGrid();
  inputs.forEach(attachHandlers);
  clearButton.addEventListener('click', clearSheet);

  load();
  render(null);
})();
