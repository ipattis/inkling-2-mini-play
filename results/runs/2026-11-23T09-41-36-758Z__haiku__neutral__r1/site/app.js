(function () {
  'use strict';

  var MODES = {
    focus: { label: 'Focus', minutes: 25, phase: 'Time to focus' },
    break: { label: 'Break', minutes: 5, phase: 'Take a break' }
  };
  var STORAGE_KEY = 'pomodoro.sessions.v1';
  var CIRCUMFERENCE = 2 * Math.PI * 90; // matches r=90 in index.html

  var els = {
    time: document.getElementById('time'),
    phase: document.getElementById('phase'),
    progress: document.getElementById('progress'),
    ringWrap: document.querySelector('.ring-wrap'),
    startBtn: document.getElementById('startBtn'),
    resetBtn: document.getElementById('resetBtn'),
    count: document.getElementById('sessionCount'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
    panel: document.getElementById('timer')
  };

  var state = {
    mode: 'focus',
    remainingMs: MODES.focus.minutes * 60 * 1000,
    running: false,
    endAt: 0,
    ticker: null
  };

  /* ---------- Session counter (localStorage) ---------- */

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadSessions() {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data && data.date === todayKey() && typeof data.count === 'number') {
        return data.count;
      }
    } catch (e) { /* ignore corrupt or unavailable storage */ }
    return 0;
  }

  function saveSessions(count) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayKey(), count: count }));
    } catch (e) { /* storage may be full or disabled */ }
  }

  var sessionsToday = loadSessions();

  function renderCount(bump) {
    els.count.textContent = String(sessionsToday);
    if (bump) {
      els.count.classList.add('bump');
      setTimeout(function () { els.count.classList.remove('bump'); }, 250);
    }
  }

  /* ---------- Helpers ---------- */

  function totalMs() {
    return MODES[state.mode].minutes * 60 * 1000;
  }

  function formatTime(ms) {
    var totalSec = Math.ceil(ms / 1000);
    if (totalSec < 0) totalSec = 0;
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      [0, 0.25, 0.5].forEach(function (offset) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.22);
      });
      setTimeout(function () { ctx.close(); }, 1500);
    } catch (e) { /* audio is optional */ }
  }

  /* ---------- Rendering ---------- */

  function render() {
    var remaining = Math.max(0, state.remainingMs);
    var fraction = remaining / totalMs(); // 1 = full, 0 = done
    els.time.textContent = formatTime(remaining);
    els.progress.style.strokeDasharray = CIRCUMFERENCE.toFixed(2);
    els.progress.style.strokeDashoffset = (CIRCUMFERENCE * (1 - fraction)).toFixed(2);

    els.startBtn.textContent = state.running ? 'Pause' : (state.remainingMs < totalMs() ? 'Resume' : 'Start');
    els.startBtn.setAttribute('aria-pressed', String(state.running));
    els.ringWrap.classList.toggle('running', state.running);
    els.phase.textContent = state.running
      ? (state.mode === 'focus' ? 'Focusing' : 'Breathing')
      : MODES[state.mode].phase;

    document.body.classList.toggle('mode-break', state.mode === 'break');
    document.title = (state.running ? formatTime(remaining) + ' · ' : '') + MODES[state.mode].label + ' · Focus Timer';
  }

  function setMode(mode) {
    if (!MODES[mode]) return;
    pause();
    state.mode = mode;
    state.remainingMs = totalMs();
    els.tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-mode') === mode;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) els.panel.setAttribute('aria-labelledby', tab.id);
    });
    render();
  }

  /* ---------- Timer control ---------- */

  function tick() {
    state.remainingMs = state.endAt - Date.now();
    if (state.remainingMs <= 0) {
      state.remainingMs = 0;
      finishSession();
      return;
    }
    render();
  }

  function start() {
    if (state.running) return;
    if (state.remainingMs <= 0) state.remainingMs = totalMs();
    state.running = true;
    state.endAt = Date.now() + state.remainingMs;
    state.ticker = setInterval(tick, 250);
    render();
  }

  function pause() {
    if (!state.running) return;
    state.running = false;
    clearInterval(state.ticker);
    state.ticker = null;
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    render();
  }

  function reset() {
    pause();
    state.remainingMs = totalMs();
    render();
  }

  function toggle() {
    if (state.running) pause();
    else start();
  }

  function finishSession() {
    var finished = state.mode;
    pause();
    state.remainingMs = 0;
    render();
    beep();

    if (finished === 'focus') {
      sessionsToday += 1;
      saveSessions(sessionsToday);
      renderCount(true);
      setMode('break');
    } else {
      setMode('focus');
    }
    // Next phase is queued but not started: user presses Start/Space to begin.
  }

  /* ---------- Events ---------- */

  els.startBtn.addEventListener('click', toggle);
  els.resetBtn.addEventListener('click', reset);

  els.tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      setMode(tab.getAttribute('data-mode'));
    });
  });

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  els.tabs.forEach(function (tab, i) {
    tab.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var next = els.tabs[(i + (e.key === 'ArrowRight' ? 1 : els.tabs.length - 1)) % els.tabs.length];
        next.focus();
        setMode(next.getAttribute('data-mode'));
      }
    });
  });

  function isSpace(e) {
    return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  }

  // Space toggles start/pause globally. Prevent page scroll and stop the
  // browser from also "clicking" whichever button happens to be focused.
  document.addEventListener('keydown', function (e) {
    if (!isSpace(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target && e.target.isContentEditable) return;
    e.preventDefault();
    if (!e.repeat) toggle();
  });

  document.addEventListener('keyup', function (e) {
    if (isSpace(e)) e.preventDefault();
  });

  // Keep the timer accurate when the tab was in background/sleeping.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.running) tick();
  });

  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      sessionsToday = loadSessions();
      renderCount(false);
    }
  });

  /* ---------- Init ---------- */

  renderCount(false);
  setMode('focus');
})();
