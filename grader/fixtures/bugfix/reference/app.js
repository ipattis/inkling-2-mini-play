// Expense tracker — reference fix: tasks/bugfix/seed/app.js with the seven
// reported bugs fixed and nothing else changed.
const KEY = 'expenses';
const CATEGORIES = ['Food', 'Transport', 'Housing', 'Fun'];
const $ = (id) => document.getElementById(id);

let expenses = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || []; // fix 3: same key as save()
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(expenses));
}

function money(n) {
  return '$' + n.toFixed(2);
}

function visible() {
  const filter = $('filter').value;
  const list = filter === 'All' ? expenses.slice() : expenses.filter((e) => e.category === filter);
  return list.sort((a, b) => b.date.localeCompare(a.date)); // fix 6: newest first
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text; // fix 5: text, not HTML
  return s;
}

function render() {
  const list = visible();
  const ul = $('list');
  ul.innerHTML = '';
  list.forEach((e) => {
    const li = document.createElement('li');
    li.className = 'expense';
    li.append(span('desc', e.description), span('cat', e.category), span('date', e.date), span('amount', money(e.amount)));
    const del = document.createElement('button');
    del.className = 'del';
    del.dataset.id = String(e.id); // fix 2: delete by id, not by position in the filtered list
    del.setAttribute('aria-label', 'Delete');
    del.textContent = '✕';
    li.append(del);
    ul.appendChild(li);
  });
  $('empty').hidden = list.length > 0;

  const total = list.reduce((sum, e) => sum + e.amount, 0); // fix 4: total of what's shown
  $('total').textContent = money(total);

  const byCategory = $('by-category');
  byCategory.innerHTML = '';
  for (const category of CATEGORIES) {
    const sum = expenses.filter((e) => e.category === category).reduce((s, e) => s + e.amount, 0);
    const li = document.createElement('li');
    li.dataset.category = category;
    li.textContent = `${category}: ${money(sum)}`;
    byCategory.appendChild(li);
  }
}

$('form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const description = $('desc').value.trim();
  const amount = parseFloat($('amount').value); // fix 1: keep cents
  const category = $('category').value;
  const date = $('date').value || new Date().toISOString().slice(0, 10);
  if (!description || !(amount > 0)) { // fix 7: reject zero / negative / missing
    $('error').textContent = 'Enter a description and an amount greater than zero.';
    $('error').hidden = false;
    return;
  }
  $('error').hidden = true;
  expenses.push({ id: Date.now() + Math.random(), description, amount, category, date });
  save();
  $('form').reset();
  render();
});

$('list').addEventListener('click', (ev) => {
  const button = ev.target.closest('.del');
  if (!button) return;
  expenses = expenses.filter((e) => String(e.id) !== button.dataset.id);
  save();
  render();
});

$('filter').addEventListener('change', render);
render();
