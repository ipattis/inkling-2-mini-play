(function () {
  'use strict';

  var COLUMNS = ['name', 'city', 'signup', 'orders', 'spend'];
  var SIZES = [10, 25, 50];
  var DEFAULT_SIZE = 10;
  var EN_DASH = '–';

  var money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  var records = [];
  var state = defaultState();
  var loaded = false;

  var els = {
    search: document.getElementById('search'),
    size: document.getElementById('size'),
    status: document.getElementById('status'),
    rows: document.getElementById('rows'),
    totalOrders: document.getElementById('total-orders'),
    totalSpend: document.getElementById('total-spend'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    pageInfo: document.getElementById('page-info'),
    headers: Array.prototype.slice.call(document.querySelectorAll('thead th[data-col]'))
  };

  function defaultState() {
    return { sort: null, dir: 'asc', q: '', page: 1, size: DEFAULT_SIZE };
  }

  // Parse the URL hash into state, falling back to defaults for anything invalid.
  function parseHash(hash) {
    var params = new URLSearchParams(hash.replace(/^#/, ''));
    var s = defaultState();

    var sort = params.get('sort');
    if (COLUMNS.indexOf(sort) !== -1) s.sort = sort;
    if (params.get('dir') === 'desc') s.dir = 'desc';

    s.q = params.get('q') || '';

    var page = parseInt(params.get('page'), 10);
    if (page >= 1) s.page = page;

    var size = parseInt(params.get('size'), 10);
    if (SIZES.indexOf(size) !== -1) s.size = size;

    return s;
  }

  function toHash(s) {
    var params = new URLSearchParams();
    if (s.sort) {
      params.set('sort', s.sort);
      params.set('dir', s.dir);
    }
    if (s.q) params.set('q', s.q);
    params.set('page', String(s.page));
    params.set('size', String(s.size));
    return '#' + params.toString();
  }

  function matchingRows() {
    var q = state.q.toLowerCase();
    if (!q) return records.slice();
    return records.filter(function (r) {
      return String(r.name).toLowerCase().indexOf(q) !== -1 ||
             String(r.city).toLowerCase().indexOf(q) !== -1;
    });
  }

  function normalize(v) {
    return typeof v === 'string' ? v.toLowerCase() : v;
  }

  // Sort by the chosen column; ties always fall back to id ascending.
  function sortRows(rows) {
    var key = state.sort;
    var sign = state.dir === 'desc' ? -1 : 1;
    return rows.slice().sort(function (a, b) {
      var r = 0;
      if (key) {
        var x = normalize(a[key]);
        var y = normalize(b[key]);
        r = x < y ? -1 : (x > y ? 1 : 0);
        r *= sign;
      }
      if (r === 0) r = a.id - b.id;
      return r;
    });
  }

  function cell(text, className) {
    var td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function render() {
    if (!loaded) return;

    var matches = matchingRows();
    var n = matches.length;
    var totalPages = Math.max(1, Math.ceil(n / state.size));
    state.page = Math.min(Math.max(1, state.page), totalPages);

    var start = (state.page - 1) * state.size;
    var pageRows = sortRows(matches).slice(start, start + state.size);

    // Table body
    els.rows.textContent = '';
    if (n === 0) {
      var tr = document.createElement('tr');
      tr.className = 'empty';
      var td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'No results';
      tr.appendChild(td);
      els.rows.appendChild(tr);
    } else {
      pageRows.forEach(function (r) {
        var row = document.createElement('tr');
        row.appendChild(cell(r.name));
        row.appendChild(cell(r.city));
        row.appendChild(cell(r.signup));
        row.appendChild(cell(String(r.orders), 'num'));
        row.appendChild(cell(money.format(r.spend), 'num'));
        els.rows.appendChild(row);
      });
    }

    // Footer totals over all matching rows (integer cents avoid float drift)
    var totalOrders = 0;
    var totalCents = 0;
    matches.forEach(function (r) {
      totalOrders += r.orders;
      totalCents += Math.round(r.spend * 100);
    });
    els.totalOrders.textContent = String(totalOrders);
    els.totalSpend.textContent = money.format(totalCents / 100);

    // Status line
    if (n === 0) {
      els.status.textContent = 'No results';
    } else {
      var end = start + pageRows.length;
      els.status.textContent = 'Showing ' + (start + 1) + EN_DASH + end + ' of ' + n;
    }

    // Pager
    els.prev.disabled = state.page <= 1;
    els.next.disabled = state.page >= totalPages;
    els.pageInfo.textContent = 'Page ' + state.page + ' of ' + totalPages;

    // Sort indicators
    els.headers.forEach(function (th) {
      var col = th.getAttribute('data-col');
      if (state.sort === col) {
        th.setAttribute('aria-sort', state.dir === 'desc' ? 'descending' : 'ascending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });

    // Controls (only touch the DOM when the value differs, so typing keeps focus)
    if (els.search.value !== state.q) els.search.value = state.q;
    els.size.value = String(state.size);

    // Keep URL in sync without adding history entries
    var hash = toHash(state);
    if (window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  }

  function syncFromHash() {
    state = parseHash(window.location.hash);
    render();
  }

  function bindEvents() {
    els.search.addEventListener('input', function () {
      state.q = els.search.value;
      state.page = 1;
      render();
    });

    els.size.addEventListener('change', function () {
      state.size = parseInt(els.size.value, 10);
      state.page = 1;
      render();
    });

    els.headers.forEach(function (th) {
      th.querySelector('button').addEventListener('click', function () {
        var col = th.getAttribute('data-col');
        if (state.sort === col) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = col;
          state.dir = 'asc';
        }
        state.page = 1;
        render();
      });
    });

    els.prev.addEventListener('click', function () {
      state.page -= 1;
      render();
    });

    els.next.addEventListener('click', function () {
      state.page += 1;
      render();
    });

    window.addEventListener('hashchange', syncFromHash);
    window.addEventListener('popstate', syncFromHash);
  }

  fetch('data.json')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      records = data;
      loaded = true;
      state = parseHash(window.location.hash);
      bindEvents();
      render();
    })
    .catch(function (err) {
      els.status.textContent = 'Could not load data.json (' + err.message + ')';
    });
})();
