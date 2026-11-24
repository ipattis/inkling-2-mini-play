(() => {
  "use strict";

  /* ---------- Constants ---------- */
  const FOCUS_SECONDS = 25 * 60;
  const BREAK_SECONDS = 5 * 60;
  const RADIUS = 85;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const STORAGE_KEY = "pomodoro.sessions.v1";
  const TICK_MS = 200;

  /* ---------- Elements ---------- */
  const timeEl = document.getElementById("time");
  const ringEl = document.getElementById("ring-fg");
  const ringWrapEl = document.querySelector(".ring-wrap");
  const startBtn = document.getElementById("btn-start");
  const resetBtn = document.getElementById("btn-reset");
  const tabFocus = document.getElementById("tab-focus");
  const tabBreak = document.getElementById("tab-break");
  const tabsEl = document.querySelector(".tabs");
  const sessionsEl = document.getElementById("sessions");
  const pomosEl = document.getElementById("pomos");

  /* ---------- State ---------- */
  const state = {
    mode: "focus", // "focus" | "break"
    remaining: FOCUS_SECONDS,
    running: false,
    endAt: null,
    tickId: null,
  };

  let sessions = loadSessions();

  /* ---------- Persistence ---------- */
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  }

  function loadSessions() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && raw.date === todayKey() && Number.isFinite(raw.count)) {
        return Math.max(0, raw.count);
      }
    } catch {
      /* corrupted storage — start fresh */
    }
    return 0;
  }

  function saveSessions() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayKey(), count: sessions }));
    } catch {
      /* storage unavailable (private mode) — ignore */
    }
  }

  function renderSessions() {
    sessionsEl.textContent = String(sessions);
    // Show up to 12 pomodoro dots, then just the number
    pomosEl.textContent = sessions > 0 && sessions <= 12 ? "\u{1F345}".repeat(sessions) : "";
  }

  /* ---------- Helpers ---------- */
  const modeSeconds = (mode) => (mode === "focus" ? FOCUS_SECONDS : BREAK_SECONDS);

  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      gain.connect(ctx.destination);
      [660, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + i * 0.18);
        osc.stop(ctx.currentTime + i * 0.18 + 0.6);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1500);
    } catch {
      /* audio not available — stay silent */
    }
  }

  /* ---------- Rendering ---------- */
  function render() {
    timeEl.textContent = formatTime(state.remaining);
    const total = modeSeconds(state.mode);
    const fraction = total > 0 ? state.remaining / total : 0;
    ringEl.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction));
    document.title = `${formatTime(state.remaining)} · ${
      state.mode === "focus" ? "Focus" : "Break"
    }`;
  }

  function renderButtons() {
    startBtn.textContent = state.running ? "Pause" : "Start";
    ringWrapEl.classList.toggle("running", state.running);
  }

  function renderMode() {
    tabFocus.classList.toggle("is-active", state.mode === "focus");
    tabBreak.classList.toggle("is-active", state.mode === "break");
    tabFocus.setAttribute("aria-selected", String(state.mode === "focus"));
    tabBreak.setAttribute("aria-selected", String(state.mode === "break"));
    tabsEl.classList.toggle("break", state.mode === "break");
    ringWrapEl.classList.toggle("break", state.mode === "break");
  }

  /* ---------- Timer engine (timestamp-based, drift-free) ---------- */
  function start() {
    if (state.running || state.remaining <= 0) return;
    state.running = true;
    state.endAt = Date.now() + state.remaining * 1000;
    state.tickId = setInterval(tick, TICK_MS);
    renderButtons();
  }

  function pause() {
    if (!state.running) return;
    state.running = false;
    clearInterval(state.tickId);
    state.tickId = null;
    state.remaining = Math.max(0, Math.round((state.endAt - Date.now()) / 1000));
    render();
    renderButtons();
  }

  function tick() {
    state.remaining = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
    if (state.remaining <= 0) {
      complete();
      return;
    }
    render();
  }

  function complete() {
    state.running = false;
    clearInterval(state.tickId);
    state.tickId = null;
    beep();

    if (state.mode === "focus") {
      sessions += 1;
      saveSessions();
      renderSessions();
      switchMode("break");
    } else {
      switchMode("focus");
    }
    renderButtons();
  }

  function reset() {
    if (state.running) pause();
    state.remaining = modeSeconds(state.mode);
    render();
    renderButtons();
  }

  function switchMode(mode) {
    if (state.running) pause();
    state.mode = mode;
    state.remaining = modeSeconds(mode);
    renderMode();
    render();
  }

  /* ---------- Events ---------- */
  startBtn.addEventListener("click", () => (state.running ? pause() : start()));
  resetBtn.addEventListener("click", reset);
  tabFocus.addEventListener("click", () => switchMode("focus"));
  tabBreak.addEventListener("click", () => switchMode("break"));

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.key !== " ") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault(); // also prevents a focused button from double-firing
    state.running ? pause() : start();
  });

  // Keep the counter accurate if the tab stays open across midnight
  setInterval(() => {
    const fresh = loadSessions();
    if (fresh !== sessions) {
      sessions = fresh;
      renderSessions();
    }
  }, 60_000);

  /* ---------- Init ---------- */
  ringEl.style.strokeDasharray = String(CIRCUMFERENCE);
  renderMode();
  render();
  renderButtons();
  renderSessions();
})();
