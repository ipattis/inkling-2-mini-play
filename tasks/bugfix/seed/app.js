// Expense tracker
const KEY = 'expenses';
const CATEGORIES = ['Food', 'Transport', 'Housing', 'Fun'];
const $ = (id) => document.getElementById(id);

let expenses = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem('expense')) || [];
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
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

function render() {
  const list = visible();
  const ul = $('list');
  ul.innerHTML = '';
  list.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'expense';
    li.innerHTML =
      `<span class="desc">${e.description}</span>` +
      `<span class="cat">${e.category}</span>` +
      `<span class="date">${e.date}</span>` +
      `<span class="amount">${money(e.amount)}</span>` +
      `<button class="del" data-index="${i}" aria-label="Delete">✕</button>`;
    ul.appendChild(li);
  });
  $('empty').hidden = list.length > 0;

  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
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
  const amount = parseInt($('amount').value, 10);
  const category = $('category').value;
  const date = $('date').value || new Date().toISOString().slice(0, 10);
  if (!description || Number.isNaN(amount)) {
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
  expenses.splice(Number(button.dataset.index), 1);
  save();
  render();
});

$('filter').addEventListener('change', render);
render();
