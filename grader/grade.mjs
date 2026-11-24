// Autograder core: serves a site folder, drives it in headless Chrome
// (your installed Google Chrome, via playwright-core) and records one
// pass/fail result per requirement. Task-specific checks live in specs/.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function serveDir(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const rel = decodeURIComponent(url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
      const file = path.normalize(path.join(dir, rel));
      if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

// Prefer a Playwright Chromium already on disk: some Google Chrome installs
// (e.g. policy-managed ones) lock the main profile even with a temporary
// --user-data-dir. GRADER_CHROME overrides with an explicit executable.
function findBrowser() {
  if (process.env.GRADER_CHROME) return { executablePath: process.env.GRADER_CHROME };
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const candidates = [];
  for (const d of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const m = d.match(/^chromium(_headless_shell)?-(\d+)$/);
    if (!m) continue;
    const exe = m[1]
      ? path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      : path.join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (fs.existsSync(exe)) candidates.push({ rev: +m[2], shell: !!m[1], exe });
  }
  candidates.sort((a, b) => b.rev - a.rev || b.shell - a.shell);
  return candidates.length ? { executablePath: candidates[0].exe } : { channel: 'chrome' };
}

/**
 * Grade one site folder against a spec.
 * @returns {Promise<{spec, score, passed, total, checks, externalRequests, errors, screenshots, ms}>}
 */
export async function gradeSite(dir, spec, { outDir } = {}) {
  const t0 = Date.now();
  dir = path.resolve(dir);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const srv = await serveDir(dir);
  const base = `http://127.0.0.1:${srv.port}/`;
  const browser = await chromium.launch({ ...findBrowser(), headless: true });
  const checks = [];
  const external = new Set();
  const errors = [];
  const screenshots = {};

  const t = {
    dir,
    base,
    errors,
    external,
    // Record one requirement. fn returns true/false or {pass, detail}.
    async check(id, label, fn) {
      let pass = false; let detail = '';
      try {
        const r = await fn();
        if (typeof r === 'object' && r) ({ pass, detail = '' } = r); else pass = !!r;
      } catch (e) {
        detail = String(e?.message || e).split('\n')[0].slice(0, 200);
      }
      checks.push({ id, label, pass, detail });
      return pass;
    },
    async newPage({ viewport = { width: 1280, height: 860 }, clock = false, hash = '', init = null } = {}) {
      const context = await browser.newContext({ viewport });
      if (init) await context.addInitScript(init);
      // Anything that isn't this local server counts as an external dependency (CDN, fonts, APIs).
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
        external.add(`${u.protocol}//${u.host}`);
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message).split('\n')[0].slice(0, 160)}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text().split('\n')[0];
        if (/ERR_FAILED|net::/.test(text)) return; // blocked external requests are reported separately
        errors.push(`console.error: ${text.slice(0, 160)}`);
      });
      page.on('dialog', (d) => d.accept().catch(() => {}));
      if (clock) await page.clock.install({ time: Date.now() });
      await page.goto(base + (hash ? `#${hash.replace(/^#/, '')}` : ''), { waitUntil: 'load', timeout: 15000 });
      await page.waitForTimeout(400);
      return page;
    },
    // Advance the fake clock by ms. If page code throws inside a timer, Playwright
    // stops there and rethrows; a real browser would keep running the other
    // timers, so log the error and carry on to the target time.
    async advance(page, ms) {
      const target = (await page.evaluate(() => Date.now())) + ms;
      for (let i = 0; i < 20000; i++) {
        const left = target - (await page.evaluate(() => Date.now()));
        if (left <= 0) return;
        try {
          await page.clock.runFor(left);
          return;
        } catch (e) {
          if (errors.length < 50) errors.push(`timer threw: ${String(e.message).replace(/^clock\.runFor:\s*/, '').split('\n')[0].slice(0, 140)}`);
        }
      }
    },
    async screenshot(page, name) {
      if (!outDir) return;
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      screenshots[name] = path.basename(file);
    },
  };

  try {
    await spec.run(t);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  const passed = checks.filter((c) => c.pass).length;
  return {
    spec: spec.id,
    score: checks.length ? passed / checks.length : 0,
    passed,
    total: checks.length,
    checks,
    externalRequests: [...external],
    errors: errors.slice(0, 20),
    screenshots,
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- page helpers shared by specs

// The countdown text: the deepest visible element whose whole text is mm:ss,
// largest font first (handles <span>25</span>:<span>00</span> too).
export function readTimer(page) {
  return page.evaluate(() => {
    const re = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/;
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
    const all = [...document.querySelectorAll('body *')].filter((el) => re.test(el.textContent || '') && vis(el));
    const deepest = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    if (!deepest.length) return null;
    deepest.sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize));
    const el = deepest[0];
    const m = el.textContent.match(re);
    const r = el.getBoundingClientRect();
    return { text: `${m[1].padStart(2, '0')}:${m[2]}`, seconds: +m[1] * 60 + +m[2], rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
  });
}

// Click the first visible control whose accessible-ish name matches `re`
// (aria-label, text, title or value). Tabs are preferred when `preferTabs`.
export async function clickControl(page, re, { exclude, preferTabs = false } = {}) {
  const name = await page.evaluate(({ src, flags, exSrc, exFlags, preferTabs }) => {
    const re = new RegExp(src, flags);
    const ex = exSrc ? new RegExp(exSrc, exFlags) : null;
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.value || '').replace(/\s+/g, ' ').trim();
    let els = [...document.querySelectorAll('button, [role=button], [role=tab], input[type=button], input[type=submit], a')].filter(vis);
    if (preferTabs) els.sort((a, b) => (b.getAttribute('role') === 'tab') - (a.getAttribute('role') === 'tab'));
    const el = els.find((e) => re.test(nameOf(e)) && !(ex && ex.test(nameOf(e))));
    if (!el) return null;
    document.querySelectorAll('[data-grader-target]').forEach((e) => e.removeAttribute('data-grader-target'));
    el.setAttribute('data-grader-target', '1');
    return nameOf(el);
  }, { src: re.source, flags: re.flags, exSrc: exclude?.source, exFlags: exclude?.flags, preferTabs });
  if (name == null) return null;
  await page.click('[data-grader-target="1"]', { timeout: 3000 });
  return name;
}

