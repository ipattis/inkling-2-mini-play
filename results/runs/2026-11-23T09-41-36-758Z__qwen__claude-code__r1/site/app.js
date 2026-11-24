(() => {
  "use strict";

  // ---------- Constants ----------
  const MODES = {
    focus: { label: "Focus", seconds: 25 * 60 },
    break: { label: "Break", seconds: 5 * 60 },
  };
  const STORAGE_KEY = "pomodoro.sessions";
  const RING_RADIUS = 84;
  const RING_CIRC = 2 * Math.PI * RING_RADIUS;

  // ---------- State ----------
  const state = {
    mode: "focus",
    remaining: MODES.focus.seconds, // seconds (can be fractional while running)
    running: false,
    endAt: null, // timestamp when the timer will hit zero
    finished: false,
  };

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    body: document.body,
    tabs: document.querySelector(".tabs"),
    tabFocus: $("tabFocus"),
    tabBreak: $("tabBreak"),
    modeBadge: $("modeBadge"),
    ring: document.querySelector(".timer"),
    ringProgress: $("ringProgress"),
    time: $("timeDisplay"),
    stateLabel: $("stateLabel"),
    toggleBtn: $("toggleBtn"),
    toggleLabel: $("toggleLabel"),
    iconPlay: $("iconPlay"),
    iconPause: $("iconPause"),
    resetBtn: $("resetBtn"),
    sessionsText: $("sessionsText"),
    sessionsDot: $("sessionsDot"),
  };

  let tickTimer = null;
  let audioCtx = null;

  // ---------- Helpers ----------
  const pad = (n) => String(n).padStart(2, "0");

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.ceil(totalSeconds));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function loadSessions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      return data.date === todayKey() ? Math.max(0, data.count | 0) : 0;
    } catch {
      return 0;
    }
  }

  function saveSessions(count) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayKey(), count }));
    } catch {
      /* storage unavailable — ignore */
    }
  }

  let sessions = loadSessions();

  function renderSessions() {
    const plural = sessions === 1 ? "session" : "sessions";
    els.sessionsText.innerHTML = `<strong>${sessions}</strong> ${plural} today`;
    els.sessionsDot.classList.toggle("is-warm", sessions > 0);
  }

  // ---------- Audio (tiny completion chime, no assets) ----------
  function ensureAudio() {
    if (!audioCtx && window.AudioContext) {
      audioCtx = new AudioContext();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  function chime() {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.18]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + delay + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.7);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.75);
    });
  }

  // ---------- Rendering ----------
  function render() {
    const total = MODES[state.mode].seconds;
    const remaining = state.running
      ? Math.max(0, (state.endAt - Date.now()) / 1000)
      : state.remaining;

    // Ring: full when time is full, drains to empty.
    const progress = Math.min(1, Math.max(0, remaining / total));
    els.ringProgress.style.strokeDashoffset = String(RING_CIRC * (1 - progress));

    els.time.textContent = formatTime(remaining);
    document.title = `${formatTime(remaining)} — ${MODES[state.mode].label} · Pomodoro`;

    const label = state.finished
      ? "Complete"
      : state.running
        ? state.mode === "focus"
          ? "Focusing"
          : "On a break"
        : state.remaining < total
          ? "Paused"
          : "Ready";
    els.stateLabel.textContent = label;

    els.toggleLabel.textContent = state.running ? "Pause" : "Start";
    els.iconPlay.style.display = state.running ? "none" : "";
    els.iconPause.style.display = state.running ? "" : "none";

    els.ring.classList.toggle("is-paused", !state.running && !state.finished && state.remaining < total);
    els.ring.classList.toggle("is-done", state.finished);
  }

  // ---------- Timer engine (timestamp-based: no drift) ----------
  function tick() {
    if (!state.running) return;
    const now = Date.now();
    state.remaining = Math.max(0, (state.endAt - now) / 1000);
    render();
    if (state.remaining <= 0) complete();
  }

  function start() {
    if (state.running || state.remaining <= 0) return;
    ensureAudio();
    state.finished = false;
    state.running = true;
    state.endAt = Date.now() + state.remaining * 1000;
    tickTimer = setInterval(tick, 250);
    render();
  }

  function pause() {
    if (!state.running) return;
    state.running = false;
    state.remaining = Math.max(0, (state.endAt - Date.now()) / 1000);
    clearInterval(tickTimer);
    render();
  }

  function reset() {
    state.running = false;
    state.finished = false;
    state.remaining = MODES[state.mode].seconds;
    clearInterval(tickTimer);
    render();
  }

  function toggle() {
    if (state.finished) { reset(); start(); return; }
    state.running ? pause() : start();
  }

  function complete() {
    clearInterval(tickTimer);
    state.running = false;
    state.finished = true;
    state.remaining = 0;
    chime();

    const wasFocus = state.mode === "focus";
    if (wasFocus) {
      sessions += 1;
      saveSessions(sessions);
      renderSessions();
    }

    render();

    // Roll straight into the next phase (paused, ready to start) —
    // unless the user already picked a mode meanwhile.
    setTimeout(() => {
      if (state.finished && state.mode === (wasFocus ? "focus" : "break")) {
        state.finished = false;
        switchMode(wasFocus ? "break" : "focus");
      }
    }, 1600);
  }

  function switchMode(mode) {
    if (mode === state.mode && state.remaining === MODES[mode].seconds && !state.running) return;
    state.mode = mode;
    state.running = false;
    state.finished = false;
    state.remaining = MODES[mode].seconds;
    clearInterval(tickTimer);

    els.tabs.dataset.active = mode;
    els.tabFocus.setAttribute("aria-selected", String(mode === "focus"));
    els.tabBreak.setAttribute("aria-selected", String(mode === "break"));
    els.modeBadge.textContent = MODES[mode].label;
    els.body.dataset.mode = mode;
    render();
  }

  // ---------- Wiring ----------
  els.ringProgress.style.strokeDasharray = String(RING_CIRC);

  els.toggleBtn.addEventListener("click", () => { toggle(); els.toggleBtn.blur(); });
  els.resetBtn.addEventListener("click", () => { reset(); els.resetBtn.blur(); });
  els.tabFocus.addEventListener("click", () => switchMode("focus"));
  els.tabBreak.addEventListener("click", () => switchMode("break"));

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    if (e.target.closest("button, input, textarea, [contenteditable]")) return; // let native buttons keep Space
    e.preventDefault();
    toggle();
  });

  // Re-render on the minute boundary while the tab is hidden (interval throttles there).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.running) render();
  });

  renderSessions();
  render();
})();
