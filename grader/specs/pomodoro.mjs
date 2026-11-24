// Checks for the Pomodoro task in models.mjs, one per stated requirement.
// The first page runs on Playwright's fake clock, so "60 seconds" or a full
// 25-minute session take milliseconds and the timing checks are exact.
import fs from 'node:fs';
import path from 'node:path';
import {
  readTimer, clickControl, pressSpace, readSessions, readRing, screenLuminance,
} from '../grade.mjs';

export const id = 'pomodoro';
export const title = 'Pomodoro focus timer';

const START = /\b(start|resume|play|begin)\b/i;
const PAUSE = /\bpause\b/i;
const RESET = /\b(reset|restart)\b/i;
const NOT_A_TAB = /\b(start|pause|resume|reset|restart|skip|play)\b/i;
const near = (a, b, tol = 1) => a != null && Math.abs(a - b) <= tol;
const fmt = (s) => (s == null ? 'no mm:ss on screen' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);

export async function run(t) {
  await t.check('files', 'index.html, styles.css and app.js exist', () => {
    const missing = ['index.html', 'styles.css', 'app.js'].filter((f) => !fs.existsSync(path.join(t.dir, f)));
    return { pass: !missing.length, detail: missing.length ? `missing ${missing.join(', ')}` : '' };
  });

  let page;
  try {
    page = await t.newPage({ clock: true });
  } catch (e) {
    await t.check('loads', 'Page loads', () => ({ pass: false, detail: String(e.message).slice(0, 160) }));
    return;
  }
  const secs = async () => (await readTimer(page))?.seconds ?? null;
  const ring0 = await readRing(page);

  await t.check('initial', 'Shows 25:00 on load (focus mode)', async () => {
    const s = await secs();
    return { pass: s === 1500, detail: fmt(s) };
  });

  // --- start / countdown accuracy / ring
  let startName = null;
  await t.check('start', 'Start counts down at real speed (60 s → 24:00)', async () => {
    startName = await clickControl(page, START);
    if (!startName) return { pass: false, detail: 'no Start button found' };
    await t.advance(page, 60_000);
    const s = await secs();
    return { pass: near(s, 1440), detail: `after 60 s: ${fmt(s)}` };
  });

  await t.check('ring', 'Animated circular SVG progress ring', async () => {
    await page.waitForTimeout(1200); // CSS transitions run on real time
    const ring1 = await readRing(page);
    if (!ring0.svgs) return { pass: false, detail: 'no <svg>' };
    if (!ring0.dashed && !ring1.dashed) return { pass: false, detail: 'no stroke-dasharray on any circle/path' };
    return { pass: ring1.state !== ring0.state, detail: ring1.state !== ring0.state ? '' : 'ring did not change after 60 s' };
  });

  // --- pause
  await t.check('pause', 'Pause stops the countdown', async () => {
    // A separate Pause button, or the Start control acting as a toggle.
    const name = (await clickControl(page, PAUSE)) || (startName && (await clickControl(page, START)));
    if (!name) return { pass: false, detail: 'no Pause control' };
    await t.advance(page, 1_000); // allow one last re-render at the moment of pausing
    const a = await secs();
    await t.advance(page, 10_000);
    const b = await secs();
    return { pass: a != null && a === b, detail: `${fmt(a)} → ${fmt(b)} over 10 s` };
  });

  // --- reset
  await t.check('reset', 'Reset returns to 25:00', async () => {
    const name = await clickControl(page, RESET);
    if (!name) return { pass: false, detail: 'no Reset button' };
    await t.advance(page, 500);
    const s = await secs();
    return { pass: s === 1500, detail: fmt(s) };
  });

  // --- Space toggles start / pause
  await t.check('space', 'Space key toggles start / pause', async () => {
    const a = await secs();
    await pressSpace(page);
    await t.advance(page, 5_000);
    const b = await secs();
    await pressSpace(page);
    await t.advance(page, 1_000); // allow one last re-render at the moment of pausing
    const c = await secs();
    await t.advance(page, 5_000);
    const d = await secs();
    const started = near(b, a - 5);
    const paused = c != null && c === d && near(c, b, 1);
    return { pass: started && paused, detail: `${fmt(a)} → Space, 5 s → ${fmt(b)} → Space, 6 s → ${fmt(d)}` };
  });
  await clickControl(page, RESET).catch(() => {});

  // --- mode tabs
  await t.check('break', 'Break tab switches to 05:00', async () => {
    const name = await clickControl(page, /break/i, { exclude: NOT_A_TAB, preferTabs: true });
    if (!name) return { pass: false, detail: 'no Break tab' };
    await t.advance(page, 300);
    const s = await secs();
    return { pass: s === 300, detail: `${name}: ${fmt(s)}` };
  });

  await t.check('focus', 'Focus tab switches back to 25:00', async () => {
    const name = await clickControl(page, /focus|pomodoro|work/i, { exclude: /break|start|pause|resume|reset|skip/i, preferTabs: true });
    if (!name) return { pass: false, detail: 'no Focus tab' };
    await t.advance(page, 300);
    const s = await secs();
    return { pass: s === 1500, detail: `${name}: ${fmt(s)}` };
  });

  // --- completing a session increments the counter, which survives a reload
  let after = null;
  await t.check('session', 'Finishing a focus session adds 1 to "sessions today"', async () => {
    const before = await readSessions(page);
    if (before == null) return { pass: false, detail: 'no sessions counter found' };
    if (!(await clickControl(page, START))) return { pass: false, detail: 'no Start button' };
    await t.advance(page, 25 * 60_000 + 3_000);
    after = await readSessions(page);
    return { pass: after === before + 1, detail: `${before} → ${after}` };
  });

  await t.check('persist', 'Session count persists after reload (localStorage)', async () => {
    if (after == null) return { pass: false, detail: 'no count to compare' };
    const keys = await page.evaluate(() => localStorage.length);
    await page.reload({ waitUntil: 'load' });
    await t.advance(page, 300);
    const reloaded = await readSessions(page);
    return { pass: reloaded === after && keys > 0, detail: `after reload: ${reloaded} (localStorage keys: ${keys})` };
  });

  await page.context().close();

  // --- layout at the two widths named in the prompt
  for (const [id, width, height] of [['mobile', 360, 740], ['desktop', 1440, 900]]) {
    const p = await t.newPage({ viewport: { width, height } });
    await t.check(`layout-${width}`, `Fits at ${width}px wide (no sideways scroll, timer on screen)`, async () => {
      const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      const timer = await readTimer(p);
      const onScreen = timer && timer.rect.left >= -1 && timer.rect.right <= width + 1;
      return { pass: m.sw <= m.iw + 1 && !!onScreen, detail: `scrollWidth ${m.sw}/${m.iw}${timer ? '' : ', no timer'}${timer && !onScreen ? ', timer off screen' : ''}` };
    });
    if (id === 'desktop') {
      await t.check('dark', 'Dark UI (mean screen luminance < 0.18)', async () => {
        const l = await screenLuminance(p);
        return { pass: l < 0.18, detail: `luminance ${l.toFixed(3)} (white = 1)` };
      });
    }
    await t.screenshot(p, id);
    await p.context().close();
  }

  // --- hygiene: these use everything collected above
  await t.check('no-external', 'No external requests (no CDNs / frameworks)', () => ({
    pass: t.external.size === 0, detail: [...t.external].join(', '),
  }));
  await t.check('no-errors', 'No JavaScript errors', () => ({
    pass: t.errors.length === 0, detail: t.errors.slice(0, 2).join(' | '),
  }));
}

