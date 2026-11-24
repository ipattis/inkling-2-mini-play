(function () {
  "use strict";

  var SORT_KEYS = ["name", "city", "signup", "orders", "spend"];
  var PAGE_SIZES = [10, 25, 50];

  var data = [];
  var loaded = false;
  var errorMsg = null;
  var state = {
    sort: "name",
    dir: "asc",
    q: "",
    page: 1,
    size: 10
  };

  var els = {
    search: document.getElementById("search"),
    size: document.getElementById("size"),
    status: document.getElementById("status"),
    tbody: document.getElementById("tbody"),
    tfootLabel: document.getElementById("total-label"),
    totalOrders: document.getElementById("total-orders"),
    totalSpend: document.getElementById("total-spend"),
    prev: document.getElementById("prev"),
    next: document.getElementById("next"),
    pageInfo: document.getElementById("page-info"),
    ths: Array.prototype.slice.call(document.querySelectorAll("thead th"))
  };

  var money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  var collator = new Intl.Collator("en", { sensitivity: "base" });

  function readHash() {
    var h = location.hash.replace(/^#/, "");
    var p = new URLSearchParams(h);
    var sort = p.get("sort");
    var dir = p.get("dir");
    var sizeRaw = parseInt(p.get("size"), 10);
    return {
      sort: SORT_KEYS.indexOf(sort) !== -1 ? sort : "name",
      dir: dir === "desc" ? "desc" : "asc",
      q: p.get("q") || "",
      page: Math.max(1, parseInt(p.get("page"), 10) || 1),
      size: PAGE_SIZES.indexOf(sizeRaw) !== -1 ? sizeRaw : 10
    };
  }

  function writeHash() {
    var p = new URLSearchParams();
    p.set("sort", state.sort);
    p.set("dir", state.dir);
    p.set("q", state.q);
    p.set("page", String(state.page));
    p.set("size", String(state.size));
    history.replaceState(null, "", "#" + p.toString());
  }

  function getFiltered() {
    var q = state.q.trim().toLowerCase();
    return data.filter(function (r) {
      if (!q) return true;
      return r.name.toLowerCase().indexOf(q) !== -1 ||
             r.city.toLowerCase().indexOf(q) !== -1;
    });
  }

  function getSorted(rows) {
    var mul = state.dir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var cmp = 0;
      switch (state.sort) {
        case "name":
        case "city":
          cmp = collator.compare(a[state.sort], b[state.sort]);
          break;
        case "signup":
          cmp = a.signup < b.signup ? -1 : (a.signup > b.signup ? 1 : 0);
          break;
        case "orders":
          cmp = a.orders - b.orders;
          break;
        case "spend":
          cmp = a.spend - b.spend;
          break;
      }
      if (cmp === 0) return a.id - b.id; // tie-break: id ascending, both directions
      return cmp * mul;
    });
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDate(s) {
    if (typeof s !== "string") return String(s);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + "-" + m[2] + "-" + m[3];
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function syncAriaSort() {
    els.ths.forEach(function (th) {
      if (th.dataset.key === state.sort) {
        th.setAttribute("aria-sort", state.dir === "asc" ? "ascending" : "descending");
      } else {
        th.removeAttribute("aria-sort");
      }
    });
  }

  function renderSimpleRow(text, className) {
    clearChildren(els.tbody);
    var tr = document.createElement("tr");
    tr.className = className;
    var td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = text;
    tr.appendChild(td);
    els.tbody.appendChild(tr);
  }

  function render() {
    var totalPages, start, pageRows, totalMatches, totalOrders, totalSpend;
    var from, to;
    var i;

    syncAriaSort();

    if (errorMsg) {
      renderSimpleRow(errorMsg, "error");
      els.status.textContent = "";
      els.pageInfo.textContent = "";
      els.prev.disabled = true;
      els.next.disabled = true;
      els.totalOrders.textContent = "";
      els.totalSpend.textContent = "";
      els.tfootLabel.textContent = "Total";
      return;
    }

    if (!loaded) {
      renderSimpleRow("Loading…", "no-results");
      els.status.textContent = "";
      els.pageInfo.textContent = "";
      els.prev.disabled = true;
      els.next.disabled = true;
      els.totalOrders.textContent = "";
      els.totalSpend.textContent = "";
      els.tfootLabel.textContent = "Total";
      return;
    }

    var filtered = getSorted(getFiltered());
    totalMatches = filtered.length;
    totalOrders = 0;
    totalSpend = 0;
    for (i = 0; i < filtered.length; i++) {
      totalOrders += filtered[i].orders;
      totalSpend += filtered[i].spend;
    }

    totalPages = Math.max(1, Math.ceil(totalMatches / state.size));
    var pageChanged = false;
    if (state.page > totalPages) { state.page = totalPages; pageChanged = true; }
    if (state.page < 1) { state.page = 1; pageChanged = true; }

    start = (state.page - 1) * state.size;
    pageRows = filtered.slice(start, start + state.size);

    clearChildren(els.tbody);
    if (pageRows.length === 0) {
      renderSimpleRow("No results", "no-results");
    } else {
      pageRows.forEach(function (r) {
        var tr = document.createElement("tr");
        var cells = [
          String(r.name),
          String(r.city),
          formatDate(r.signup),
          String(r.orders),
          money.format(r.spend)
        ];
        for (var j = 0; j < cells.length; j++) {
          var td = document.createElement("td");
          if (j >= 3) td.className = "num";
          td.textContent = cells[j];
          tr.appendChild(td);
        }
        els.tbody.appendChild(tr);
      });
    }

    // tfoot totals (all rows matching the current search, not just the page)
    els.tfootLabel.textContent = "Total (" + totalMatches + " match" + (totalMatches === 1 ? "" : "es") + ")";
    els.totalOrders.textContent = String(totalOrders);
    els.totalSpend.textContent = money.format(totalSpend);

    // Status line
    from = totalMatches === 0 ? 0 : start + 1;
    to = start + pageRows.length;
    els.status.textContent = "Showing " + from + "–" + to + " of " + totalMatches;

    // Page info + buttons
    els.pageInfo.textContent = "Page " + state.page + " of " + totalPages;
    els.prev.disabled = state.page <= 1;
    els.next.disabled = state.page >= totalPages;

    // Sync controls
    if (els.search.value !== state.q) els.search.value = state.q;
    if (els.size.value !== String(state.size)) els.size.value = String(state.size);

    if (pageChanged) writeHash();
  }

  function updateAndRender() {
    writeHash();
    render();
  }

  // Events
  els.ths.forEach(function (th) {
    var btn = th.querySelector("button");
    btn.addEventListener("click", function () {
      var key = th.dataset.key;
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = "asc";
      }
      updateAndRender();
    });
  });

  els.search.addEventListener("input", function () {
    state.q = els.search.value;
    state.page = 1;
    updateAndRender();
  });

  els.size.addEventListener("change", function () {
    var s = parseInt(els.size.value, 10);
    if (PAGE_SIZES.indexOf(s) !== -1) state.size = s;
    state.page = 1;
    updateAndRender();
  });

  els.prev.addEventListener("click", function () {
    if (state.page > 1) {
      state.page -= 1;
      updateAndRender();
    }
  });

  els.next.addEventListener("click", function () {
    if (!loaded) return;
    var totalPages = Math.max(1, Math.ceil(getSorted(getFiltered()).length / state.size));
    if (state.page < totalPages) {
      state.page += 1;
      updateAndRender();
    }
  });

  window.addEventListener("hashchange", function () {
    state = readHash();
    render();
  });

  // Boot
  state = readHash();
  render();

  fetch("data.json")
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (rows) {
      data = Array.isArray(rows) ? rows : [];
      loaded = true;
      errorMsg = null;
      writeHash();
      render();
    })
    .catch(function () {
      loaded = false;
      errorMsg = "Failed to load data.json";
      render();
    });
})();
