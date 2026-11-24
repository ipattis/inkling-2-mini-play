(() => {
  "use strict";

  const MODES = {
    focus: { label: "Time to focus", minutes: 25, title: "Focus" },
    break: { label: "Take a break", minutes: 5, title: "Break" },
  };
  const STORAGE_KEY = "pomodoro.sessions.v1";
  const DOT_COUNT = 8;

  const RING_R = 118;
  const RING_C = 2 * Math.PI * RING_R;

  const els = {
    root: document.documentElement,
    ring: document.getElementById("ring"),
    progress: document.getElementById("progress"),
    time: document.getElementById("time"),
    modeLabel: document.getElementById("modeLabel"),
    toggle: document.getElementById("toggle"),
    reset: document.getElementById("reset"),
    status: document.getElementById("status"),
    count: document.getElementById("count"),
    dots: document.getElementById("dots"),
    tabs: Array.from(document.querySelectorAll(".tab")),
  };

  els.progress.style.strokeDasharray = `${RING_C} ${RING_C}`;
  els.progress.style.strokeDashoffset = "0";

  const state = {
    mode: "focus",
    remainingMs: MODES.focus.minutes * 60000,
    endAt: 0,
    running: false,
    frame: null,
    lastShownSecond: null,
  };

  /* ---------- Session counter (localStorage) ---------- */

  function todayKey() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function readSessions() {
    const today = todayKey();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.date === today && Number.isFinite(data.count)) {
        return data;
      }
    } catch (_) {
      /* corrupt or unavailable storage: fall through to a fresh record */
    }
    return { date: today, count: 0 };
  }

  function writeSessions(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {
      /* storage full or blocked: counter still works for this page load */
    }
  }

  function renderSessions(count) {
    els.count.textContent = String(count);
    const done = Math.min(count, DOT_COUNT);
    els.dots.innerHTML = "";
    for (let i = 0; i < DOT_COUNT; i++) {
      const dot = document.createElement("span");
      dot.className = i < done ? "dot done" : "dot";
      els.dots.appendChild(dot);
    }
  }

  let sessions = readSessions();
  renderSessions(sessions.count);

  /* ---------- Formatting ---------- */

  function format(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function modeTotalMs(mode) {
    return MODES[mode].minutes * 60000;
  }

  /* ---------- Rendering ---------- */

  function render(force = false) {
    const total = modeTotalMs(state.mode);
    const remaining = Math.max(0, state.remainingMs);
    const fraction = total > 0 ? remaining / total : 0;

    // Ring shows remaining time: full at start, empty at zero.
    els.progress.style.strokeDashoffset = String(RING_C * (1 - fraction));

    const sec = Math.ceil(remaining / 1000);
    if (force || sec !== state.lastShownSecond) {
      state.lastShownSecond = sec;
      const text = format(remaining);
      els.time.textContent = text;
      document.title = state.running
        ? `${text} · ${MODES[state.mode].title} | Pomodoro`
        : "Pomodoro Focus Timer";
    }

    els.toggle.textContent = state.running ? "Pause" : remaining < total && remaining > 0 ? "Resume" : "Start";
    els.toggle.setAttribute("aria-pressed", String(state.running));
    els.ring.classList.toggle("running", state.running);
  }

  function setStatus(msg) {
    els.status.textContent = msg;
  }

  /* ---------- Timer loop ---------- */

  function loop() {
    if (!state.running) return;
    state.remainingMs = state.endAt - Date.now();
    if (state.remainingMs <= 0) {
      state.remainingMs = 0;
      render();
      complete();
      return;
    }
    render();
    state.frame = requestAnimationFrame(loop);
  }

  function start() {
    if (state.running) return;
    if (state.remainingMs <= 0) state.remainingMs = modeTotalMs(state.mode);
    state.endAt = Date.now() + state.remainingMs;
    state.running = true;
    setStatus("");
    render(true);
    state.frame = requestAnimationFrame(loop);
  }

  function pause() {
    if (!state.running) return;
    state.running = false;
    cancelAnimationFrame(state.frame);
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    setStatus("Paused");
    render(true);
  }

  function toggle() {
    state.running ? pause() : start();
  }

  function resetTimer() {
    cancelAnimationFrame(state.frame);
    state.running = false;
    state.remainingMs = modeTotalMs(state.mode);
    setStatus("");
    render(true);
  }

  function complete() {
    cancelAnimationFrame(state.frame);
    state.running = false;

    const finished = state.mode;
    if (finished === "focus") {
      sessions = readSessions();
      sessions.count += 1;
      writeSessions(sessions);
      renderSessions(sessions.count);
      setStatus("Focus session complete. Enjoy your break!");
      switchMode("break");
    } else {
      setStatus("Break over. Ready to focus?");
      switchMode("focus");
    }
    notify(finished === "focus" ? "Focus session complete" : "Break is over");
  }

  function notify(text) {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("Pomodoro", { body: text });
      } catch (_) {
        /* ignore */
      }
    }
  }

  /* ---------- Modes ---------- */

  function switchMode(mode) {
    if (!MODES[mode]) return;
    cancelAnimationFrame(state.frame);
    state.running = false;
    state.mode = mode;
    state.remainingMs = modeTotalMs(mode);
    state.lastShownSecond = null;

    els.root.dataset.mode = mode;
    els.modeLabel.textContent = MODES[mode].label;
    els.tabs.forEach((tab) => {
      const selected = tab.dataset.mode === mode;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const small = tab.querySelector("small");
      if (small) small.textContent = format(modeTotalMs(tab.dataset.mode));
    });
    const panel = document.getElementById("timer");
    panel.setAttribute("aria-labelledby", `tab-${mode}`);

    render(true);
  }

  /* ---------- Events ---------- */

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.mode !== state.mode) {
        setStatus("");
        switchMode(tab.dataset.mode);
      }
    });
  });

  // Arrow keys move between tabs (roving focus).
  els.tabs.forEach((tab) => {
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const next = e.key === "ArrowRight" ? "break" : "focus";
      switchMode(next);
      document.getElementById(`tab-${next}`).focus();
    });
  });

  els.toggle.addEventListener("click", toggle);
  els.reset.addEventListener("click", resetTimer);

  // Space toggles start/pause globally, unless the user is typing in a field.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.key !== " ") return;
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      return;
    }
    e.preventDefault();
    toggle();
  });

  // Keep the counter correct across midnight / other tabs.
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      sessions = readSessions();
      renderSessions(sessions.count);
    }
  });

  // Recompute on tab visibility change so the timer stays accurate after throttling.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.running) render(true);
  });

  // Ask for notification permission only if it's not yet decided and the user is not interacting yet.
  // Permission is requested lazily on first Start to keep the initial load quiet.
  els.toggle.addEventListener("click", () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, { once: true });

  // Roll the counter over at local midnight, even if the page stays open.
  setInterval(() => {
    if (todayKey() !== sessions.date) {
      sessions = readSessions();
      renderSessions(sessions.count);
    }
  }, 60000);

  switchMode("focus");
})();
