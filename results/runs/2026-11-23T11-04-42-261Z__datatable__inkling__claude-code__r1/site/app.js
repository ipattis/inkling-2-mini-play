(() => {
  'use strict';

  const SORT_KEYS = ['name', 'city', 'signup', 'orders', 'spend'];
  const SIZES = [10, 25, 50];

  const tbody = document.getElementById('tbody');
  const statusEl = document.getElementById('status');
  const emptyEl = document.getElementById('empty');
  const totalOrdersEl = document.getElementById('total-orders');
  const totalSpendEl = document.getElementById('total-spend');
  const searchInput = document.getElementById('search');
  const sizeSelect = document.getElementById('page-size');
  const prevBtn = document.getElementById('prev');
  const nextBtn = document.getElementById('next');
  const pageIndicator = document.getElementById('page-indicator');
  const thCells = Array.from(document.querySelectorAll('thead th[data-key]'));

  let records = [];
  let state = { sort: 'name', dir: 'asc', q: '', page: 1, size: 10 };

  const fmtMoney = (n) =>
    '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = (n) => n.toLocaleString('en-US');

  function parseHash() {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const s = { ...state };

    const sort = params.get('sort');
    if (SORT_KEYS.includes(sort)) s.sort = sort;

    const dir = params.get('dir');
    if (dir === 'asc' || dir === 'desc') s.dir = dir;

    const q = params.get('q');
    if (q !== null) s.q = q;

    const page = parseInt(params.get('page'), 10);
    if (Number.isFinite(page) && page >= 1) s.page = page;

    const size = parseInt(params.get('size'), 10);
    if (SIZES.includes(size)) s.size = size;

    return s;
  }

  function writeHash() {
    const params = new URLSearchParams({
      sort: state.sort,
      dir: state.dir,
      q: state.q,
      page: String(state.page),
      size: String(state.size),
    });
    history.replaceState(null, '', '#' + params.toString());
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    if (!q) return records.slice();
    return records.filter(
      (r) => r.name.toLowerCase().includes(q) || r.city.toLowerCase().includes(q)
    );
  }

  function compare(a, b) {
    const key = state.sort;
    let cmp = 0;
    if (key === 'orders' || key === 'spend') {
      cmp = a[key] - b[key];
    } else if (key === 'signup') {
      cmp = a.signup < b.signup ? -1 : a.signup > b.signup ? 1 : 0;
    } else {
      cmp = a[key].localeCompare(b[key], undefined, { sensitivity: 'base' });
    }
    if (cmp === 0) return a.id - b.id;
    return state.dir === 'asc' ? cmp : -cmp;
  }

  function render() {
    const filteredRows = filtered();
    filteredRows.sort(compare);

    const total = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(total / state.size));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const start = (state.page - 1) * state.size;
    const pageRows = filteredRows.slice(start, start + state.size);

    // rows
    tbody.innerHTML = '';
    for (const r of pageRows) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = r.name;
      const tdCity = document.createElement('td');
      tdCity.textContent = r.city;
      const tdSignup = document.createElement('td');
      tdSignup.textContent = r.signup;
      const tdOrders = document.createElement('td');
      tdOrders.className = 'num';
      tdOrders.textContent = fmtInt(r.orders);
      const tdSpend = document.createElement('td');
      tdSpend.className = 'num';
      tdSpend.textContent = fmtMoney(r.spend);

      tr.append(tdName, tdCity, tdSignup, tdOrders, tdSpend);
      tbody.appendChild(tr);
    }

    // empty state
    emptyEl.hidden = total > 0;

    // totals (all matching rows)
    const totalOrders = filteredRows.reduce((s, r) => s + r.orders, 0);
    const totalSpend = filteredRows.reduce((s, r) => s + r.spend, 0);
    totalOrdersEl.textContent = fmtInt(totalOrders);
    totalSpendEl.textContent = fmtMoney(totalSpend);

    // status line
    const from = total === 0 ? 0 : start + 1;
    const to = Math.min(start + state.size, total);
    statusEl.textContent = `Showing ${from}–${to} of ${total}`;

    // header sort indicators / aria
    const labels = { name: 'Name', city: 'City', signup: 'Signup date', orders: 'Orders', spend: 'Spend' };
    const arrow = state.dir === 'asc' ? ' ▲' : ' ▼';
    for (const th of thCells) {
      const btn = th.querySelector('.sort-btn');
      if (th.dataset.key === state.sort) {
        th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
        btn.textContent = labels[th.dataset.key] + arrow;
      } else {
        th.removeAttribute('aria-sort');
        btn.textContent = labels[th.dataset.key];
      }
    }

    // pagination
    prevBtn.disabled = state.page <= 1;
    nextBtn.disabled = state.page >= totalPages;
    pageIndicator.textContent = `Page ${state.page} of ${totalPages}`;

    // inputs
    if (searchInput.value !== state.q) searchInput.value = state.q;
    if (sizeSelect.value !== String(state.size)) sizeSelect.value = String(state.size);

    writeHash();
  }

  // events
  for (const th of thCells) {
    th.querySelector('.sort-btn').addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sort === key) {
        state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = key;
        state.dir = 'asc';
      }
      render();
    });
  }

  searchInput.addEventListener('input', () => {
    state.q = searchInput.value;
    state.page = 1;
    render();
  });

  sizeSelect.addEventListener('change', () => {
    state.size = parseInt(sizeSelect.value, 10);
    state.page = 1;
    render();
  });

  prevBtn.addEventListener('click', () => {
    if (state.page > 1) { state.page -= 1; render(); }
  });
  nextBtn.addEventListener('click', () => {
    state.page += 1; // render clamps
    render();
  });

  window.addEventListener('hashchange', () => {
    state = parseHash();
    render();
  });

  fetch('data.json')
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load data.json: ${res.status}`);
      return res.json();
    })
    .then((data) => {
      records = Array.isArray(data) ? data : [];
      state = parseHash();
      render();
    })
    .catch((err) => {
      statusEl.textContent = 'Error: ' + err.message;
    });
})();
