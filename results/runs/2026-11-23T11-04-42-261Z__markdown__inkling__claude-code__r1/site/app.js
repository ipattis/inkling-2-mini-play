(function () {
  'use strict';

  var STORAGE_KEY = 'md-editor-source';

  var editor = document.getElementById('editor');
  var preview = document.getElementById('preview');
  var status = document.getElementById('status');
  var copyBtn = document.getElementById('copy-btn');

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Processes already-HTML-escaped text: inline Markdown → safe HTML.
  function inlineEscaped(text) {
    var store = [];
    function stash(html) {
      store.push(html);
      return '\u0001' + store.length + '\u0002';
    }

    // Code spans first so Markdown inside them is left alone.
    text = text.replace(/`([^`]+)`/g, function (_, code) {
      return stash('<code>' + code + '</code>');
    });

    // Links: only http:, https: and mailto: become links.
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
      url = url.trim();
      if (!/^(https?:|mailto:)/i.test(url)) return match; // plain text
      return stash('<a href="' + url + '">' + inlineEscaped(label) + '</a>');
    });

    // Bold then italic.
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(\*|_)([^*_]+)\1/g, '<em>$2</em>');

    // Restore stashed blocks (code spans, links).
    text = text.replace(/\u0001(\d+)\u0002/g, function (_, i) {
      return store[+i - 1];
    });

    return text;
  }

  // Processes raw (unescaped) text.
  function inline(text) {
    return inlineEscaped(escapeHtml(text));
  }

  function isSpecial(line) {
    return (
      /^\s*```/.test(line) ||
      /^#{1,6}(\s|$)/.test(line) ||
      /^---\s*$/.test(line) ||
      /^>\s?/.test(line) ||
      /^[-*]\s/.test(line) ||
      /^\d+\.\s/.test(line)
    );
  }

  function render(src) {
    var lines = src.split('\n');
    var blocks = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      // Fenced code block
      var fence = line.match(/^\s*(`{3,})/);
      if (fence) {
        var content = [];
        i++;
        while (i < lines.length && !/^\s*`{3,}\s*$/.test(lines[i])) {
          content.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing fence
        blocks.push('<pre><code>' + escapeHtml(content.join('\n')) + '</code></pre>');
        continue;
      }

      // Heading
      var h = line.match(/^(#{1,6})(?:\s+(.*))?$/);
      if (h) {
        var lvl = h[1].length;
        blocks.push('<h' + lvl + '>' + inline(h[2] || '') + '</h' + lvl + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (/^---\s*$/.test(line.trim())) {
        blocks.push('<hr>');
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        blocks.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
        continue;
      }

      // Unordered list
      if (/^[-*]\s/.test(line)) {
        var items = [];
        while (i < lines.length && /^[-*]\s/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*]\s+/, ''));
          i++;
        }
        blocks.push('<ul>\n' + items.map(function (it) {
          return '<li>' + inline(it) + '</li>';
        }).join('\n') + '\n</ul>');
        continue;
      }

      // Ordered list
      if (/^\d+\.\s/.test(line)) {
        var oItems = [];
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          oItems.push(lines[i].replace(/^\d+\.\s+/, ''));
          i++;
        }
        blocks.push('<ol>\n' + oItems.map(function (it) {
          return '<li>' + inline(it) + '</li>';
        }).join('\n') + '\n</ol>');
        continue;
      }

      // Paragraph
      var para = [];
      var startI = i;
      while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) {
        blocks.push('<p>' + inline(para.join(' ')) + '</p>');
      } else {
        i = startI + 1; // safety net against an infinite loop
      }
    }

    return blocks.join('\n');
  }

  function pluralize(n, singular, plural) {
    return n + ' ' + (n === 1 ? singular : plural);
  }

  function updateStatus(src) {
    var trimmed = src.trim();
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    status.textContent = pluralize(words, 'word', 'words') + ' · ' +
      pluralize(src.length, 'character', 'characters');
  }

  function renderAll() {
    var src = editor.value;
    preview.innerHTML = render(src);
    updateStatus(src);
    try { localStorage.setItem(STORAGE_KEY, src); } catch (e) { /* ignore */ }
  }

  editor.addEventListener('input', renderAll);

  copyBtn.addEventListener('click', function () {
    var html = preview.innerHTML;
    function done() {
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = 'Copy HTML'; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(html).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = html;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  });

  // Restore saved source
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) editor.value = saved;
  } catch (e) { /* ignore */ }

  renderAll();
})();
