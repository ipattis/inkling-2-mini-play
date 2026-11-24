(function () {
  'use strict';

  var SORT_KEYS = ['name', 'city', 'signup', 'orders', 'spend'];
  var SIZES = [10, 25, 50];

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  var intFmt = new Intl.NumberFormat('en-US');

  var records = [];
  var state = { sort: null, dir: 'asc', q: '', page: 1, size: 10 };

  var el = {
    search: document.getElementById('search'),
    size: document.getElementById('size'),
    status: document.getElementById('status'),
    rows: document.getElementById('rows'),
    totalOrders: document.getElementById('total-orders'),
    totalSpend: document.getElementById('total-spend'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    table: document.getElementById('customers')
  };

  // ---- URL hash state -------------------------------------------------

  function parseHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    var sort = params.get('sort');
    var size = parseInt(params.get('size'), 10);
    var page = parseInt(params.get('page'), 10);
    return {
      sort: SORT_KEYS.indexOf(sort) !== -1 ? sort : null,
      dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
      q: params.get('q') || '',
      page: isFinite(page) && page >= 1 ? page : 1,
      size: SIZES.indexOf(size) !== -1 ? size : 10
    };
  }

  function buildHash() {
    var p = new URLSearchParams();
    if (state.sort) {
      p.set('sort', state.sort);
      p.set('dir', state.dir);
    }
    if (state.q) {
      p.set('q', state.q);
    }
    p.set('page', String(state.page));
    p.set('size', String(state.size));
    return p.toString();
  }

  // ---- data helpers ---------------------------------------------------

  function matchesQuery(r, q) {
    return r.name.toLowerCase().indexOf(q) !== -1 || r.city.toLowerCase().indexOf(q) !== -1;
  }

  function getMatches() {
    var q = state.q.toLowerCase();
    var list = records.filter(function (r) { return matchesQuery(r, q); });
    list.sort(compareRecords);
    return list;
  }

  function compareRecords(a, b) {
    var c = 0;
    if (state.sort) {
      var x = a[state.sort];
      var y = b[state.sort];
      if (typeof x === 'string') {
        x = x.toLowerCase();
        y = y.toLowerCase();
      }
      if (x < y) c = -1;
      else if (x > y) c = 1;
      if (state.dir === 'desc') c = -c;
    }
    if (c === 0) c = a.id - b.id; // ties: id ascending in both directions
    return c;
  }

  function totalPages(n) {
    return Math.max(1, Math.ceil(n / state.size));
  }

  function clampPage() {
    var pages = totalPages(getMatches().length);
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
  }

  // ---- rendering ------------------------------------------------------

  function cell(text, cls) {
    var td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  }

  function render() {
    var matches = getMatches();
    var n = matches.length;
    var pages = totalPages(n);
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * state.size;
    var pageRows = matches.slice(start, start + state.size);

    el.rows.textContent = '';
    if (n === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty';
      td.textContent = 'No results';
      tr.appendChild(td);
      el.rows.appendChild(tr);
      el.status.textContent = 'No results';
    } else {
      pageRows.forEach(function (r) {
        var tr = document.createElement('tr');
        tr.appendChild(cell(r.name));
        tr.appendChild(cell(r.city));
        tr.appendChild(cell(r.signup));
        tr.appendChild(cell(intFmt.format(r.orders), 'num'));
        tr.appendChild(cell(usd.format(r.spend), 'num'));
        el.rows.appendChild(tr);
      });
      var end = Math.min(start + state.size, n);
      el.status.textContent = 'Showing ' + (start + 1) + '\u2013' + end + ' of ' + n;
    }

    var sumOrders = 0;
    var sumSpend = 0;
    matches.forEach(function (r) {
      sumOrders += r.orders;
      sumSpend += r.spend;
    });
    el.totalOrders.textContent = intFmt.format(sumOrders);
    el.totalSpend.textContent = usd.format(Math.round(sumSpend * 100) / 100);

    el.prev.disabled = state.page <= 1;
    el.next.disabled = n === 0 || state.page >= pages;

    var buttons = el.table.querySelectorAll('thead button[data-key]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var th = btn.parentNode;
      var key = btn.getAttribute('data-key');
      if (state.sort === key) {
        th.setAttribute('aria-sort', state.dir === 'desc' ? 'descending' : 'ascending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });
  }

  function syncInputs() {
    el.search.value = state.q;
    el.size.value = String(state.size);
  }

  // Update state, reflect it in the URL hash (adds a history entry), and render.
  function setState(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    clampPage();
    var h = buildHash();
    if (window.location.hash.replace(/^#/, '') !== h) {
      window.location.hash = h;
    }
    render();
  }

  // ---- events ---------------------------------------------------------

  el.search.addEventListener('input', function () {
    setState({ q: el.search.value, page: 1 });
  });

  el.size.addEventListener('change', function () {
    setState({ size: parseInt(el.size.value, 10), page: 1 });
  });

  el.prev.addEventListener('click', function () {
    setState({ page: state.page - 1 });
  });

  el.next.addEventListener('click', function () {
    setState({ page: state.page + 1 });
  });

  el.table.querySelector('thead').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-key]');
    if (!btn) return;
    var key = btn.getAttribute('data-key');
    if (state.sort === key) {
      setState({ dir: state.dir === 'asc' ? 'desc' : 'asc', page: 1 });
    } else {
      setState({ sort: key, dir: 'asc', page: 1 });
    }
  });

  window.addEventListener('hashchange', function () {
    state = parseHash();
    clampPage();
    syncInputs();
    var h = buildHash();
    if (window.location.hash.replace(/^#/, '') !== h) {
      history.replaceState(null, '', '#' + h);
    }
    render();
  });

  // ---- startup --------------------------------------------------------

  fetch('data.json')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      records = data;
      state = parseHash();
      clampPage();
      syncInputs();
      history.replaceState(null, '', '#' + buildHash());
      render();
    })
    .catch(function (err) {
      el.status.textContent = 'Could not load data.json (' + err.message + ')';
    });
})();
