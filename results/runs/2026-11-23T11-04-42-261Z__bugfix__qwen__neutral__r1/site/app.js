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
  const list = filter === 'All'
    ? expenses.map((e, i) => ({ e, i }))
    : expenses.map((e, i) => ({ e, i })).filter(({ e }) => e.category === filter);
  return list
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .map((x) => x.e);
}

function render() {
  const list = visible();
  const ul = $('list');
  ul.innerHTML = '';
  list.forEach((e) => {
    const li = document.createElement('li');
    li.className = 'expense';
    li.innerHTML =
      `<span class="desc"></span>` +
      `<span class="cat"></span>` +
      `<span class="date"></span>` +
      `<span class="amount">${money(e.amount)}</span>` +
      `<button class="del" data-id="${e.id}" aria-label="Delete">✕</button>`;
    li.querySelector('.desc').textContent = e.description;
    li.querySelector('.cat').textContent = e.category;
    li.querySelector('.date').textContent = e.date;
    ul.appendChild(li);
  });
  $('empty').hidden = list.length > 0;

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
  if (!description || Number.isNaN(amount) || amount <= 0) {
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
  const id = Number(button.dataset.id);
  const idx = expenses.findIndex((e) => e.id === id);
  if (idx !== -1) expenses.splice(idx, 1);
  save();
  render();
});

$('filter').addEventListener('change', render);
render();