export async function pressSpace(page) {
  await page.evaluate(() => document.activeElement && document.activeElement !== document.body && document.activeElement.blur());
  await page.keyboard.press('Space');
}

// "Sessions completed today" counter. The label may be in the visible text or
// only in aria-label / id / class ("Completed today 0" with id="sessions"), so
// all of those count as hints. Inside the smallest hinted element, prefer a
// child that is just a number, else the last number. Anything containing a
// mm:ss reading is the timer, not the counter.
export function readSessions(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const hint = (el) => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
    const boxes = [...document.querySelectorAll('body *')]
      .filter((el) => /session|completed today/i.test(hint(el)) && (el.textContent || '').length < 140
        && !/\d{1,2}\s*:\s*\d{2}/.test(el.textContent || '') && vis(el))
      .sort((a, b) => a.textContent.length - b.textContent.length);
    for (const box of boxes) {
      if (/^\s*\d+\s*$/.test(box.textContent || '')) return +box.textContent.trim();
      const pure = [...box.querySelectorAll('*')].find((c) => /^\s*\d+\s*$/.test(c.textContent || '') && vis(c));
      if (pure) return +pure.textContent.trim();
      const nums = (box.textContent.match(/\d+/g) || []).map(Number);
      if (nums.length) return nums[nums.length - 1];
    }
    // A bare number with a "session" label nearby (sibling / parent label)
    const near = [...document.querySelectorAll('body *')].find((el) => /^\s*\d+\s*$/.test(el.textContent || '') && vis(el)
      && /session/i.test(el.parentElement?.textContent || ''));
    return near ? +near.textContent.trim() : null;
  });
}

// Progress ring state: dash offset/array (computed and as set by the page) or
// path data of SVG strokes. Inline/attribute values catch rings whose computed
// value is mid-CSS-transition (transitions run on real time, not the fake clock).
export function readRing(page) {
  return page.evaluate(() => {
    const shapes = [...document.querySelectorAll('svg circle, svg path, svg ellipse')];
    const withDash = shapes.filter((s) => {
      const cs = getComputedStyle(s);
      return (cs.strokeDasharray && cs.strokeDasharray !== 'none') || s.getAttribute('stroke-dasharray');
    });
    return {
      svgs: document.querySelectorAll('svg').length,
      dashed: withDash.length,
      state: withDash.map((s) => {
        const cs = getComputedStyle(s);
        return [cs.strokeDashoffset, s.style.strokeDashoffset, s.getAttribute('stroke-dashoffset'), cs.strokeDasharray, s.getAttribute('d')].join('|');
      }).join(';'),
    };
  });
}

// Mean relative luminance of the rendered pixels (a screenshot, downsampled in a
// canvas). Measures what's actually painted, so faint gradients and bright
// accents count for exactly the area they cover.
export async function screenLuminance(page) {
  const png = await page.screenshot();
  const scratch = await page.context().newPage();
  try {
    return await scratch.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = 160; const h = Math.round((img.height / img.width) * w);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      return sum / (d.length / 4);
    }, png.toString('base64'));
  } finally {
    await scratch.close();
  }
}
