// Expense tracker
const KEY = 'expenses';
const CATEGORIES = ['Food', 'Transport', 'Housing', 'Fun'];
const $ = (id) => document.getElementById(id);

let expenses = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
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
  // Newest first: by date descending, then by creation (id) descending.
  return list.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

function render() {
  const list = visible();
  const ul = $('list');
  ul.innerHTML = '';
  list.forEach((e) => {
    const li = document.createElement('li');
    li.className = 'expense';
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = e.description;
    const cat = document.createElement('span');
    cat.className = 'cat';
    cat.textContent = e.category;
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = e.date;
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = money(e.amount);
    const del = document.createElement('button');
    del.className = 'del';
    del.dataset.id = String(e.id);
    del.setAttribute('aria-label', 'Delete');
    del.textContent = '✕';
    li.append(desc, cat, date, amount, del);
    ul.appendChild(li);
  });
  $('empty').hidden = list.length > 0;

  // Total reflects the expenses currently shown (respects the filter).
  const total = list.reduce((sum, e) => sum + e.amount, 0);
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
  const amount = parseFloat($('amount').value);
  const category = $('category').value;
  const date = $('date').value || new Date().toISOString().slice(0, 10);
  if (!description || !Number.isFinite(amount) || amount <= 0) {
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
  const id = button.dataset.id;
  expenses = expenses.filter((e) => String(e.id) !== id);
  save();
  render();
});

$('filter').addEventListener('change', render);
render();
