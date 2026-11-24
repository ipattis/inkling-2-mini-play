// Known-good reference for the Markdown task (used by grader/selftest.mjs).
const KEY = 'reference-md';
const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const status = document.getElementById('status');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Inline: escape everything first, then add the few tags we allow.
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const raw = url.replace(/&amp;/g, '&');
    return /^(https?:|mailto:)/i.test(raw) ? `<a href="${url}">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

function render(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // {tag, items}
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^---\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/)) || (m = line.match(/^\d+\.\s+(.*)$/))) {
      flushPara();
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(m[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

function update() {
  const src = editor.value;
  preview.innerHTML = render(src);
  const words = src.trim() ? src.trim().split(/\s+/).length : 0;
  status.textContent = `${words} words · ${src.length} characters`;
  localStorage.setItem(KEY, src);
}

editor.addEventListener('input', update);
document.getElementById('copy').addEventListener('click', () => navigator.clipboard.writeText(preview.innerHTML));
editor.value = localStorage.getItem(KEY) || '# Hello\n\nStart typing **Markdown**.';
update();
