Build a Markdown editor with live preview as a single-page web app in the current directory: index.html, styles.css and app.js. No frameworks, no CDNs, no build step, and no Markdown library: write the parser yourself.

Layout
- A <textarea id="editor"> and a preview <div id="preview"> side by side, stacked (editor above preview) on screens narrower than 700px.
- The preview updates as you type.

Supported syntax
- Headings: # to ###### become <h1> to <h6>.
- Paragraphs: blocks of text separated by blank lines become <p>.
- Inline: **bold** → <strong>, *italic* or _italic_ → <em>, `code` → <code>.
- Links: [text](url) → <a href="url">text</a>. Only http:, https: and mailto: URLs become links; any other link renders as plain text.
- Lists: lines starting with "- " or "* " → <ul><li>; lines starting with "1. ", "2. " … → <ol><li>.
- Fenced code blocks: lines between ``` fences → <pre><code>, with the contents shown exactly as written and no Markdown processing inside.
- Blockquotes: lines starting with "> " → <blockquote>.
- A line containing only --- → <hr>.

Safety
- Raw HTML in the input is shown as text, never rendered, so <script> or <img onerror> can't run.

Also
- A status bar with id="status" shows the word and character count of the source, e.g. "12 words · 68 characters".
- The text autosaves to localStorage and is restored on reload.
- A "Copy HTML" button copies the rendered HTML to the clipboard.

When finished, reply with a one-line summary.
