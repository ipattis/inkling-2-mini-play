(function () {
  'use strict';

  var STORAGE_KEY = 'markdown-editor-text';

  var DEFAULT_TEXT = [
    '# Welcome',
    '',
    'Type **Markdown** on the left and see the *preview* on the right.',
    '',
    '## Features',
    '',
    '- Headings, lists, and blockquotes',
    '- `inline code` and [links](https://example.com)',
    '',
    '1. Ordered lists',
    '2. Fenced code blocks',
    '',
    '> Raw HTML like <script>alert(1)</script> is shown as text.',
    '',
    '---',
    '',
    '```',
    '**not bold** inside code',
    '```'
  ].join('\n');

  // ---------- Markdown parser ----------

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Emphasis on already-escaped text that contains no unsafe characters.
  function applyEmphasis(s) {
    // **bold**
    s = s.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
    // *italic*
    s = s.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>');
    // _italic_ (word-boundary aware so snake_case_words are left alone)
    s = s.replace(/(^|[^A-Za-z0-9])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9])/g, '$1<em>$2</em>');
    return s;
  }

  function renderInline(text) {
    var store = [];
    function hold(html) {
      store.push(html);
      return '\u0000' + (store.length - 1) + '\u0000';
    }
    function restore(s) {
      return s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
        return restore(store[Number(i)]);
      });
    }

    var s = escapeHtml(text);

    // Code spans first: their contents are never processed further.
    s = s.replace(/`([^`]+)`/g, function (_, code) {
      return hold('<code>' + code + '</code>');
    });

    // Links: only http:, https: and mailto: become anchors.
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (whole, label, url) {
      if (!/^(https?:|mailto:)/i.test(url)) {
        return hold(whole); // rendered as plain text
      }
      return hold('<a href="' + url + '">' + applyEmphasis(label) + '</a>');
    });

    s = applyEmphasis(s);
    return restore(s);
  }

  var RE_HEADING = /^(#{1,6})\s+(.*)$/;
  var RE_FENCE = /^\s*```/;
  var RE_QUOTE = /^>/;
  var RE_UL = /^[-*] (.*)$/;
  var RE_OL = /^\d+\. (.*)$/;

  function isBlank(line) {
    return line.trim() === '';
  }

  function isHr(line) {
    return line.trim() === '---';
  }

  function isBlockStart(line) {
    return RE_FENCE.test(line) || RE_HEADING.test(line) || isHr(line) ||
      RE_QUOTE.test(line) || RE_UL.test(line) || RE_OL.test(line);
  }

  function parseBlocks(source) {
    var lines = source.replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (isBlank(line)) {
        i++;
        continue;
      }

      // Fenced code block
      if (RE_FENCE.test(line)) {
        var body = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (if any)
        out.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
        continue;
      }

      // Heading
      var h = RE_HEADING.exec(line);
      if (h) {
        var level = h[1].length;
        out.push('<h' + level + '>' + renderInline(h[2].trim()) + '</h' + level + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (isHr(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // Blockquote
      if (RE_QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          quoted.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + parseBlocks(quoted.join('\n')) + '</blockquote>');
        continue;
      }

      // Lists
      if (RE_UL.test(line) || RE_OL.test(line)) {
        var ordered = !RE_UL.test(line);
        var re = ordered ? RE_OL : RE_UL;
        var items = [];
        while (i < lines.length && re.test(lines[i])) {
          items.push('<li>' + renderInline(re.exec(lines[i])[1]) + '</li>');
          i++;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }

      // Paragraph: consecutive lines until a blank line or another block
      var para = [];
      while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) {
        para.push(renderInline(lines[i]));
        i++;
      }
      out.push('<p>' + para.join('\n') + '</p>');
    }

    return out.join('\n');
  }

  function markdownToHtml(source) {
    return parseBlocks(source);
  }

  // ---------- App wiring ----------

  var editor = document.getElementById('editor');
  var preview = document.getElementById('preview');
  var status = document.getElementById('status');
  var copyButton = document.getElementById('copy-html');

  function countWords(text) {
    var trimmed = text.trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  }

  function update() {
    var source = editor.value;
    var html = markdownToHtml(source);
    preview.innerHTML = html;
    status.textContent = countWords(source) + ' words · ' + source.length + ' characters';
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch (e) {
      // Storage may be full or unavailable; editing still works.
    }
  }

  function loadSaved() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null) return saved;
    } catch (e) {
      // ignore
    }
    return DEFAULT_TEXT;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
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
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  copyButton.addEventListener('click', function () {
    var html = markdownToHtml(editor.value);
    var originalLabel = 'Copy HTML';
    copyText(html).then(function () {
      copyButton.textContent = 'Copied!';
    }, function () {
      copyButton.textContent = 'Copy failed';
    }).then(function () {
      setTimeout(function () {
        copyButton.textContent = originalLabel;
      }, 1500);
    });
  });

  editor.addEventListener('input', update);
  editor.value = loadSaved();
  update();
})();
