Build a mini spreadsheet as a single-page web app in the current directory: index.html, styles.css and app.js. No frameworks, no CDNs, no build step, and no eval() or new Function(): write your own formula parser.

Grid
- 8 columns (A–H) by 12 rows (1–12), with column letters and row numbers as headers.
- Every cell is an <input> with a data-cell attribute holding its address, e.g. <input data-cell="B3">.
- A cell that is not being edited shows its computed value. When focused it shows the raw content that was entered (e.g. "=A1+1").
- An edit is committed on Enter or when the cell loses focus. Enter also moves focus to the cell below.

Values and formulas
- A cell holds a number, text, or a formula starting with "=".
- Formulas support numbers, cell references (case-insensitive: A1 or a1), + - * / with the usual precedence, unary minus, parentheses, and the functions SUM, AVG and MAX. Functions take ranges (A1:A5), comma-separated arguments (SUM(A1, B2, 3)), or a mix.
- Empty cells count as 0. Using a text cell in arithmetic is an error.
- Results show no floating-point noise: =0.1+0.2 shows 0.3.
- Changing a cell recalculates every cell that depends on it, directly or through other cells.

Errors (shown in the cell instead of a value)
- #DIV/0! for division by zero.
- #REF! for a reference outside A1:H12.
- #CIRC! for a circular reference, shown in every cell of the cycle.
- #ERR! for anything else that can't be parsed or evaluated.
- A formula that uses a cell holding an error also shows an error.

Also
- The sheet is saved in localStorage and restored on reload.
- A "Clear" button empties every cell and the saved sheet.
- Clean, readable styling.

When finished, reply with a one-line summary.
