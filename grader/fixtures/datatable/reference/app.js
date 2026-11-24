// Known-good reference for the data-explorer task (used by grader/selftest.mjs).
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KEYS = ['name', 'city', 'signup', 'orders', 'spend'];
let data = [];
let state = { sort: null, dir: 'asc', q: '', page: 1, size: 10 };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const sort = p.get('sort');
  state = {
    sort: KEYS.includes(sort) ? sort : null,
    dir: p.get('dir') === 'desc' ? 'desc' : 'asc',
    q: p.get('q') || '',
    page: Math.max(1, parseInt(p.get('page'), 10) || 1),
    size: [10, 25, 50].includes(+p.get('size')) ? +p.get('size') : 10,
  };
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.sort) { p.set('sort', state.sort); p.set('dir', state.dir); }
  if (state.q) p.set('q', state.q);
  p.set('page', String(state.page));
  p.set('size', String(state.size));
  history.replaceState(null, '', `#${p.toString()}`);
}

function compare(a, b) {
  const k = state.sort;
  let c = 0;
  if (k === 'orders' || k === 'spend') c = a[k] - b[k];
  else if (k === 'signup') c = a.signup < b.signup ? -1 : a.signup > b.signup ? 1 : 0;
  else if (k) c = a[k].localeCompare(b[k], undefined, { sensitivity: 'base' });
  if (state.dir === 'desc') c = -c;
  return c || a.id - b.id; // ties: id ascending in both directions
}

function render() {
  const q = state.q.toLowerCase();
  const rows = data.filter((r) => !q || r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q)).sort(compare);
  const pages = Math.max(1, Math.ceil(rows.length / state.size));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * state.size;
  const pageRows = rows.slice(start, start + state.size);

  const tbody = $('rows');
  tbody.textContent = '';
  for (const r of pageRows) {
    const tr = tbody.insertRow();
    for (const v of [r.name, r.city, r.signup, String(r.orders), money(r.spend)]) tr.insertCell().textContent = v;
  }
  $('empty').hidden = rows.length > 0;
  $('status').textContent = rows.length ? `Showing ${start + 1}–${start + pageRows.length} of ${rows.length}` : 'No results';
  $('tot-orders').textContent = String(rows.reduce((s, r) => s + r.orders, 0));
  $('tot-spend').textContent = money(rows.reduce((s, r) => s + r.spend, 0));
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page >= pages;
  document.querySelectorAll('th[data-key]').forEach((th) => {
    if (th.dataset.key === state.sort) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
  $('q').value = state.q;
  $('size').value = String(state.size);
  writeHash();
}

document.querySelectorAll('th[data-key]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.key;
  state.dir = state.sort === k && state.dir === 'asc' ? 'desc' : 'asc';
  state.sort = k;
  render();
}));
$('q').addEventListener('input', (e) => { state.q = e.target.value; state.page = 1; render(); });
$('size').addEventListener('change', (e) => { state.size = +e.target.value; state.page = 1; render(); });
$('prev').addEventListener('click', () => { state.page -= 1; render(); });
$('next').addEventListener('click', () => { state.page += 1; render(); });
window.addEventListener('hashchange', () => { readHash(); render(); });

readHash();
fetch('data.json').then((r) => r.json()).then((rows) => { data = rows; render(); });
