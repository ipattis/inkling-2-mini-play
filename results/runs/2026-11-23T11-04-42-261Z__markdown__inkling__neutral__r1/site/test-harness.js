// Optional offline verification script for the Markdown parser.
// Run with: node test-harness.js
// It stubs the minimal DOM/localStorage surface app.js needs, loads it,
// then exercises the parser functions directly and prints PASS/FAIL lines.
"use strict";

var fs = require("fs");

var store = {};
function makeEl() {
  return {
    value: "",
    innerHTML: "",
    textContent: "",
    style: {},
    addEventListener: function () {},
    appendChild: function () {},
    select: function () {}
  };
}
var editor = makeEl();
var preview = makeEl();
var statusBar = makeEl();
var copyBtn = makeEl();

global.document = {
  getElementById: function (id) {
    if (id === "editor") return editor;
    if (id === "preview") return preview;
    if (id === "status") return statusBar;
    if (id === "copy-btn") return copyBtn;
    return makeEl();
  },
  createElement: function () { return makeEl(); },
  body: { appendChild: function () {}, removeChild: function () {} },
  execCommand: function () {}
};
global.localStorage = {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = v; }
};
global.navigator = {};

require("./app.js");

var src = fs.readFileSync("./app.js", "utf8");
var start = src.indexOf("function escapeHtml");
var end = src.indexOf("// ---------- Rendering");
var parserSrc = src.slice(start, end);
var renderMarkdown = new Function(parserSrc + "\nreturn renderMarkdown;")();

var failures = 0;
function check(name, input, expected) {
  var actual = renderMarkdown(input);
  var pass = actual === expected;
  if (!pass) { failures++; }
  console.log((pass ? "PASS" : "FAIL") + " | " + name);
  if (!pass) {
    console.log("   in : " + JSON.stringify(input));
    console.log("   want: " + JSON.stringify(expected));
    console.log("   got : " + JSON.stringify(actual));
  }
}

check("h1 heading", "# Hello", "<h1>Hello</h1>");
check("h6 heading", "###### Deep", "<h6>Deep</h6>");
check("paragraph", "one two\nthree", "<p>one two\nthree</p>");
check("paragraphs split on blank line", "a\n\nb", "<p>a</p>\n<p>b</p>");
check("bold", "**bold**", "<p><strong>bold</strong></p>");
check("italic star", "*it*", "<p><em>it</em></p>");
check("italic underscore", "_it_", "<p><em>it</em></p>");
check("code span", "a `b*c` d", "<p>a <code>b*c</code> d</p>");
check("http link", "[t](https://example.com)", '<p><a href="https://example.com">t</a></p>');
check("mailto link", "[t](mailto:a@b.c)", '<p><a href="mailto:a@b.c">t</a></p>');
check("http link", "[t](http://example.com/x?y=1&z=2)", '<p><a href="http://example.com/x?y=1&amp;z=2">t</a></p>');
check("unsafe link untouched", "[t](javascript:alert(1))", "<p>[t](javascript:alert(1))</p>");
check("ftp link untouched", "[t](ftp://x.y)", "<p>[t](ftp://x.y)</p>");
check("ul", "- a\n- b\n- c", "<ul><li>a</li><li>b</li><li>c</li></ul>");
check("ul with asterisk", "* a\n* b", "<ul><li>a</li><li>b</li></ul>");
check("ol", "1. a\n2. b\n3. c", "<ol><li>a</li><li>b</li><li>c</li></ol>");
check("fenced code", "```\nconst x = <b>1</b>\n```", "<pre><code>const x = &lt;b&gt;1&lt;/b&gt;</code></pre>");
check("fenced code keeps literal markdown", "```\n**not bold**\n```", "<pre><code>**not bold**</code></pre>");
check("blockquote", "> quoted\n> lines", "<blockquote>quoted\nlines</blockquote>");
check("hr", "---", "<hr>");
check("raw html escaped", "<script>alert(1)</script>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
check("img escaped", "<img src=x onerror=alert(1)>", "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
check("heading inline", "# H **b** `c`", "<h1>H <strong>b</strong> <code>c</code></h1>");
check("list with inline", "- a **b**", "<ul><li>a <strong>b</strong></li></ul>");
check("inline raw <b> in paragraph", "x <b>y</b>", "<p>x &lt;b&gt;y&lt;/b&gt;</p>");
check("ol then paragraph", "1. first\n2. second\n\nparagraph", "<ol><li>first</li><li>second</li></ol>\n<p>paragraph</p>");
check("list then ol", "- a\n1. b", "<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
check("empty input", "", "");

// Load ran update() once through the IIFE, so initialization executed cleanly.
console.log("app loaded; status after init: " + JSON.stringify(statusBar.textContent));
console.log("autosaved to localStorage: " + JSON.stringify(store["markdown-editor-content"]));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : "\n" + failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
