(function () {
  'use strict';

  var editor = document.getElementById('editor');
  var preview = document.getElementById('preview');
  var status = document.getElementById('status');
  var copyBtn = document.getElementById('copy-btn');
  var STORAGE_KEY = 'markdown-editor-content';

  // ---------- Helpers ----------

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    return /^(https?:\/\/|mailto:)/i.test(url);
  }

  // ---------- Inline Markdown ----------
  // Input must already be HTML-escaped. Returns escaped HTML with inline tags.

  function renderInline(text) {
    var codes = [];

    // `code` spans first, so their contents are not touched by other rules
    text = text.replace(/`([^`]+)`/g, function (m, code) {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    // [text](url) links — only http:, https:, mailto:
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      if (safeUrl(url)) {
        return '<a href="' + url + '">' + label + '</a>';
      }
      return m; // not an allowed scheme: keep as plain text
    });

    // **bold**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // *italic* and _italic_
    text = text.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
    text = text.replace(/(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g, '$1<em>$2</em>');

    // restore code spans
    text = text.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return codes[Number(i)];
    });

    return text;
  }

  // ---------- Block Markdown ----------

  function renderMarkdown(src) {
    var lines = src.split('\n');
    var out = [];
    var para = [];
    var i = 0;

    function flushPara() {
      if (para.length) {
        out.push('<p>' + renderInline(para.join(' ')) + '</p>');
        para = [];
      }
    }

    while (i < lines.length) {
      var raw = lines[i];
      var line = raw.trim();

      // Blank line: paragraph boundary
      if (line === '') {
        flushPara();
        i++;
        continue;
      }

      // Fenced code block: show contents exactly, no Markdown inside
      if (line.charAt(0) === '`' && line.slice(0, 3) === '```') {
        flushPara();
        i++;
        var buf = [];
        while (i < lines.length && lines[i].trim().slice(0, 3) !== '```') {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or run past end)
        out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // Headings
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        var level = h[1].length;
        out.push('<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // Horizontal rule: a line containing only ---
      if (line === '---') {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        flushPara();
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quote.push(renderInline(lines[i].trim().replace(/^>\s?/, '')));
          i++;
        }
        out.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
        continue;
      }

      // Unordered list: "- " or "* "
      if (/^[-*]\s+/.test(line)) {
        flushPara();
        var ul = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          ul.push('<li>' + renderInline(lines[i].trim().replace(/^[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + ul.join('') + '</ul>');
        continue;
      }

      // Ordered list: "1. ", "2. ", ...
      if (/^\d+\.\s+/.test(line)) {
        flushPara();
        var ol = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          ol.push('<li>' + renderInline(lines[i].trim().replace(/^\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + ol.join('') + '</ol>');
        continue;
      }

      // Plain text: accumulate into a paragraph
      para.push(escapeHtml(line));
      i++;
    }

    flushPara();
    return out.join('\n');
  }

  // ---------- UI ----------

  function updateStatus(text) {
    var words = (text.trim().match(/\S+/g) || []).length;
    status.textContent = words + ' words · ' + text.length + ' characters';
  }

  var saveTimer = null;

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, editor.value);
    } catch (e) {
      /* storage unavailable: ignore */
    }
  }

  function render() {
    var text = editor.value;
    preview.innerHTML = renderMarkdown(text);
    updateStatus(text);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }

  editor.addEventListener('input', render);

  copyBtn.addEventListener('click', function () {
    var html = preview.innerHTML;
    function done() {
      copyBtn.classList.add('copied');
      copyBtn.textContent = 'Copied!';
      setTimeout(function () {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = 'Copy HTML';
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(html).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var tmp = document.createElement('textarea');
      tmp.value = html;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      try {
        document.execCommand('copy');
        done();
      } catch (e) {
        /* copy failed */
      }
      document.body.removeChild(tmp);
    }
  });

  // Restore autosaved text, then render
  var saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    /* storage unavailable: ignore */
  }
  if (saved !== null && saved !== '') {
    editor.value = saved;
  }
  render();
})();
