'use strict';

/* ---------- Markdown parser (hand-rolled) ---------- */

// Private-use marker used to protect `code` spans from later inline rules.
const CODE_MARK = '';

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline Markdown -> HTML. Input is HTML-escaped first, so any raw HTML in
 * the source can never reach the output unescaped.
 */
function renderInline(text) {
  let out = escapeHtml(text);

  // `code` spans first: contents must not be processed further.
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code>' + c + '</code>');
    return CODE_MARK + (codes.length - 1) + CODE_MARK;
  });

  // Links: [text](url) only for http:, https:, mailto:. Others stay literal.
  out = out.replace(/\[([^\]]*)\]\(([^()\s]+)\)/g, (m, text, url) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      return '<a href="' + url + '">' + text + '</a>';
    }
    return m; // render as plain text: [text](url)
  });

  // **bold** before *italic*
  out = out.replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^\s*](?:[^*]*[^\s*])?)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|\W)_([^\s_](?:[^_]*[^\s_])?)_(?=\W|$)/g, '$1<em>$2</em>');

  // Restore code spans.
  const markRe = new RegExp(CODE_MARK + '(\\d+)' + CODE_MARK, 'g');
  out = out.replace(markRe, (_, i) => codes[Number(i)]);
  return out;
}

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_ITEM_RE = /^[-*] +(.*)$/;
const OL_ITEM_RE = /^\d+\. +(.*)$/;
const QUOTE_RE = /^> ?(.*)$/;
const HR_RE = /^-{3,}\s*$/;

function isBlank(line) {
  return line.trim() === '';
}

function isBlockStart(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    UL_ITEM_RE.test(line) ||
    OL_ITEM_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

/**
 * Block-level parser. `lines` is an array of source lines; returns HTML.
 */
function parseBlocks(lines) {
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code block: contents shown exactly, no Markdown processing.
    if (FENCE_RE.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run past the end for an unclosed fence)
      html += '<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>';
      continue;
    }

    // Headings
    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      html += '<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>';
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      html += '<hr>';
      i++;
      continue;
    }

    // Blockquote: gather consecutive quoted lines, parse them as blocks.
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      html += '<blockquote>' + parseBlocks(buf) + '</blockquote>';
      continue;
    }

    // Unordered lists
    if (UL_ITEM_RE.test(line)) {
      const items = [];
      while (i < lines.length && UL_ITEM_RE.test(lines[i])) {
        items.push(UL_ITEM_RE.exec(lines[i])[1]);
        i++;
      }
      html += '<ul>' + items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + '</ul>';
      continue;
    }

    // Ordered lists
    if (OL_ITEM_RE.test(line)) {
      const items = [];
      while (i < lines.length && OL_ITEM_RE.test(lines[i])) {
        items.push(OL_ITEM_RE.exec(lines[i])[1]);
        i++;
      }
      html += '<ol>' + items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + '</ol>';
      continue;
    }

    // Paragraph: consecutive lines that don't start another block.
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    html += '<p>' + renderInline(buf.join('\n')) + '</p>';
  }

  return html;
}

function renderMarkdown(source) {
  return parseBlocks(source.split('\n'));
}

/* ---------- App ---------- */

const STORAGE_KEY = 'markdown-editor-content';

const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const status = document.getElementById('status');
const copyButton = document.getElementById('copy-html');

function update() {
  preview.innerHTML = renderMarkdown(editor.value);
  updateStatus();
  save();
}

function updateStatus() {
  const text = editor.value;
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  status.textContent = words + ' words · ' + text.length + ' characters';
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, editor.value);
    } catch (e) {
      /* storage unavailable (e.g. private mode) — ignore */
    }
  }, 200);
}

function restore() {
  let saved = '';
  try {
    saved = localStorage.getItem(STORAGE_KEY) || '';
  } catch (e) {
    /* ignore */
  }
  editor.value = saved;
}

function copyHtml() {
  const html = renderMarkdown(editor.value);
  const done = () => {
    copyButton.classList.add('copied');
    copyButton.textContent = 'Copied!';
    setTimeout(() => {
      copyButton.classList.remove('copied');
      copyButton.textContent = 'Copy HTML';
    }, 1200);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(html).then(done).catch(() => fallbackCopy(html, done));
  } else {
    fallbackCopy(html, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (e) {
    /* clipboard unavailable */
  }
  document.body.removeChild(ta);
}

editor.addEventListener('input', update);
copyButton.addEventListener('click', copyHtml);

restore();
update();
