'use strict';
// Node harness: stubs a minimal DOM + localStorage, loads app.js, drives it.
const path = require('path');

const SITE = path.resolve(__dirname, '..');
const APP = path.join(SITE, 'app.js');

// ---- fake DOM -------------------------------------------------------------
let activeElement = null;

function makeEl(tag) {
  const el = {
    tag,
    children: [],
    dataset: {},
    value: '',
    textContent: '',
    className: '',
    listeners: Object.create(null),
    _classes: new Set(),
    classList: {
      toggle(c, force) {
        const want = force === undefined ? !el._classes.has(c) : force;
        if (want) el._classes.add(c);
        else el._classes.delete(c);
      },
      contains(c) {
        return el._classes.has(c);
      },
    },
    appendChild(c) {
      if (c.tag === '#fragment') el.children.push(...c.children);
      else el.children.push(c);
      return c;
    },
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    dispatch(type, ev) {
      ev = ev || {};
      ev.preventDefault = ev.preventDefault || function () {};
      for (const fn of el.listeners[type] || []) fn(ev);
    },
    focus() {
      if (activeElement === el) return;
      if (activeElement) activeElement.dispatch('blur');
      activeElement = el;
      el.dispatch('focus');
    },
    blur() {
      if (activeElement !== el) return;
      el.dispatch('blur');
      activeElement = null;
    },
  };
  return el;
}

const byId = {
  grid: makeEl('div'),
  clear: makeEl('button'),
};

global.document = {
  get activeElement() {
    return activeElement;
  },
  getElementById(id) {
    return byId[id];
  },
  createElement(tag) {
    return makeEl(tag);
  },
  createDocumentFragment() {
    return makeEl('#fragment');
  },
};

// ---- fake localStorage ------------------------------------------------------
const store = new Map();
global.localStorage = {
  getItem(k) {
    return store.has(k) ? store.get(k) : null;
  },
  setItem(k, v) {
    store.set(k, String(v));
  },
  removeItem(k) {
    store.delete(k);
  },
};

// ---- load the app -----------------------------------------------------------
require(APP);

