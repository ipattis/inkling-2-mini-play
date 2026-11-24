(function () {
  "use strict";

  var STORAGE_KEY = "markdown-editor-content";

  var editor = document.getElementById("editor");
  var preview = document.getElementById("preview");
  var statusBar = document.getElementById("status");
  var copyBtn = document.getElementById("copy-btn");

  // ---------- HTML escaping ----------
  // Raw HTML in the source is escaped first, so it can never be rendered.
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- Inline rendering (input must already be HTML-escaped) ----------
  function renderInline(escapedText) {
    // 1. Extract `code` spans first so inner Markdown is not processed inside them.
    var codeSpans = [];
    var text = escapedText.replace(/`([^`]+)`/g, function (match, code) {
      codeSpans.push(code);
      return "\u0000CODE" + (codeSpans.length - 1) + "\u0000";
    });

    // 2. Bold and italic.
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    text = text.replace(/_([^_\n]+)_/g, "<em>$1</em>");

    // 3. Links — only http:, https: and mailto: URLs become links.
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
      if (/^(https?:|mailto:)/i.test(url)) {
        return '<a href="' + url + '">' + label + '</a>';
      }
      // Unsafe or unsupported URL: render as plain text (leave untouched).
      return match;
    });

    // 4. Restore code spans (their contents stay fully literal).
    text = text.replace(/\u0000CODE(\d+)\u0000/g, function (match, idx) {
      return "<code>" + codeSpans[Number(idx)] + "</code>";
    });

    return text;
  }

  // ---------- Block parsing ----------
  function renderMarkdown(source) {
    var lines = source.split(/\r\n|\r|\n/);
    var html = [];
    var i = 0;

    function isBlank(line) {
      return line.trim() === "";
    }

    while (i < lines.length) {
      var line = lines[i];

      // Blank lines are skipped.
      if (isBlank(line)) {
        i++;
        continue;
      }

      // Fenced code block.
      if (/^\s*```/.test(line)) {
        var codeLines = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        // Skip the closing fence if present.
        if (i < lines.length) { i++; }
        html.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
        continue;
      }

      // Horizontal rule (only a line containing ---).
      if (line.trim() === "---") {
        html.push("<hr>");
        i++;
        continue;
      }

      // Heading.
      var headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        var level = headingMatch[1].length;
        html.push("<h" + level + ">" + renderInline(escapeHtml(headingMatch[2].trim())) + "</h" + level + ">");
        i++;
        continue;
      }

      // Blockquote (consecutive "> " lines).
      if (/^>(?:\s|$)/.test(line)) {
        var quoteLines = [];
        while (i < lines.length && /^>(?:\s|$)/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        html.push("<blockquote>" + renderInline(escapeHtml(quoteLines.join("\n"))) + "</blockquote>");
        continue;
      }

      // Unordered list ("- " or "* ").
      if (/^\s*[-*]\s+/.test(line)) {
        var ulItems = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          ulItems.push(lines[i].replace(/^\s*[-*]\s+/, ""));
          i++;
        }
        var ulHtml = ulItems
          .map(function (item) { return "<li>" + renderInline(escapeHtml(item)) + "</li>"; })
          .join("");
        html.push("<ul>" + ulHtml + "</ul>");
        continue;
      }

      // Ordered list ("1. ", "2. ", …).
      if (/^\s*\d+\.\s+/.test(line)) {
        var olItems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          olItems.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i++;
        }
        var olHtml = olItems
          .map(function (item) { return "<li>" + renderInline(escapeHtml(item)) + "</li>"; })
          .join("");
        html.push("<ol>" + olHtml + "</ol>");
        continue;
      }

      // Paragraph: accumulate consecutive plain lines.
      var paraLines = [line];
      i++;
      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        !/^\s*```/.test(lines[i]) &&
        lines[i].trim() !== "---" &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^>(?:\s|$)/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      html.push("<p>" + renderInline(escapeHtml(paraLines.join("\n"))) + "</p>");
    }

    return html.join("\n");
  }

  // ---------- Rendering + autosave + status ----------
  function update() {
    var source = editor.value;
    preview.innerHTML = renderMarkdown(source);
    var text = source.trim();
    var words = text === "" ? 0 : text.split(/\s+/).length;
    var chars = source.length;
    statusBar.textContent =
      words + (words === 1 ? " word" : " words") + " · " +
      chars + (chars === 1 ? " character" : " characters");
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch (e) {
      // Storage unavailable (e.g. private mode) — autosave is best-effort.
    }
  }

  editor.addEventListener("input", update);

  // ---------- Copy HTML ----------
  copyBtn.addEventListener("click", function () {
    var html = preview.innerHTML;
    var done = function () {
      var original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(function () { copyBtn.textContent = original; }, 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(html).then(done, function () { fallbackCopy(html); done(); });
    } else {
      fallbackCopy(html);
      done();
    }
  });

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // ---------- Init ----------
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      editor.value = saved;
    }
  } catch (e) {
    // Storage unavailable — start fresh.
  }
  update();
})();
