data.json in the current directory holds 137 customer records (fields: id, name, city, signup, orders, spend). Build a single-page data explorer for it: index.html, styles.css and app.js. No frameworks, no CDNs, no build step. Load data.json with fetch, and do not modify it.

Table
- A <table> with one row per record and these columns, in this order: Name, City, Signup date, Orders, Spend.
- Spend shows as US dollars with two decimals and thousands separators (e.g. $1,234.50). Dates show as YYYY-MM-DD.
- A <tfoot> row shows the total Orders and total Spend of all rows that match the current search (not just the current page).

Sorting
- Clicking a column header sorts by that column ascending; clicking the same header again sorts descending.
- Numbers sort numerically, dates chronologically, and text case-insensitively.
- Ties are ordered by id ascending, in both directions.
- The sorted header has aria-sort="ascending" or aria-sort="descending".

Search and pages
- A search box (<input type="search">) filters rows. A row matches when the query appears, ignoring case, in its name or city.
- 10 rows per page, with Previous and Next buttons and a page-size <select> offering 10, 25 and 50.
- A status line reads exactly like "Showing 11–20 of 137" (with an en dash). It reflects the search, so 7 matches give "Showing 1–7 of 7".
- With no matches, show "No results" and no data rows.
- Changing the search or the page size goes back to page 1.

URL state
- The current sort column, direction, search, page and page size are kept in the URL hash, using the keys sort, dir, q, page and size, e.g. #sort=spend&dir=desc&q=ber&page=2&size=25. Sort values are name, city, signup, orders and spend.
- Opening the page with such a hash restores that exact state.

Styling
- Clean and readable. On narrow screens the table scrolls sideways inside its own container instead of making the whole page scroll.

When finished, reply with a one-line summary.