// ---- test helpers -----------------------------------------------------------
const grid = byId.grid;
const inputs = {};
function collectInputs() {
  for (const child of grid.children) {
    if (child.tag === 'input') inputs[child.dataset.cell] = child;
  }
}
collectInputs();

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : `, want ${JSON.stringify(expected)}`}`
  );
}

function type(addr, text) {
  const el = inputs[addr];
  el.focus();
  el.value = text;
  el.blur(); // commit on focus loss
}

function pressEnter(addr) {
  const el = inputs[addr];
  if (activeElement !== el) el.focus();
  el.dispatch('keydown', { key: 'Enter' });
}

const fmt = (n) => String(Number(n.toPrecision(12)));

// ---- tests ------------------------------------------------------------------
check('empty sheet: A1 blank', inputs.A1.value, '');

// basic values
type('A1', '5');
type('B1', '=A1*2');
check('A1 shows number', inputs.A1.value, '5');
check('B1 =A1*2', inputs.B1.value, '10');

// floating point noise
type('C1', '=0.1+0.2');
check('C1 =0.1+0.2 shows 0.3', inputs.C1.value, '0.3');

// case-insensitive refs and functions
type('D1', '=sum(a1,c1)');
check('D1 =sum(a1,c1)', inputs.D1.value, '5.3');

// precedence, unary minus, parens
type('E1', '=-2+3*4');
check('E1 =-2+3*4 (precedence)', inputs.E1.value, '10');
type('F1', '=(2+3)*-4');
check('F1 (2+3)*-4', inputs.F1.value, '-20');

// division by zero
type('G1', '=1/0');
check('G1 #DIV/0!', inputs.G1.value, '#DIV/0!');
type('H1', '=0/0');
check('H1 0/0 #DIV/0!', inputs.H1.value, '#DIV/0!');

// out-of-range refs
type('A2', '=I1');
check('A2 =I1 #REF!', inputs.A2.value, '#REF!');
type('A3', '=A13');
check('A3 =A13 #REF!', inputs.A3.value, '#REF!');
type('A4', '=Z9+1');
check('A4 =Z9+1 #REF!', inputs.A4.value, '#REF!');

// circular references: whole cycle shows #CIRC!
type('B2', '=C2');
type('C2', '=B2');
check('B2 #CIRC!', inputs.B2.value, '#CIRC!');
check('C2 #CIRC!', inputs.C2.value, '#CIRC!');
type('C3', '=B2+1');
check('C3 depends on cycle -> error', inputs.C3.value, '#CIRC!');

// three-cell cycle
type('B3', '=C4');
type('C4', '=B4');
type('B4', '=B3');
check('B3 #CIRC!', inputs.B3.value, '#CIRC!');
check('C4 #CIRC!', inputs.C4.value, '#CIRC!');
check('B4 #CIRC!', inputs.B4.value, '#CIRC!');

// self-cycle via range
type('D2', '=SUM(D2:D3)');
check('D2 self-cycle via range #CIRC!', inputs.D2.value, '#CIRC!');

// parse errors
type('A5', '=1+');
check('A5 =1+ #ERR!', inputs.A5.value, '#ERR!');
type('A6', '=BOGUS(1)');
check('A6 unknown function #ERR!', inputs.A6.value, '#ERR!');
type('A7', '=(1+2');
check('A7 unbalanced paren #ERR!', inputs.A7.value, '#ERR!');
type('A8', '=SUM()');
check('A8 SUM() #ERR!', inputs.A8.value, '#ERR!');
type('A9', '=1 2');
check('A9 =1 2 #ERR!', inputs.A9.value, '#ERR!');

// text in arithmetic is an error; text cell shows its text
type('B5', 'hello');
type('C5', '=B5+1');
check('B5 shows text', inputs.B5.value, 'hello');
check('C5 text in arithmetic #ERR!', inputs.C5.value, '#ERR!');

// empty cells count as 0; text ignored by functions
type('D5', '=SUM(B6, B7, 3)'); // B6, B7 empty
check('D5 SUM(empty,empty,3)', inputs.D5.value, '3');
type('D6', '=SUM(B5, A1)'); // B5 is text -> ignored
check('D6 SUM(text,5)', inputs.D6.value, '5');

// AVG and MAX with ranges, commas, and a mix
type('B8', '1');
type('B9', '2');
type('B10', '4');
type('E5', '=AVG(B8:B10)');
check('E5 AVG range', inputs.E5.value, fmt(7 / 3));
type('E6', '=MAX(B8:B10, 3)');
check('E6 MAX mixed', inputs.E6.value, '4');
type('E7', '=AVG(B8, B9, B10)');
check('E7 AVG comma args', inputs.E7.value, fmt(7 / 3));

// errors propagate through formulas
type('F5', '=G1+1');
check('F5 uses error cell -> #DIV/0!', inputs.F5.value, '#DIV/0!');
type('F6', '=SUM(G1:A1)');
check('F6 SUM over range with error -> #DIV/0!', inputs.F6.value, '#DIV/0!');

// dependency recalculation: changing A1 flows into B1, D1, D6
type('A1', '10');
check('B1 recomputed', inputs.B1.value, '20');
check('D1 recomputed (sum(a1,c1))', inputs.D1.value, '10.3');
check('D6 recomputed (SUM(B5,A1))', inputs.D6.value, '10');

// Enter moves focus to the cell below and commits
inputs.B11.focus();
inputs.B11.value = '=7*6';
pressEnter('B11');
check('B11 committed via Enter', inputs.B11.value, '42');
check('focus moved to B12', activeElement === inputs.B12, true);
check('B12 focused shows raw (empty)', inputs.B12.value, '');

// focused cell shows raw content; blur restores the display
inputs.B11.focus();
check('focused cell shows raw formula', inputs.B11.value, '=7*6');
inputs.B11.blur();
check('blur restores display', inputs.B11.value, '42');

// persistence
check('sheet saved to localStorage', store.has('mini-spreadsheet-sheet-v1'), true);
const saved = JSON.parse(store.get('mini-spreadsheet-sheet-v1'));
check('saved content A1', saved.A1, '10');
check('saved content B11', saved.B11, '=7*6');

// reload: fresh app instance sees the saved sheet
delete require.cache[require.resolve(APP)];
byId.grid.children = [];
for (const k of Object.keys(inputs)) delete inputs[k];
require(APP);
collectInputs();
check('restored A1 after reload', inputs.A1.value, '10');
check('restored B1 after reload', inputs.B1.value, '20');
check('restored C1 (0.1+0.2) after reload', inputs.C1.value, '0.3');
check('restored CIRC after reload', inputs.B2.value, '#CIRC!');

// Clear button
byId.clear.dispatch('click');
check('A1 empty after Clear', inputs.A1.value, '');
check('B11 empty after Clear', inputs.B11.value, '');
check('C1 formula gone', inputs.C1.value, '');
check('storage cleared', store.has('mini-spreadsheet-sheet-v1'), false);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
