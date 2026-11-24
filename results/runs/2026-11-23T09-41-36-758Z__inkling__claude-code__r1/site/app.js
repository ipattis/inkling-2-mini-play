(() => {
  "use strict";

  const MODES = {
    focus: { duration: 25 * 60, label: "Focus time" },
    break: { duration: 5 * 60, label: "Break time" },
  };

  const CIRCUMFERENCE = 2 * Math.PI * 140; // matches ring r=140
  const STORAGE_KEY = "pomodoro.sessions";

  const timeEl = document.getElementById("time");
  const modeLabelEl = document.getElementById("mode-label");
  const ringEl = document.getElementById("ring-progress");
  const toggleBtn = document.getElementById("btn-toggle");
  const resetBtn = document.getElementById("btn-reset");
  const toastEl = document.getElementById("toast");
  const sessionsEl = document.getElementById("sessions-count");
  const dateEl = document.getElementById("date");
  const tabs = document.querySelectorAll(".tab");

  let mode = "focus";
  let remaining = MODES.focus.duration;
  let total = MODES.focus.duration;
  let running = false;
  let intervalId = null;
  let endAt = null; // timestamp when the timer should hit 0

  // ---------- helpers ----------
  const todayKey = () => new Date().toISOString().slice(0, 10);

  function loadSessions() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && raw.date === todayKey() && typeof raw.count === "number") {
        return raw.count;
      }
    } catch (_) { /* ignore */ }
    return 0;
  }

  function saveSessions(count) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayKey(), count }));
    } catch (_) { /* ignore */ }
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function render() {
    timeEl.textContent = formatTime(remaining);
    const progress = remaining / total;
    ringEl.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));
    modeLabelEl.textContent = MODES[mode].label;
    toggleBtn.textContent = running ? "Pause" : (remaining < total ? "Resume" : "Start");
  }

  function renderSessions() {
    sessionsEl.textContent = String(loadSessions());
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-visible");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove("is-visible"), 3200);
  }

  // ---------- timer logic ----------
  function tick() {
    const elapsed = (endAt - Date.now()) / 1000;
    remaining = Math.max(0, Math.ceil(elapsed));
    render();
    if (remaining <= 0) {
      completeCycle();
    }
  }

  function completeCycle() {
    stopTimer();
    const wasFocus = mode === "focus";
    if (wasFocus) {
      saveSessions(loadSessions() + 1);
      renderSessions();
      showToast("Focus session complete — take a break ☕");
      switchMode("break");
    } else {
      showToast("Break over — back to focus!");
      switchMode("focus");
    }
    beep();
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [0, 0.25, 0.5].forEach((delay, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = i === 2 ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.22);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.25);
      });
      setTimeout(() => ctx.close(), 1500);
    } catch (_) { /* audio not available */ }
  }

  function startTimer() {
    if (running) return;
    if (remaining <= 0) remaining = total;
    running = true;
    endAt = Date.now() + remaining * 1000;
    intervalId = setInterval(tick, 200);
    render();
  }

  function pauseTimer() {
    if (!running) return;
    running = false;
    clearInterval(intervalId);
    intervalId = null;
    render();
  }

  function stopTimer() {
    running = false;
    clearInterval(intervalId);
    intervalId = null;
    endAt = null;
  }

  function resetTimer() {
    stopTimer();
    remaining = total;
    render();
  }

  function switchMode(newMode) {
    stopTimer();
    mode = newMode;
    total = MODES[mode].duration;
    remaining = total;
    document.body.dataset.mode = mode;
    tabs.forEach((t) => {
      const active = t.dataset.mode === mode;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
    });
    document.getElementById("timer-panel").setAttribute("aria-labelledby", `tab-${mode}`);
    render();
  }

  function toggle() {
    if (running) pauseTimer();
    else startTimer();
  }

  // ---------- wiring ----------
  toggleBtn.addEventListener("click", toggle);
  resetBtn.addEventListener("click", resetTimer);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) {
      const target = e.target;
      if (target && (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return; // let buttons keep their native space behavior
      }
      e.preventDefault();
      toggle();
    }
  });

  // ---------- init ----------
  const now = new Date();
  dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  document.body.dataset.mode = mode;
  renderSessions();
  render();
})();
