(function () {
  'use strict';

  // ---------- Configuration ----------
  var COLS = 'ABCDEFGH';
  var ROWS = 12;
  var STORAGE_KEY = 'mini-spreadsheet-v1';

  // ---------- Errors ----------
  function SheetError(code) {
    this.code = code;
  }
  SheetError.prototype = Object.create(Error.prototype);
  SheetError.prototype.constructor = SheetError;

  function fail(code) {
    throw new SheetError(code || '#ERR!');
  }

  // ---------- Addresses ----------
  // Parses "A1"-style text (already upper-cased) into {c, r, name}.
  // Throws #REF! if outside A1:H12.
  function parseAddr(text) {
    var m = /^([A-Z]+)(\d+)$/.exec(text);
    if (!m) fail('#ERR!');
    var c = 0;
    for (var i = 0; i < m[1].length; i++) {
      c = c * 26 + (m[1].charCodeAt(i) - 64);
    }
    c -= 1;
    var r = parseInt(m[2], 10);
    if (c < 0 || c >= COLS.length || r < 1 || r > ROWS) fail('#REF!');
    return { c: c, r: r, name: COLS[c] + r };
  }

  // Expands a range into a list of normalized addresses (row-major).
  function rangeAddrs(fromText, toText) {
    var a = parseAddr(fromText);
    var b = parseAddr(toText);
    var out = [];
    var c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
    var r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
    for (var r = r1; r <= r2; r++) {
      for (var c = c1; c <= c2; c++) {
        out.push(COLS[c] + r);
      }
    }
    return out;
  }

  // ---------- Tokenizer ----------
  function tokenize(src) {
    var toks = [];
    var i = 0;
    while (i < src.length) {
      var ch = src.charAt(i);
      if (/\s/.test(ch)) { i++; continue; }
      var rest = src.slice(i);
      var m;
      if ((m = /^[A-Za-z]+\d+/.exec(rest))) {
        toks.push({ t: 'ref', v: m[0].toUpperCase() });
      } else if ((m = /^[A-Za-z]+/.exec(rest))) {
        toks.push({ t: 'id', v: m[0].toUpperCase() });
      } else if ((m = /^(\d+\.?\d*|\.\d+)/.exec(rest))) {
        toks.push({ t: 'num', v: parseFloat(m[0]) });
      } else if ('+-*/(),:'.indexOf(ch) >= 0) {
        toks.push({ t: ch });
        m = [ch];
      } else {
        fail('#ERR!');
      }
      i += m[0].length;
    }
    toks.push({ t: 'eof' });
    return toks;
  }

  // ---------- Parser (recursive descent) ----------
  // Grammar:
  //   expr    := term (('+' | '-') term)*
  //   term    := unary (('*' | '/') unary)*
  //   unary   := '-' unary | '+' unary | primary
  //   primary := NUMBER | REF | REF ':' REF | FUNC '(' [expr (',' expr)*] ')' | '(' expr ')'
  function parseFormula(src) {
    var toks = tokenize(src);
    var p = 0;

    function peekType() { return toks[p].t; }
    function next() { return toks[p++]; }
    function expect(type) {
      if (toks[p].t !== type) fail('#ERR!');
      return toks[p++];
    }

    function expr() {
      var left = term();
      while (peekType() === '+' || peekType() === '-') {
        var op = next().t;
        left = { t: 'bin', op: op, l: left, r: term() };
      }
      return left;
    }

    function term() {
      var left = unary();
      while (peekType() === '*' || peekType() === '/') {
        var op = next().t;
        left = { t: 'bin', op: op, l: left, r: unary() };
      }
      return left;
    }

    function unary() {
      if (peekType() === '-') { next(); return { t: 'neg', e: unary() }; }
      if (peekType() === '+') { next(); return unary(); }
      return primary();
    }

    function primary() {
      var tk = next();
      if (tk.t === 'num') return { t: 'num', v: tk.v };
      if (tk.t === 'ref') {
        if (peekType() === ':') {
          next();
          var to = expect('ref');
          return { t: 'range', from: tk.v, to: to.v };
        }
        return { t: 'ref', addr: tk.v };
      }
      if (tk.t === 'id') {
        expect('(');
        var args = [];
        if (peekType() !== ')') {
          args.push(expr());
          while (peekType() === ',') {
            next();
            args.push(expr());
          }
        }
        expect(')');
        return { t: 'call', name: tk.v, args: args };
      }
      if (tk.t === '(') {
        var inner = expr();
        expect(')');
        return inner;
      }
      fail('#ERR!');
    }

    if (toks[0].t === 'eof') fail('#ERR!');
    var ast = expr();
    if (peekType() !== 'eof') fail('#ERR!');
    return ast;
  }

  // ---------- Evaluator ----------
  // ctx.get(addr) returns number | string | null, or throws SheetError.
  function scalar(v) {
    if (v === null) return 0;             // empty counts as 0
    if (typeof v === 'number') return v;
    fail('#ERR!');                        // text used in arithmetic
  }

  function evalNode(node, ctx) {
    switch (node.t) {
      case 'num':
        return node.v;
      case 'ref':
        return scalar(ctx.get(parseAddr(node.addr).name));
      case 'range':
        fail('#ERR!');                    // a range is only valid as a function argument
        break;
      case 'neg':
        return -evalNode(node.e, ctx);
      case 'bin': {
        var l = evalNode(node.l, ctx);
        var r = evalNode(node.r, ctx);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (r === 0) fail('#DIV/0!');
        return l / r;
      }
      case 'call':
        return evalCall(node, ctx);
    }
    fail('#ERR!');
  }

  function evalCall(node, ctx) {
    var name = node.name;
    if (name !== 'SUM' && name !== 'AVG' && name !== 'MAX') fail('#ERR!');

    var values = [];
    for (var i = 0; i < node.args.length; i++) {
      var arg = node.args[i];
      if (arg.t === 'range') {
        var addrs = rangeAddrs(arg.from, arg.to);
        for (var j = 0; j < addrs.length; j++) {
          var v = ctx.get(addrs[j]);
          if (v === null) values.push(0);          // empty counts as 0
          else if (typeof v === 'number') values.push(v);
          // text cells inside a range are skipped
        }
      } else {
        values.push(evalNode(arg, ctx));
      }
    }

    if (name === 'SUM') {
      var sum = 0;
      for (var s = 0; s < values.length; s++) sum += values[s];
      return sum;
    }
    if (name === 'AVG') {
      if (values.length === 0) fail('#DIV/0!');
      var total = 0;
      for (var a = 0; a < values.length; a++) total += values[a];
      return total / values.length;
    }
    // MAX
    if (values.length === 0) fail('#ERR!');
    var max = values[0];
    for (var m = 1; m < values.length; m++) {
      if (values[m] > max) max = values[m];
    }
    return max;
  }

  // ---------- Recalculation ----------
  // raws: { "A1": "raw text", ... }
  // Returns { "A1": { v: value } | { err: "#CODE!" }, ... } for every cell.
  function recalc(raws) {
    var cache = new Map();
    var visiting = new Set();

    function computeRaw(addr) {
      var raw = raws[addr];
      if (raw === undefined || raw.trim() === '') return null;
      if (raw.charAt(0) === '=') {
        var ast = parseFormula(raw.slice(1));
        var result = evalNode(ast, { get: get });
        if (!isFinite(result)) fail('#ERR!');
        return result;
      }
      if (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(raw)) {
        return Number(raw);
      }
      return raw;                          // plain text
    }

    function evalCell(addr) {
      if (cache.has(addr)) return cache.get(addr);
      if (visiting.has(addr)) fail('#CIRC!');   // cycle: caller records the error
      visiting.add(addr);
      var res;
      try {
        res = { v: computeRaw(addr) };
      } catch (e) {
        res = { err: e instanceof SheetError ? e.code : '#ERR!' };
      }
      visiting.delete(addr);
      cache.set(addr, res);
      return res;
    }

    function get(addr) {
      var r = evalCell(addr);
      if (r.err) throw new SheetError(r.err);
      return r.v;
    }

    var out = {};
    for (var r = 1; r <= ROWS; r++) {
      for (var c = 0; c < COLS.length; c++) {
        var addr = COLS[c] + r;
        out[addr] = evalCell(addr);
      }
    }
    return out;
  }

  // Shows numbers without floating-point noise (e.g. 0.1+0.2 -> 0.3).
  function formatNumber(n) {
    if (Number.isInteger(n)) return String(n);
    return String(parseFloat(n.toPrecision(12)));
  }

  // ---------- Storage ----------
  function loadRaws() {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return (data && typeof data === 'object') ? data : {};
    } catch (e) {
      return {};
    }
  }

  function saveRaws() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(raws));
    } catch (e) {
      // storage unavailable or full; keep working in memory
    }
  }

  // ---------- UI ----------
  var raws = loadRaws();
  var inputs = {};
  var gridRoot = document.getElementById('grid-root');

  function buildGrid() {
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    var corner = document.createElement('th');
    corner.className = 'corner';
    headRow.appendChild(corner);
    for (var c = 0; c < COLS.length; c++) {
      var th = document.createElement('th');
      th.textContent = COLS[c];
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var r = 1; r <= ROWS; r++) {
      var tr = document.createElement('tr');
      var rowHead = document.createElement('th');
      rowHead.textContent = String(r);
      tr.appendChild(rowHead);
      for (var k = 0; k < COLS.length; k++) {
        var addr = COLS[k] + r;
        var td = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('data-cell', addr);
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        inputs[addr] = input;
        td.appendChild(input);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    gridRoot.appendChild(table);
  }

  function commit(input) {
    var addr = input.getAttribute('data-cell');
    var value = input.value;
    if (value.trim() === '') {
      delete raws[addr];
    } else {
      raws[addr] = value;
    }
    saveRaws();
  }

  function render() {
    var results = recalc(raws);
    var active = document.activeElement;
    Object.keys(inputs).forEach(function (addr) {
      var input = inputs[addr];
      var res = results[addr];
      if (input === active) {
        input.value = raws[addr] || '';
        return;
      }
      var text = '';
      var isErr = false;
      var isNum = false;
      if (res.err) {
        text = res.err;
        isErr = true;
      } else if (res.v === null) {
        text = '';
      } else if (typeof res.v === 'number') {
        text = formatNumber(res.v);
        isNum = true;
      } else {
        text = res.v;
      }
      input.value = text;
      input.classList.toggle('err', isErr);
      input.classList.toggle('num', isNum);
    });
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var input = e.currentTarget;
    var addr = input.getAttribute('data-cell');
    var col = addr.charAt(0);
    var row = parseInt(addr.slice(1), 10);
    commit(input);
    render();
    if (row < ROWS) {
      inputs[col + (row + 1)].focus();
    } else {
      input.blur();
    }
  }

  function onFocus(e) {
    var input = e.currentTarget;
    input.value = raws[input.getAttribute('data-cell')] || '';
    // Select the content so typing replaces it; keeps the raw formula visible.
    input.select();
  }

  function onBlur(e) {
    commit(e.currentTarget);
    render();
  }

  function bindEvents() {
    Object.keys(inputs).forEach(function (addr) {
      var input = inputs[addr];
      input.addEventListener('focus', onFocus);
      input.addEventListener('blur', onBlur);
      input.addEventListener('keydown', onKeyDown);
    });

    document.getElementById('clear').addEventListener('click', function () {
      raws = {};
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {
        // ignore
      }
      render();
    });
  }

  buildGrid();
  bindEvents();
  render();
})();
