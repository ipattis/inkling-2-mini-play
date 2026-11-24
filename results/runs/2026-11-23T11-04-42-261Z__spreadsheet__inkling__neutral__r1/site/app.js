(function () {
  'use strict';

  var COLS = 'ABCDEFGH';
  var ROWS = 12;
  var STORAGE_KEY = 'mini-spreadsheet-v1';

  /* ---------- errors ---------- */
  function err(code) {
    var e = new Error(code);
    e.code = code;
    return e;
  }

  /* ---------- address helpers ---------- */
  function colIndex(letter) { return COLS.indexOf(letter); }
  function parseAddr(ref) {
    return { c: colIndex(ref.charAt(0)), r: parseInt(ref.slice(1), 10) };
  }
  function addrOf(ci, row) { return COLS[ci] + row; }

  function validateRef(ref) {
    var m = ref.match(/^([A-Z])([0-9]+)$/);
    if (!m) throw err('#REF!');
    var c = colIndex(m[1]);
    var r = parseInt(m[2], 10);
    if (c < 0 || r < 1 || r > ROWS) throw err('#REF!');
    return ref;
  }

  function expandRange(from, to) {
    var f = parseAddr(from), t = parseAddr(to);
    var out = [];
    for (var r = Math.min(f.r, t.r); r <= Math.max(f.r, t.r); r++) {
      for (var c = Math.min(f.c, t.c); c <= Math.max(f.c, t.c); c++) {
        out.push(addrOf(c, r));
      }
    }
    return out;
  }

  /* ---------- tokenizer ---------- */
  function tokenize(src) {
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var rest = src.slice(i);
      var ch = rest.charAt(0);
      if (/\s/.test(ch)) { i++; continue; }
      var m;
      if ((m = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/))) {
        tokens.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^[A-Za-z]+[0-9]+/))) {
        tokens.push({ t: 'ref', v: m[0].toUpperCase() });
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
        tokens.push({ t: 'ident', v: m[0] });
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^[+\-*/(),:]/))) {
        tokens.push({ t: 'op', v: m[0] });
        i += m[0].length;
        continue;
      }
      throw err('#ERR!');
    }
    return tokens;
  }

  /* ---------- parser ---------- */
  function parseFormula(src) {
    var tokens = tokenize(src);
    var pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function parseExpr() {
      var node = parseTerm();
      for (;;) {
        var t = peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
          next();
          node = { type: 'bin', op: t.v, left: node, right: parseTerm() };
        } else { return node; }
      }
    }

    function parseTerm() {
      var node = parseUnary();
      for (;;) {
        var t = peek();
        if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
          next();
          node = { type: 'bin', op: t.v, left: node, right: parseUnary() };
        } else { return node; }
      }
    }

    function parseUnary() {
      var t = peek();
      if (t && t.t === 'op' && t.v === '-') {
        next();
        return { type: 'neg', expr: parseUnary() };
      }
      if (t && t.t === 'op' && t.v === '+') {
        next();
        return parseUnary();
      }
      return parsePrimary();
    }

    function parsePrimary() {
      var t = peek();
      if (!t) throw err('#ERR!');
      if (t.t === 'num') { next(); return { type: 'num', value: t.v }; }
      if (t.t === 'ref') { next(); validateRef(t.v); return { type: 'ref', addr: t.v }; }
      if (t.t === 'ident') {
        next();
        var open = peek();
        if (!open || open.t !== 'op' || open.v !== '(') throw err('#ERR!');
        next();
        var args = [];
        args.push(parseArg());
        for (;;) {
          var tt = peek();
          if (tt && tt.t === 'op' && tt.v === ',') { next(); args.push(parseArg()); }
          else break;
        }
        var close = next();
        if (!close || close.t !== 'op' || close.v !== ')') throw err('#ERR!');
        return { type: 'call', name: t.v.toUpperCase(), args: args };
      }
      if (t.t === 'op' && t.v === '(') {
        next();
        var node = parseExpr();
        var rc = next();
        if (!rc || rc.t !== 'op' || rc.v !== ')') throw err('#ERR!');
        return node;
      }
      throw err('#ERR!');
    }

    function parseArg() {
      var t = peek();
      if (t && t.t === 'ref') {
        var nt = tokens[pos + 1];
        if (nt && nt.t === 'op' && nt.v === ':') {
          next(); next();
          var t2 = peek();
          if (!t2 || t2.t !== 'ref') throw err('#ERR!');
          next();
          validateRef(t.v);
          validateRef(t2.v);
          return { type: 'range', from: t.v, to: t2.v };
        }
      }
      return parseExpr();
    }

    var ast = parseExpr();
    if (pos < tokens.length) throw err('#ERR!');
    return ast;
  }

  /* ---------- evaluator ---------- */
  function numberFrom(v) {
    if (v.kind === 'empty') return 0;
    if (v.kind === 'number') return v.value;
    if (v.kind === 'text') throw err('#ERR!');
    throw err(v.code);
  }

  function evalNode(node, getCell) {
    switch (node.type) {
      case 'num':
        return node.value;
      case 'neg':
        return -evalNode(node.expr, getCell);
      case 'bin': {
        var l = evalNode(node.left, getCell);
        var r = evalNode(node.right, getCell);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (node.op === '/') {
          if (r === 0) throw err('#DIV/0!');
          return l / r;
        }
        throw err('#ERR!');
      }
      case 'ref':
        return numberFrom(getCell(node.addr));
      case 'call': {
        var name = node.name;
        if (name !== 'SUM' && name !== 'AVG' && name !== 'MAX') throw err('#ERR!');
        var vals = [];
        for (var i = 0; i < node.args.length; i++) {
          var arg = node.args[i];
          if (arg.type === 'range') {
            var addrs = expandRange(arg.from, arg.to);
            for (var j = 0; j < addrs.length; j++) {
              vals.push(numberFrom(getCell(addrs[j])));
            }
          } else {
            vals.push(evalNode(arg, getCell));
          }
        }
        if (vals.length === 0) throw err('#ERR!');
        if (name === 'SUM') return vals.reduce(function (a, b) { return a + b; }, 0);
        if (name === 'AVG') return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        return Math.max.apply(null, vals); // MAX
      }
      default:
        throw err('#ERR!');
    }
  }

  /* ---------- numeric check ---------- */
  function isNumeric(s) {
    return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s);
  }

  /* ---------- formatting ---------- */
  function fmtNum(n) {
    if (!isFinite(n)) return '#ERR!';
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    return String(parseFloat(n.toPrecision(12)));
  }

  function displayOf(v) {
    if (!v) return '';
    if (v.kind === 'empty') return '';
    if (v.kind === 'text') return v.value;
    if (v.kind === 'error') return v.code;
    return fmtNum(v.value);
  }

  /* ---------- state ---------- */
  var rawStore = loadStore();

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rawStore));
    } catch (e) { /* ignore */ }
  }

  /* ---------- recalculation ---------- */
  function computeAll() {
    var cache = new Map();
    var visiting = new Set();

    function cellValue(addr) {
      if (cache.has(addr)) return cache.get(addr);
      if (visiting.has(addr)) return { kind: 'error', code: '#CIRC!' };
      visiting.add(addr);
      var v = computeCell(addr);
      visiting.delete(addr);
      cache.set(addr, v);
      return v;
    }

    function computeCell(addr) {
      var raw = (rawStore[addr] || '').trim();
      if (raw === '') return { kind: 'empty' };
      if (raw.charAt(0) === '=') {
        try {
          var ast = parseFormula(raw.slice(1));
          var val = evalNode(ast, cellValue);
          if (typeof val !== 'number' || !isFinite(val)) return { kind: 'error', code: '#ERR!' };
          return { kind: 'number', value: val };
        } catch (e) {
          return { kind: 'error', code: (e && e.code) || '#ERR!' };
        }
      }
      if (isNumeric(raw)) return { kind: 'number', value: parseFloat(raw) };
      return { kind: 'text', value: raw };
    }

    for (var r = 1; r <= ROWS; r++) {
      for (var ci = 0; ci < COLS.length; ci++) {
        cellValue(addrOf(ci, r));
      }
    }
    return cache;
  }

  /* ---------- grid construction ---------- */
  var grid = document.getElementById('grid');
  var allInputs = [];
  var inputAt = {};

  var corner = document.createElement('div');
  corner.className = 'corner';
  grid.appendChild(corner);

  for (var ci = 0; ci < COLS.length; ci++) {
    var head = document.createElement('div');
    head.className = 'col-head';
    head.textContent = COLS[ci];
    grid.appendChild(head);
  }

  for (var r = 1; r <= ROWS; r++) {
    var rowHead = document.createElement('div');
    rowHead.className = 'row-head';
    rowHead.textContent = String(r);
    grid.appendChild(rowHead);

    for (var c = 0; c < COLS.length; c++) {
      var addr = COLS[c] + r;
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'cell';
      input.setAttribute('data-cell', addr);
      input.setAttribute('aria-label', 'Cell ' + addr);
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('spellcheck', 'false');
      input.addEventListener('focus', onFocus);
      input.addEventListener('blur', onBlur);
      input.addEventListener('keydown', onKeyDown);
      grid.appendChild(input);
      allInputs.push(input);
      inputAt[addr] = input;
    }
  }

  /* ---------- editing flow ---------- */
  function onFocus(e) {
    var input = e.target;
    var addr = input.getAttribute('data-cell');
    input.value = rawStore[addr] || '';
    input.select();
    render();
  }

  function onBlur(e) {
    commit(e.target);
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var input = e.target;
    var addr = input.getAttribute('data-cell');
    var row = parseInt(addr.slice(1), 10);
    if (row < ROWS) {
      var below = inputAt[addr.charAt(0) + (row + 1)];
      if (below) below.focus();
    } else {
      commit(input);
      input.select();
    }
  }

  function commit(input) {
    var addr = input.getAttribute('data-cell');
    var raw = input.value.trim();
    if (raw === '') delete rawStore[addr];
    else rawStore[addr] = raw;
    saveStore();
    render();
  }

  /* ---------- rendering ---------- */
  function render() {
    var values = computeAll();
    var active = document.activeElement;
    for (var i = 0; i < allInputs.length; i++) {
      var input = allInputs[i];
      var addr = input.getAttribute('data-cell');
      var v = values.get(addr);
      input.classList.toggle('err', !!v && v.kind === 'error');
      if (input === active) continue; // leave the editing cell alone
      input.value = displayOf(v);
    }
  }

  /* ---------- clear ---------- */
  document.getElementById('clearBtn').addEventListener('click', function () {
    rawStore = {};
    saveStore();
    render();
  });

  /* ---------- init ---------- */
  render();
})();