// Negative controls for grader/selftest.mjs (applied to fixtures/pomodoro/reference).
export const selftest = (edit) => [
  ['reference', [], () => {}],
  ['timer runs 2x fast', ['start', 'space'], edit('app.js', 'endAt = Date.now() + remaining * 1000;', 'endAt = Date.now() + remaining * 500;')],
  ['no Space shortcut', ['space'], edit('app.js', "if (e.code === 'Space')", "if (e.code === 'NoSuchKey')")],
  ['count not persisted', ['persist'], (dir) => {
    // Same app, but the counter lives in memory instead of localStorage.
    const p = path.join(dir, 'app.js');
    const src = fs.readFileSync(p, 'utf8').replaceAll('localStorage.', 'memStore.');
    fs.writeFileSync(p, `const memStore = { m: {}, getItem(k) { return this.m[k] ?? null; }, setItem(k, v) { this.m[k] = String(v); } };\n${src}`);
  }],
  ['light theme', ['dark'], edit('styles.css', 'background: #0d1016;', 'background: #f6f7f9;')],
  ['loads from a CDN', ['no-external'], edit('index.html', '<script src="app.js"></script>', '<script src="https://cdn.example.com/lib.js"></script>\n  <script src="app.js"></script>')],
  ['CSS inlined, no styles.css', ['files'], (dir) => {
    // Works fine, but ignores the required file layout.
    const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
    edit('index.html', '<link rel="stylesheet" href="styles.css">', `<style>${css}</style>`)(dir);
    fs.renameSync(path.join(dir, 'styles.css'), path.join(dir, 'unused.txt'));
  }],
  ['linked styles.css missing', ['files', 'dark', 'ring', 'no-errors'], (dir) => fs.renameSync(path.join(dir, 'styles.css'), path.join(dir, 'style.css'))],
  ['throws on load', ['no-errors'], edit('app.js', 'render();\n', 'render();\nsetTimeout(() => { throw new Error("boom"); }, 0);\n')],
  ['overflows sideways', ['layout-360', 'layout-1440'], edit('styles.css', '.sessions {', '.card::after { content: ""; display: block; width: 2400px; height: 1px; }\n.sessions {')],
  ['ring never moves', ['ring'], edit('app.js', "$('bar').style.strokeDashoffset = String(CIRC * (1 - remaining / MODES[mode]));", '')],
  ['no Break tab', ['break'], edit('index.html', '<button role="tab" id="tab-break" aria-selected="false">Break</button>', '<span id="tab-break"></span>')],
  // Positive control (Qwen's real layout): the word "session" only in aria-label / class.
  ['counter label w/o "session"', [], edit('index.html', '<p class="sessions"><span id="count">0</span> sessions completed today</p>', '<p class="sessions" aria-label="Sessions completed today">Completed today <span id="count">0</span></p>')],
];
