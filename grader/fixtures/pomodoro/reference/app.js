// Known-good reference used by grader/selftest.mjs. Mutations of this file
// must make exactly the expected checks fail.
const MODES = { focus: 25 * 60, break: 5 * 60 };
const CIRC = 2 * Math.PI * 90;
const $ = (id) => document.getElementById(id);
const todayKey = () => `sessions-${new Date().toISOString().slice(0, 10)}`;

let mode = 'focus';
let remaining = MODES.focus;
let endAt = null;
let timer = null;

function render() {
  const s = Math.max(0, Math.ceil(remaining));
  $('time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  $('bar').style.strokeDashoffset = String(CIRC * (1 - remaining / MODES[mode]));
  $('toggle').textContent = endAt ? 'Pause' : 'Start';
  $('count').textContent = String(+(localStorage.getItem(todayKey()) || 0));
}

function tick() {
  remaining = (endAt - Date.now()) / 1000;
  if (remaining <= 0) {
    stop();
    if (mode === 'focus') localStorage.setItem(todayKey(), String(+(localStorage.getItem(todayKey()) || 0) + 1));
    setMode(mode === 'focus' ? 'break' : 'focus');
  }
  render();
}

function start() { endAt = Date.now() + remaining * 1000; timer = setInterval(tick, 250); render(); }
function stop() { clearInterval(timer); timer = null; if (endAt) remaining = Math.max(0, (endAt - Date.now()) / 1000); endAt = null; }
function toggle() { if (endAt) { stop(); render(); } else start(); }
function setMode(m) {
  stop();
  mode = m;
  remaining = MODES[m];
  $('tab-focus').setAttribute('aria-selected', String(m === 'focus'));
  $('tab-break').setAttribute('aria-selected', String(m === 'break'));
  render();
}

$('toggle').addEventListener('click', toggle);
$('reset').addEventListener('click', () => setMode(mode));
$('tab-focus').addEventListener('click', () => setMode('focus'));
$('tab-break').addEventListener('click', () => setMode('break'));
document.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); toggle(); } });
render();
