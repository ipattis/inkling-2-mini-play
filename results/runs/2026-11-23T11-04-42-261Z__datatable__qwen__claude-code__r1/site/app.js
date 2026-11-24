(function () {
  "use strict";

  var SORT_KEYS = ["name", "city", "signup", "orders", "spend"];
  var VALID_SIZES = [10, 25, 50];

  var usd = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  var rowsEl = document.getElementById("rows");
  var statusEl = document.getElementById("status");
  var totalOrdersEl = document.getElementById("totalOrders");
  var totalSpendEl = document.getElementById("totalSpend");
  var searchEl = document.getElementById("search");
  var pageSizeEl = document.getElementById("pageSize");
  var prevBtn = document.getElementById("prev");
  var nextBtn = document.getElementById("next");
  var headers = Array.prototype.slice.call(
    document.querySelectorAll("#customers thead th")
  );

  var state = {
    sort: "name",
    dir: "asc",
    q: "",
    page: 1,
    size: 10
  };

  var all = [];

  // ---------- URL hash ----------

  function parseHash() {
    var p = new URLSearchParams(
      location.hash.replace(/^#/, "")
    );

    var sort = p.get("sort");
    if (SORT_KEYS.indexOf(sort) !== -1) state.sort = sort;

    var dir = p.get("dir");
    if (dir === "asc" || dir === "desc") state.dir = dir;

    var q = p.get("q");
    if (typeof q === "string") state.q = q;

    var page = parseInt(p.get("page"), 10);
    if (Number.isFinite(page) && page >= 1) state.page = page;

    var size = parseInt(p.get("size"), 10);
    if (VALID_SIZES.indexOf(size) !== -1) state.size = size;
  }

  function writeHash() {
    var s =
      "sort=" + encodeURIComponent(state.sort) +
      "&dir=" + state.dir +
      "&q=" + encodeURIComponent(state.q) +
      "&page=" + state.page +
      "&size=" + state.size;
    history.replaceState(null, "", "#" + s);
  }

  // ---------- Derived data ----------

  function filtered() {
    var q = state.q.trim().toLowerCase();
    if (!q) return all.slice();
    return all.filter(function (r) {
      return (
        r.name.toLowerCase().indexOf(q) !== -1 ||
        r.city.toLowerCase().indexOf(q) !== -1
      );
    });
  }

  function compare(a, b) {
    var key = state.sort;
    var va = a[key];
    var vb = b[key];
    var cmp;
    if (key === "orders" || key === "spend") {
      cmp = va - vb;
    } else {
      cmp = String(va).toLowerCase().localeCompare(String(vb).toLowerCase(), "en");
    }
    var sign = state.dir === "desc" ? -1 : 1;
    if (cmp !== 0) return cmp * sign;
    return a.id - b.id; // ties always by id ascending
  }

  // ---------- Rendering ----------

  function render() {
    var rows = filtered().sort(compare);

    var pageCount = Math.max(1, Math.ceil(rows.length / state.size));
    if (state.page > pageCount) state.page = pageCount;
    if (state.page < 1) state.page = 1;

    var start = (state.page - 1) * state.size;
    var pageRows = rows.slice(start, start + state.size);

    rowsEl.textContent = "";
    var frag = document.createDocumentFragment();
    pageRows.forEach(function (r) {
      var tr = document.createElement("tr");

      var nameTd = document.createElement("td");
      nameTd.textContent = r.name;

      var cityTd = document.createElement("td");
      cityTd.textContent = r.city;

      var signupTd = document.createElement("td");
      signupTd.textContent = r.signup;

      var ordersTd = document.createElement("td");
      ordersTd.className = "num";
      ordersTd.textContent = String(r.orders);

      var spendTd = document.createElement("td");
      spendTd.className = "num";
      spendTd.textContent = usd.format(r.spend);

      tr.appendChild(nameTd);
      tr.appendChild(cityTd);
      tr.appendChild(signupTd);
      tr.appendChild(ordersTd);
      tr.appendChild(spendTd);
      frag.appendChild(tr);
    });
    rowsEl.appendChild(frag);

    // Totals over all rows matching the current search.
    var totalOrders = 0;
    var totalSpend = 0;
    rows.forEach(function (r) {
      totalOrders += r.orders;
      totalSpend += r.spend;
    });
    totalOrdersEl.textContent = String(totalOrders);
    totalSpendEl.textContent = usd.format(totalSpend);

    // Status line
    if (rows.length === 0) {
      statusEl.textContent = "No results";
    } else {
      var from = start + 1;
      var to = start + pageRows.length;
      statusEl.textContent =
        "Showing " + from + "–" + to + " of " + rows.length;
    }

    prevBtn.disabled = state.page <= 1;
    nextBtn.disabled = state.page >= pageCount;

    // aria-sort
    headers.forEach(function (th) {
      if (th.getAttribute("data-key") === state.sort) {
        th.setAttribute("aria-sort", state.dir === "desc" ? "descending" : "ascending");
      } else {
        th.removeAttribute("aria-sort");
      }
    });

    writeHash();
  }

  // ---------- Events ----------

  headers.forEach(function (th) {
    th.tabIndex = 0;
    var activate = function () {
      var key = th.getAttribute("data-key");
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = "asc";
      }
      render();
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });

  searchEl.addEventListener("input", function () {
    state.q = searchEl.value;
    state.page = 1;
    render();
  });

  pageSizeEl.addEventListener("change", function () {
    state.size = parseInt(pageSizeEl.value, 10);
    state.page = 1;
    render();
  });

  prevBtn.addEventListener("click", function () {
    state.page -= 1;
    render();
  });

  nextBtn.addEventListener("click", function () {
    state.page += 1;
    render();
  });

  window.addEventListener("hashchange", function () {
    var before = JSON.stringify(state);
    parseHash();
    searchEl.value = state.q;
    pageSizeEl.value = String(state.size);
    if (JSON.stringify(state) !== before) render();
  });

  // ---------- Init ----------

  fetch("data.json")
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      all = data;
      parseHash();
      searchEl.value = state.q;
      pageSizeEl.value = String(state.size);
      render();
    })
    .catch(function (err) {
      statusEl.textContent = "Failed to load data.json: " + err.message;
    });
})();
