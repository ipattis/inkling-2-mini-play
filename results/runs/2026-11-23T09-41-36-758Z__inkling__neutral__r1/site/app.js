(() => {
  'use strict';

  /* ---------- config & state ---------- */
  const MODES = {
    focus: { seconds: 25 * 60, ring: 'url(#gradFocus)', label: 'Focus time',  doneMsg: 'Focus complete — one session down.' },
    break: { seconds: 5 * 60,  ring: 'url(#gradBreak)', label: 'Break time',  doneMsg: 'Break over — back to focus.' }
  };

  const STORAGE_KEY = 'pomodoro.sessions.v1';

  const state = {
    mode: 'focus',
    running: false,
    endAt: null,          // epoch ms when timer hits zero (while running)
    remainingMs: MODES.focus.seconds * 1000,
    totalMs: MODES.focus.seconds * 1000,
    tickId: null
  };

  /* ---------- elements ---------- */
  const $ = (id) => document.getElementById(id);
  const timeDisplay = $('timeDisplay');
  const modeLabel = $('modeLabel');
  const ringProgress = $('ringProgress');
  const card = document.querySelector('.card');
  const tabs = document.querySelector('.tabs');
  const tabButtons = Array.from(document.querySelectorAll('.tab'));
  const timerRegion = $('timer-region');
  const startBtn = $('startBtn');
  const pauseBtn = $('pauseBtn');
  const resetBtn = $('resetBtn');
  const sessionCount = $('sessionCount');
  const sessionPlural = $('sessionPlural');
  const toast = $('toast');

  const CIRC = 2 * Math.PI * 140;
  ringProgress.style.strokeDasharray = String(CIRC);

  /* ---------- sessions persistence ---------- */
  const todayKey = () => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  function loadSessions() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && raw.date === todayKey() && Number.isFinite(raw.count)) return raw.count;
    } catch (_) { /* corrupted storage — start fresh */ }
    return 0;
  }

  function saveSessions(count) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayKey(), count }));
    } catch (_) { /* storage unavailable — counter just won't persist */ }
  }

  function getSessions() { return loadSessions(); }

  function incrementSessions() {
    const next = loadSessions() + 1;
    saveSessions(next);
    renderSessions(next);
    return next;
  }

  function renderSessions(count) {
    const n = count == null ? getSessions() : count;
    sessionCount.textContent = String(n);
    sessionPlural.textContent = n === 1 ? '' : 's';
  }

  /* ---------- formatting ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const format = (ms) => {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    return `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`;
  };

  /* ---------- rendering ---------- */
  function render() {
    const frac = state.totalMs > 0 ? state.remainingMs / state.totalMs : 0;
    ringProgress.style.strokeDashoffset = String(CIRC * (1 - Math.max(0, Math.min(1, frac))));
    timeDisplay.textContent = format(state.remainingMs);
    document.title = state.running
      ? `${format(state.remainingMs)} · ${state.mode === 'focus' ? 'Focus' : 'Break'} — Pomodoro`
      : 'Pomodoro — Focus Timer';
  }

  function renderChrome() {
    const isFocus = state.mode === 'focus';
    const isBreak = !isFocus;

    card.classList.toggle('running', state.running);
    document.body.classList.toggle('running', state.running);

    ringProgress.setAttribute('stroke', MODES[state.mode].ring);
    ringProgress.classList.toggle('break-ring', isBreak);
    tabs.dataset.active = state.mode;
    timerRegion.setAttribute('aria-labelledby', isFocus ? 'tab-focus' : 'tab-break');

    tabButtons.forEach((btn) => {
      const active = btn.dataset.mode === state.mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    modeLabel.textContent = MODES[state.mode].label;

    startBtn.classList.toggle('is-break', isBreak);
    startBtn.disabled = state.running;
    pauseBtn.disabled = !state.running;

    const logoBadge = document.querySelector('.logo__badge');
    if (logoBadge) logoBadge.textContent = isFocus ? 'focus' : 'break';
  }

  /* ---------- timer engine ---------- */
  function start() {
    if (state.running) return;
    if (state.remainingMs <= 0) state.remainingMs = state.totalMs;
    state.running = true;
    state.endAt = Date.now() + state.remainingMs;
    startTick();
    renderChrome();
    render();
  }

  function pause() {
    if (!state.running) return;
    state.running = false;
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    stopTick();
    renderChrome();
    render();
  }

  function toggle() { state.running ? pause() : start(); }

  function reset() {
    state.running = false;
    state.remainingMs = state.totalMs;
    stopTick();
    renderChrome();
    render();
  }

  function startTick() {
    stopTick();
    state.tickId = setInterval(() => {
      state.remainingMs = state.endAt - Date.now();
      if (state.remainingMs <= 0) {
        state.remainingMs = 0;
        render();
        complete();
        return;
      }
      render();
    }, 100);
  }

  function stopTick() {
    if (state.tickId != null) {
      clearInterval(state.tickId);
      state.tickId = null;
    }
  }

  function complete() {
    state.running = false;
    stopTick();
    beep();
    const wasFocus = state.mode === 'focus';

    if (wasFocus) {
      incrementSessions();
      showToast(`${MODES.focus.doneMsg} Sessions today: ${getSessions()}`);
      switchMode('break');
    } else {
      showToast(MODES.break.doneMsg);
      switchMode('focus');
    }

    renderChrome();
    render();
  }

  function switchMode(mode) {
    state.mode = mode;
    state.totalMs = MODES[mode].seconds * 1000;
    state.remainingMs = state.totalMs;
    state.running = false;
  }

  /* ---------- sound ---------- */
  let audioCtx = null;
  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      const notes = [880, 1174.66, 880];
      notes.forEach((freq, i) => {
        const t = audioCtx.currentTime + i * 0.18;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.18);
      });
    } catch (_) { /* audio unavailable */ }
  }

  /* ---------- toast ---------- */
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  /* ---------- events ---------- */
  startBtn.addEventListener('click', start);
  pauseBtn.addEventListener('click', pause);
  resetBtn.addEventListener('click', reset);

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === state.mode || !MODES[mode]) return;
      stopTick();
      switchMode(mode);
      renderChrome();
      render();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    toggle();
  });

  // refresh the sessions counter if the date rolls over while the tab stays open
  setInterval(() => {
    const raw = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; } })();
    if (!raw || raw.date !== todayKey()) renderSessions(0);
  }, 60 * 1000);

  /* ---------- init ---------- */
  renderSessions();
  renderChrome();
  reset();
})();
