(function () {
  "use strict";

  const COLUMNS = ["name", "city", "signup", "orders", "spend"];
  const EN_DASH = "\u2013";
  const usd = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  });

  const searchEl = document.getElementById("search");
  const sizeEl = document.getElementById("size");
  const prevEl = document.getElementById("prev");
  const nextEl = document.getElementById("next");
  const tbody = document.getElementById("tbody");
  const tfoot = document.getElementById("tfoot");
  const statusEl = document.getElementById("status");
  const headers = Array.from(document.querySelectorAll("thead th[data-key]"));
  const headerLabels = new Map(
    headers.map((th) => [th, th.textContent.trim()])
  );

  let records = [];

  const state = {
    sort: null, // one of COLUMNS, or null (original id order)
    dir: "asc", // "asc" | "desc"
    q: "",
    page: 1,
    size: 10,
  };

  /* ---------- URL hash state ---------- */

  function parseHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));

    const sort = params.get("sort");
    state.sort = COLUMNS.includes(sort) ? sort : null;

    const dir = params.get("dir");
    state.dir = dir === "desc" ? "desc" : "asc";

    state.q = params.get("q") || "";

    const page = parseInt(params.get("page"), 10);
    state.page = Number.isInteger(page) && page >= 1 ? page : 1;

    const size = parseInt(params.get("size"), 10);
    state.size = [10, 25, 50].includes(size) ? size : 10;
  }

  function writeHash() {
    const parts = [];
    if (state.sort) parts.push("sort=" + encodeURIComponent(state.sort));
    if (state.sort) parts.push("dir=" + state.dir);
    if (state.q) parts.push("q=" + encodeURIComponent(state.q));
    if (state.page > 1) parts.push("page=" + state.page);
    if (state.size !== 10) parts.push("size=" + state.size);
    const hash = parts.length ? "#" + parts.join("&") : "";

    if (location.hash !== hash) {
      history.replaceState(null, "", location.pathname + location.search + hash);
    }
  }

  /* ---------- data helpers ---------- */

  function matchesQuery(record, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      record.name.toLowerCase().includes(needle) ||
      record.city.toLowerCase().includes(needle)
    );
  }

  function compareBy(column) {
    return function (a, b) {
      let cmp = 0;
      if (column === "orders" || column === "spend") {
        cmp = a[column] - b[column];
      } else if (column === "signup") {
        cmp = a.signup < b.signup ? -1 : a.signup > b.signup ? 1 : 0;
      } else {
        const av = a[column].toLowerCase();
        const bv = b[column].toLowerCase();
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      }
      if (cmp !== 0) return cmp;
      return a.id - b.id; // ties: id ascending in both directions
    };
  }

  function currentRows() {
    const q = state.q;
    let rows = records.filter((r) => matchesQuery(r, q));
    if (state.sort) {
      const cmp = compareBy(state.sort);
      rows = rows.slice().sort((a, b) =>
        state.dir === "desc" ? cmp(b, a) : cmp(a, b)
      );
    }
    return rows;
  }

  /* ---------- rendering ---------- */

  function render() {
    const rows = currentRows();
    const total = rows.length;

    // Clamp page into range.
    const maxPage = Math.max(1, Math.ceil(total / state.size));
    if (state.page > maxPage) state.page = maxPage;

    const start = (state.page - 1) * state.size;
    const pageRows = rows.slice(start, start + state.size);

    // Status line.
    if (total === 0) {
      statusEl.innerHTML = '<span class="no-results">No results</span>';
    } else {
      statusEl.textContent =
        "Showing " + (start + 1) + EN_DASH + (start + pageRows.length) + " of " + total;
    }

    // Body.
    if (total === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty-cell">No results</td></tr>';
      tfoot.innerHTML = "";
    } else {
      tbody.innerHTML = pageRows
        .map(
          (r) =>
            "<tr>" +
            "<td>" + escapeHtml(r.name) + "</td>" +
            "<td>" + escapeHtml(r.city) + "</td>" +
            "<td>" + r.signup + "</td>" +
            '<td class="num">' + r.orders + "</td>" +
            '<td class="num">' + usd.format(r.spend) + "</td>" +
            "</tr>"
        )
        .join("");

      const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
      const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
      tfoot.innerHTML =
        "<tr>" +
        "<td colspan=\"3\">Total</td>" +
        '<td class="num">' + totalOrders + "</td>" +
        '<td class="num">' + usd.format(totalSpend) + "</td>" +
        "</tr>";
    }

    // Header aria-sort indicators.
    headers.forEach((th) => {
      const key = th.getAttribute("data-key");
      const label = headerLabels.get(th);
      let arrow = "";
      if (state.sort === key) {
        th.setAttribute(
          "aria-sort",
          state.dir === "asc" ? "ascending" : "descending"
        );
        arrow = '<span class="arrow" aria-hidden="true">' + (state.dir === "asc" ? "\u25B2" : "\u25BC") + "</span>";
      } else {
        th.setAttribute("aria-sort", "none");
      }
      th.innerHTML = label + arrow;
    });

    // Pagination buttons.
    prevEl.disabled = state.page <= 1;
    nextEl.disabled = state.page >= maxPage;

    // Keep controls in sync (e.g. page clamped).
    searchEl.value = state.q;
    sizeEl.value = String(state.size);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- events ---------- */

  searchEl.addEventListener("input", () => {
    state.q = searchEl.value;
    state.page = 1;
    writeHash();
    render();
  });

  sizeEl.addEventListener("change", () => {
    state.size = parseInt(sizeEl.value, 10) || 10;
    state.page = 1;
    writeHash();
    render();
  });

  prevEl.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      writeHash();
      render();
    }
  });

  nextEl.addEventListener("click", () => {
    const maxPage = Math.max(1, Math.ceil(currentRows().length / state.size));
    if (state.page < maxPage) {
      state.page += 1;
      writeHash();
      render();
    }
  });

  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-key");
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = "asc";
      }
      writeHash();
      render();
    });
  });

  window.addEventListener("hashchange", () => {
    parseHash();
    render();
  });

  /* ---------- init ---------- */

  fetch("data.json")
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then((data) => {
      records = data;
      parseHash();
      render();
    })
    .catch((err) => {
      statusEl.innerHTML =
        '<span class="no-results">Failed to load data.json: ' +
        escapeHtml(err.message) +
        "</span>";
      tbody.innerHTML = "";
      tfoot.innerHTML = "";
    });
})();
