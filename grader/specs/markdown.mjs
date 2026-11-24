// Checks for tasks/markdown/task.md, one per stated requirement.
import fs from 'node:fs';
import path from 'node:path';

export const id = 'markdown';
export const title = 'Markdown editor';

// Capture what "Copy HTML" puts on the clipboard (async API or execCommand).
const CLIPBOARD_SPY = `(() => {
  const store = { text: null };
  window.__copied = () => store.text;
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (t) => { store.text = String(t); },
      write: async (items) => { try { const b = await items[0].getType('text/plain'); store.text = await b.text(); } catch { store.text = store.text || '[non-text]'; } },
      readText: async () => store.text || '',
    } });
  } catch {}
  document.addEventListener('copy', (e) => {
    setTimeout(() => {
      if (store.text) return;
      const a = document.activeElement;
      store.text = String(window.getSelection()) || (a && 'value' in a ? a.value.slice(a.selectionStart, a.selectionEnd) || a.value : '');
    }, 0);
  }, true);
})();`;

async function setSource(page, text) {
  await page.fill('#editor', text);
  await page.waitForTimeout(80);
}
const q = (page, fn, arg) => page.$eval('#preview', fn, arg);

export async function run(t) {
  await t.check('files', 'index.html, styles.css and app.js exist', () => {
    const missing = ['index.html', 'styles.css', 'app.js'].filter((f) => !fs.existsSync(path.join(t.dir, f)));
    return { pass: !missing.length, detail: missing.length ? `missing ${missing.join(', ')}` : '' };
  });

  let page;
  try { page = await t.newPage({ init: CLIPBOARD_SPY }); } catch (e) {
    await t.check('loads', 'Page loads', () => ({ pass: false, detail: String(e.message).slice(0, 160) }));
    return;
  }

  const ok = await t.check('structure', '<textarea id="editor">, #preview and #status exist', async () => {
    const s = await page.evaluate(() => ({
      editor: document.getElementById('editor')?.tagName, preview: !!document.getElementById('preview'), status: !!document.getElementById('status'),
    }));
    return { pass: s.editor === 'TEXTAREA' && s.preview && s.status, detail: JSON.stringify(s) };
  });
  if (!ok) { await page.context().close(); return; }

  await t.check('headings', '# … ###### → <h1> … <h6> (also on consecutive lines)', async () => {
    await setSource(page, '# One\n## Two\n###### Six');
    const r = await q(page, (el) => ['h1', 'h2', 'h6'].map((h) => el.querySelector(h)?.textContent.trim() ?? null));
    return { pass: r[0] === 'One' && r[1] === 'Two' && r[2] === 'Six', detail: `h1=${r[0]} h2=${r[1]} h6=${r[2]}` };
  });

  await t.check('paragraphs', 'Blank lines separate <p> paragraphs', async () => {
    await setSource(page, 'first para\n\nsecond para');
    const ps = await q(page, (el) => [...el.querySelectorAll('p')].map((p) => p.textContent.trim()));
    return { pass: ps.length === 2 && ps[0] === 'first para' && ps[1] === 'second para', detail: JSON.stringify(ps) };
  });

  await t.check('inline', '**bold**, *italic*, _italic_ and `code`', async () => {
    await setSource(page, 'a **bold** b *it* c _em_ d `x < y`');
    const r = await q(page, (el) => ({
      strong: el.querySelector('strong')?.textContent, em: [...el.querySelectorAll('em')].map((e) => e.textContent), code: el.querySelector('code')?.textContent,
    }));
    return { pass: r.strong === 'bold' && r.em.includes('it') && r.em.includes('em') && r.code === 'x < y', detail: JSON.stringify(r) };
  });

  await t.check('links', '[text](url) → <a> for http(s) and mailto', async () => {
    await setSource(page, '[site](https://example.com/a?b=1) and [mail](mailto:hi@example.com)');
    const r = await q(page, (el) => [...el.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent]));
    const okA = r.some(([h, x]) => h === 'https://example.com/a?b=1' && x === 'site');
    const okB = r.some(([h, x]) => h === 'mailto:hi@example.com' && x === 'mail');
    return { pass: okA && okB, detail: JSON.stringify(r) };
  });

  await t.check('unsafe-links', 'javascript: (and other) links render as plain text', async () => {
    await setSource(page, '[click](javascript:alert(1)) and [data](data:text/html,hi)');
    const r = await q(page, (el) => ({ anchors: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')), text: el.textContent }));
    const bad = r.anchors.filter((h) => !/^(https?:|mailto:)/i.test(h || ''));
    return { pass: bad.length === 0 && r.text.includes('click'), detail: bad.length ? `unsafe hrefs: ${bad.join(', ')}` : '' };
  });

  await t.check('lists', 'Unordered (- / *) and ordered (1.) lists', async () => {
    await setSource(page, '- apple\n* pear\n\n1. one\n2. two\n3. three');
    const r = await q(page, (el) => ({
      ul: [...(el.querySelector('ul')?.querySelectorAll('li') || [])].map((li) => li.textContent.trim()),
      ol: [...(el.querySelector('ol')?.querySelectorAll('li') || [])].map((li) => li.textContent.trim()),
    }));
    return { pass: r.ul.join(',') === 'apple,pear' && r.ol.join(',') === 'one,two,three', detail: JSON.stringify(r) };
  });

  await t.check('code-block', 'Fenced code blocks keep their contents exactly', async () => {
    const body = '**not bold** <b>tag</b>\n# not a heading\n  indented';
    await setSource(page, `before\n\n\`\`\`\n${body}\n\`\`\`\n\nafter`);
    const r = await q(page, (el) => ({ code: el.querySelector('pre code, pre')?.textContent ?? null, extra: el.querySelectorAll('pre strong, pre b, pre h1').length, h1: el.querySelectorAll('h1').length }));
    return { pass: (r.code || '').replace(/\n$/, '') === body && r.extra === 0 && r.h1 === 0, detail: JSON.stringify(r.code) };
  });

  await t.check('blockquote', '> lines → <blockquote>', async () => {
    await setSource(page, '> wise words');
    const r = await q(page, (el) => el.querySelector('blockquote')?.textContent.trim() ?? null);
    return { pass: r === 'wise words', detail: String(r) };
  });

  await t.check('hr', 'A line of --- → <hr>', async () => {
    await setSource(page, 'above\n\n---\n\nbelow');
    const n = await q(page, (el) => el.querySelectorAll('hr').length);
    return { pass: n === 1, detail: `${n} <hr>` };
  });

  await t.check('no-raw-html', 'Raw HTML shows as text and never runs', async () => {
    await setSource(page, 'x <img src="data:," onerror="window.__pwned=1"> <script>window.__pwned2=1</script> <b>raw</b>');
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      els: document.querySelectorAll('#preview img, #preview script, #preview b').length,
      ran: window.__pwned === 1 || window.__pwned2 === 1,
      text: document.getElementById('preview').textContent,
    }));
    return { pass: r.els === 0 && !r.ran && r.text.includes('<b>raw</b>'), detail: `elements: ${r.els}, script ran: ${r.ran}` };
  });

  await t.check('live', 'Preview updates while typing', async () => {
    await page.fill('#editor', '');
    await page.focus('#editor');
    await page.keyboard.type('# Live title', { delay: 15 });
    await page.waitForTimeout(150);
    const h = await q(page, (el) => el.querySelector('h1')?.textContent.trim() ?? null);
    return { pass: h === 'Live title', detail: String(h) };
  });

  await t.check('counts', 'Status shows word and character counts', async () => {
    await setSource(page, 'hello world foo');
    const s = await page.textContent('#status');
    return { pass: /\b3 words?\b/i.test(s) && /\b15 char/i.test(s), detail: s.trim() };
  });

  await t.check('autosave', 'Text autosaves and is restored on reload', async () => {
    await setSource(page, 'saved **here**');
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    const v = await page.inputValue('#editor');
    const strong = await q(page, (el) => el.querySelector('strong')?.textContent ?? null);
    return { pass: v === 'saved **here**' && strong === 'here', detail: `editor "${v}", preview strong "${strong}"` };
  });

  await t.check('copy-html', '"Copy HTML" copies the rendered HTML', async () => {
    await setSource(page, '# Copy me');
    const btn = page.getByRole('button', { name: /copy/i }).first();
    if (!(await btn.count())) return { pass: false, detail: 'no Copy button' };
    await btn.click();
    await page.waitForTimeout(250);
    const copied = await page.evaluate(() => window.__copied());
    return { pass: /<h1[^>]*>\s*Copy me\s*<\/h1>/i.test(copied || ''), detail: String(copied).slice(0, 80) };
  });

  await t.screenshot(page, 'desktop');
  await t.check('side-by-side', 'Editor and preview side by side on desktop', async () => {
    const r = await page.evaluate(() => {
      const a = document.getElementById('editor').getBoundingClientRect();
      const b = document.getElementById('preview').getBoundingClientRect();
      return { aRight: a.right, bLeft: b.left, aTop: a.top, bTop: b.top };
    });
    return { pass: r.bLeft >= r.aRight - 2 && Math.abs(r.aTop - r.bTop) < 120, detail: JSON.stringify(r) };
  });
  await page.context().close();

  await t.check('stacked-360', 'Stacked (editor above preview) at 360px, no sideways scroll', async () => {
    const p = await t.newPage({ viewport: { width: 360, height: 740 } });
    const r = await p.evaluate(() => {
      const a = document.getElementById('editor').getBoundingClientRect();
      const b = document.getElementById('preview').getBoundingClientRect();
      return { aBottom: a.bottom, bTop: b.top, sw: document.documentElement.scrollWidth, iw: innerWidth };
    });
    await t.screenshot(p, 'mobile');
    await p.context().close();
    return { pass: r.bTop >= r.aBottom - 2 && r.sw <= r.iw + 1, detail: JSON.stringify(r) };
  });

  await t.check('no-external', 'No external requests (no Markdown library / CDN)', () => ({ pass: t.external.size === 0, detail: [...t.external].join(', ') }));
  await t.check('no-errors', 'No JavaScript errors', () => ({ pass: t.errors.length === 0, detail: t.errors.slice(0, 2).join(' | ') }));
}

export const selftest = (edit) => [
  ['reference', [], () => {}],
  ['renders raw HTML', ['no-raw-html', 'code-block'], edit('app.js', "const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');", 'const esc = (s) => s;')],
  ['javascript: links allowed', ['unsafe-links'], edit('app.js', "return /^(https?:|mailto:)/i.test(raw) ? `<a href=\"${url}\">${label}</a>` : label;", 'return `<a href="${url}">${label}</a>`;')],
  ['no autosave', ['autosave'], edit('app.js', 'localStorage.setItem(KEY, src);', '')],
  ['never stacks', ['stacked-360'], edit('styles.css', '@media (max-width: 699px) { main { grid-template-columns: 1fr; } }', '')],
  ['copy button missing', ['copy-html'], edit('index.html', '<button id="copy" type="button">Copy HTML</button>', '<span id="copy"></span>')],
];
