(function () {
  'use strict';

  var STORAGE_KEY = 'markdown-editor.text';

  var SAMPLE = [
    '# Hello, Markdown',
    '',
    'This is a **live** preview with *italic*, _underscored italic_, and `inline code`.',
    '',
    '## Lists',
    '',
    '- Unordered item',
    '- Another item',
    '',
    '1. First',
    '2. Second',
    '',
    '> A blockquote line',
    '',
    '[Example link](https://example.com)',
    '',
    '```',
    '**not bold** inside code',
    '```',
    '',
    '---',
    '',
    'Raw <script>HTML</script> is shown as text.'
  ].join('\n');

  /* ---------- Parser ---------- */

  var SAFE_URL = /^(https?:|mailto:)/i;
  var RE_FENCE = /^\s*```/;
  var RE_HEADING = /^(#{1,6})\s+(.*)$/;
  var RE_HR = /^\s*---\s*$/;
  var RE_QUOTE = /^>\s?(.*)$/;
  var RE_UL = /^[-*]\s+(.*)$/;
  var RE_OL = /^\d+\.\s+(.*)$/;

  // Inline placeholders are wrapped in private-use characters U+E000 and U+E001.
  // Those characters are stripped from input first, so user text cannot forge
  // a placeholder.
  var PH_OPEN = '';
  var PH_CLOSE = '';
  var RE_PH = /(\d+)/g;
  var RE_PH_CHARS = /[]/g;

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyEmphasis(s) {
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^A-Za-z0-9])_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/g, '$1<em>$2</em>');
    return s;
  }

  // Input is text, not HTML: escape first, then add only our own tags.
  function renderInline(text) {
    var slots = [];
    function stash(html) {
      slots.push(html);
      return PH_OPEN + (slots.length - 1) + PH_CLOSE;
    }

    var s = escapeHtml(text.replace(RE_PH_CHARS, ''));

    // Code spans first, so their contents are never formatted.
    s = s.replace(/`([^`]+)`/g, function (m, code) {
      return stash('<code>' + code + '</code>');
    });

    // Links. The URL is checked after escaping; http, https and mailto
    // prefixes contain no escapable characters, so the check is exact.
    s = s.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, function (m, label, url) {
      if (SAFE_URL.test(url)) {
        return stash('<a href="' + url + '" rel="noopener noreferrer" target="_blank">' +
          applyEmphasis(label) + '</a>');
      }
      // Unsafe scheme: keep only the link text, as plain text.
      return stash(applyEmphasis(label));
    });

    s = applyEmphasis(s);

    // Restore placeholders (they may nest, so loop until none remain).
    for (var guard = 0; guard < 10 && s.indexOf(PH_OPEN) !== -1; guard++) {
      s = s.replace(RE_PH, function (m, i) { return slots[+i]; });
    }
    return s;
  }

  function isBlockStart(line) {
    return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) ||
      RE_QUOTE.test(line) || RE_UL.test(line) || RE_OL.test(line);
  }

  function renderBlocks(lines) {
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      var m;

      if (line.trim() === '') {
        i++;
        continue;
      }

      // Fenced code block: contents are literal.
      if (RE_FENCE.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or end of input)
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }

      if ((m = RE_HEADING.exec(line))) {
        var level = m[1].length;
        out.push('<h' + level + '>' + renderInline(m[2].trim()) + '</h' + level + '>');
        i++;
        continue;
      }

      if (RE_HR.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (RE_QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          quoted.push(RE_QUOTE.exec(lines[i])[1]);
          i++;
        }
        out.push('<blockquote>' + renderBlocks(quoted) + '</blockquote>');
        continue;
      }

      if (RE_UL.test(line) || RE_OL.test(line)) {
        var ordered = RE_OL.test(line);
        var itemRe = ordered ? RE_OL : RE_UL;
        var items = [];
        while (i < lines.length && itemRe.test(lines[i])) {
          items.push('<li>' + renderInline(itemRe.exec(lines[i])[1].trim()) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }

      // Paragraph: consecutive lines until a blank line or another block.
      var para = [];
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length === 0) { // defensive; should not happen
        para.push(line.trim());
        i++;
      }
      out.push('<p>' + renderInline(para.join(' ')) + '</p>');
    }

    return out.join('\n');
  }

  function renderMarkdown(source) {
    return renderBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
  }

  /* ---------- UI ---------- */

  var editor = document.getElementById('editor');
  var preview = document.getElementById('preview');
  var statusBar = document.getElementById('status');
  var copyButton = document.getElementById('copy-html');
  var currentHtml = '';

  function updateStatus(source) {
    var trimmed = source.trim();
    var words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
    var chars = source.length;
    statusBar.textContent =
      words + (words === 1 ? ' word' : ' words') + ' · ' +
      chars + (chars === 1 ? ' character' : ' characters');
  }

  function save(source) {
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch (e) {
      // Storage may be unavailable (private mode, quota); editing still works.
    }
  }

  function update() {
    var source = editor.value;
    currentHtml = renderMarkdown(source);
    preview.innerHTML = currentHtml;
    updateStatus(source);
    save(source);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  copyButton.addEventListener('click', function () {
    var original = copyButton.textContent;
    copyText(currentHtml).then(function (ok) {
      copyButton.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(function () { copyButton.textContent = original; }, 1500);
    });
  });

  editor.addEventListener('input', update);

  // Restore saved text, or show the sample on first visit.
  var saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    saved = null;
  }
  editor.value = saved !== null ? saved : SAMPLE;
  update();
})();
