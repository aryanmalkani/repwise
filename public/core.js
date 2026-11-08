// RepWise — shared helpers used by every screen.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- dates and numbers ----------

export const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const mondayOf = (s) => addDays(s, -((parseYmd(s).getDay() + 6) % 7));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmt = (n, d = 1) => (n == null || n === "" || Number.isNaN(Number(n)) ? "" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
export const e1rm = (w, r) => (r <= 1 ? w : w * (1 + r / 30));
export const toNum = (v) => { if (v === "" || v == null) return NaN; return parseFloat(String(v).replace(",", ".")); };

export function fmtDay(s, long = false) {
  const t = today();
  if (s === t) return "Today";
  if (s === addDays(t, -1)) return "Yesterday";
  const d = parseYmd(s);
  const opts = { weekday: long ? "long" : "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}
export const fmtShort = (s) => parseYmd(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
export function fmtMinutes(sec) {
  const m = Math.round((sec || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

// ---------- app state ----------

export const S = {
  me: null,
  settings: { unit: "kg" },
  exercises: null, // last performance per exercise, from /api/exercises
  byId: {},
  returnTo: "#/",
  historyWeeks: 4,
  historyFilter: "all",
  photoTab: "body",
  progressKey: null,
  draft: null, // a rejected upload being corrected in its form
};
export const unit = () => S.settings.unit || "kg";

// localStorage that never throws
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// A screen claims the view when it starts loading. If a newer screen has started by the time
// its data arrives, the returned check is false and it must not draw.
let viewSeq = 0;
export const claimView = () => { const seq = ++viewSeq; return () => seq === viewSeq; };
export const currentView = () => viewSeq;

// ---------- API ----------

export class OfflineError extends Error {}
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(method, path, body) {
  const headers = { "x-gymlog": "1" };
  let payload;
  if (body instanceof Blob) { payload = body; headers["content-type"] = body.type; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
  let res;
  try {
    res = await fetch("/api" + path, { method, headers, body: payload, credentials: "same-origin" });
  } catch {
    throw new OfflineError("You're offline.");
  }
  const isJson = (res.headers.get("content-type") || "").includes("json");
  // A reply that can't be read means the connection dropped partway through.
  const data = isJson ? await res.json().catch(() => { throw new OfflineError("You're offline."); }) : null;
  if (res.status === 401 && path !== "/login") {
    onUnauthorized();
    throw new ApiError(401, "Log in to continue.");
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Something went wrong (${res.status}).`);
  return data;
}

export async function loadExercises(force = false) {
  if (!S.exercises || force) S.exercises = await api("GET", "/exercises").catch((e) => { if (S.exercises) return S.exercises; throw e; });
  return S.exercises;
}

// ---------- offline queue ----------

const QKEY = "gymlog-queue";
const FAILED_KEY = "gymlog-failed";
export const getQ = () => store.get(QKEY, []);
export const setQ = (q) => store.set(QKEY, q);
// Saved entries the server rejected, kept until they're fixed or discarded.
export const getFailed = () => store.get(FAILED_KEY, []);
export const setFailed = (list) => store.set(FAILED_KEY, list);
export const dropFailed = (id) => setFailed(getFailed().filter((f) => f.id !== id));

// Identifies one save, so the server can recognise a repeat of it.
export const newClientId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// ---------- toast ----------

let toastTimer;
export function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isError ? 4200 : 2200);
}

// ---------- Back button ----------

// On Android, Back should close whatever is open on top instead of leaving the screen.
// Opening something adds a marker to the browser history for Back to land on.
const modalOpen = () => !$("#sheet").hidden || !!$(".overlay, .viewer");
export function holdBack() { if (!history.state?.modal) history.pushState({ modal: true }, ""); }
// Waits a moment so a navigation that follows the close isn't undone by going back.
export function releaseBack() { setTimeout(() => { if (history.state?.modal && !modalOpen()) history.back(); }, 0); }

// ---------- bottom sheet ----------

let sheetOnClose = null;
export function openSheet(html, onClose = null) {
  const sheet = $("#sheet");
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
  const panel = $(".sheet-panel", sheet);
  panel.innerHTML = html;
  sheet.hidden = false;
  sheet.classList.remove("open");
  void sheet.offsetWidth;
  sheet.classList.add("open");
  document.body.classList.add("locked");
  holdBack();
  sheetOnClose = onClose;
  panel.scrollTop = 0;
  return panel;
}
export function closeSheet(chosen = false, navigating = false) {
  const sheet = $("#sheet");
  if (sheet.hidden) return;
  sheet.hidden = true;
  sheet.classList.remove("open");
  if (!$(".overlay")) document.body.classList.remove("locked");
  const f = sheetOnClose;
  sheetOnClose = null;
  if (!chosen && f) f();
  if (!navigating) releaseBack();
}
export function initSheet() {
  const sheet = $("#sheet");
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeSheet();
    else if (e.target.closest("a[href^='#']")) closeSheet(true, true);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
  window.addEventListener("popstate", (e) => {
    const top = $(".viewer") || (sheet.hidden ? null : sheet) || $(".overlay");
    if (!top) {
      if (e.state?.modal) history.back(); // a leftover marker from something already closed
      return;
    }
    if (top === sheet) closeSheet(); else $("[data-x]", top).click();
    if (modalOpen()) holdBack();
  });
}

// A list of choices in a bottom sheet. Resolves with the chosen value, or null if dismissed.
export function choose(title, options, { subtitle = "" } = {}) {
  return new Promise((resolve) => {
    const panel = openSheet(
      `<h2 id="sheetTitle">${esc(title)}</h2>${subtitle ? `<p class="sheet-sub">${esc(subtitle)}</p>` : ""}
      <div class="menu">${options.map((o, i) => `<button type="button" class="menu-item${o.danger ? " danger" : ""}" data-i="${i}"${o.current ? ' aria-current="true"' : ""}>
        ${o.icon || ""}<span class="main"><span class="title">${esc(o.label)}</span>${o.hint ? `<span class="meta">${esc(o.hint)}</span>` : ""}</span>${o.current ? `<span class="tick">${ICON.check}</span>` : ""}</button>`).join("")}</div>`,
      () => resolve(null)
    );
    panel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      closeSheet(true);
      resolve(options[Number(b.dataset.i)].value);
    });
  });
}

export const confirmSheet = (title, yesLabel, { subtitle = "", danger = true, noLabel = "Cancel" } = {}) =>
  choose(title, [{ label: yesLabel, value: true, danger }, { label: noLabel, value: false }], { subtitle }).then((v) => v === true);

// ---------- date picker ----------

const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const fmtDate = (s, opts) => parseYmd(s).toLocaleDateString(undefined, opts);

// "Today, 8 Nov", "Yesterday, 7 Nov" or "Fri, 6 Nov".
function dateLabel(s) {
  const t = today();
  const rel = s === t ? "Today" : s === addDays(t, -1) ? "Yesterday" : "";
  return rel ? `${rel}, ${fmtShort(s)}` : fmtDay(s);
}

// A calendar in a bottom sheet. Resolves with the chosen date, or null if dismissed.
function pickDate({ value, max = "", accent = "" }) {
  return new Promise((resolve) => {
    const t = today();
    const maxMonth = max.slice(0, 7);
    const allowed = (d) => !max || d <= max;
    const heroYear = value.slice(0, 4) === t.slice(0, 4) ? {} : { year: "numeric" };
    const quick = [["Today", t], ["Yesterday", addDays(t, -1)], ["2 days ago", addDays(t, -2)]].filter(([, d]) => allowed(d));
    const weekdays = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "narrow" })); // 1 Jan 2024 was a Monday

    let mode = "days", month = value.slice(0, 7), focus = value, slide = "";
    const panel = openSheet(`<div class="cal" style="${esc(accent)}">
      <div class="cal-hero"><span>${esc(fmtDate(value, { weekday: "long" }))}</span><h2 id="sheetTitle">${esc(fmtDate(value, { day: "numeric", month: "long", ...heroYear }))}</h2></div>
      <div class="chips cal-quick">${quick.map(([label, d]) => `<button type="button" class="chip" data-d="${d}" aria-pressed="${d === value}">${label}</button>`).join("")}</div>
      <div class="cal-nav"></div>
      <div class="cal-body"></div>
    </div>`, () => resolve(null));
    const root = $(".cal", panel), nav = $(".cal-nav", root), body = $(".cal-body", root);

    const canGoNext = () => !maxMonth || (mode === "days" ? shiftMonth(month, 1) <= maxMonth : month.slice(0, 4) < maxMonth.slice(0, 4));

    const drawNav = () => {
      const noun = mode === "days" ? "month" : "year";
      const title = mode === "days" ? fmtDate(`${month}-01`, { month: "long", year: "numeric" }) : month.slice(0, 4);
      nav.innerHTML = `<button type="button" class="cal-arrow" data-step="-1" aria-label="Previous ${noun}">${ICON.back}</button>
        <button type="button" class="cal-title" data-toggle aria-label="${esc(title)}. ${mode === "days" ? "Choose a month" : "Back to days"}">${esc(title)}${ICON.down}</button>
        <button type="button" class="cal-arrow" data-step="1" aria-label="Next ${noun}"${canGoNext() ? "" : " disabled"}>${ICON.forward}</button>`;
    };

    const drawDays = () => {
      const first = `${month}-01`;
      const start = addDays(first, -((parseYmd(first).getDay() + 6) % 7));
      if (focus.slice(0, 7) !== month) focus = [value, t].find((d) => d.slice(0, 7) === month) || first;
      const cells = [...Array(42)].map((_, i) => addDays(start, i)).map((d) =>
        `<button type="button" class="cal-day${d.slice(0, 7) === month ? "" : " out"}" data-d="${d}" tabindex="${d === focus ? 0 : -1}" aria-label="${esc(fmtDate(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}"${d === value ? ' aria-pressed="true"' : ""}${d === t ? ' aria-current="date"' : ""}${allowed(d) ? "" : " disabled"}>${parseYmd(d).getDate()}</button>`);
      body.innerHTML = `<div class="cal-week" aria-hidden="true">${weekdays.map((w) => `<span>${esc(w)}</span>`).join("")}</div>
        <div class="cal-grid ${slide}" role="group" aria-label="${esc(fmtDate(first, { month: "long", year: "numeric" }))}">${cells.join("")}</div>`;
    };

    const drawMonths = () => {
      const year = month.slice(0, 4);
      body.innerHTML = `<div class="cal-months ${slide}">${[...Array(12)].map((_, i) => {
        const m = `${year}-${pad(i + 1)}`;
        return `<button type="button" class="cal-month" data-m="${m}"${m === value.slice(0, 7) ? ' aria-pressed="true"' : ""}${m === t.slice(0, 7) ? ' aria-current="date"' : ""}${maxMonth && m > maxMonth ? " disabled" : ""}>${esc(fmtDate(`${m}-01`, { month: "short" }))}</button>`;
      }).join("")}</div>`;
    };

    const draw = () => { drawNav(); if (mode === "days") drawDays(); else drawMonths(); slide = ""; };
    const step = (dir) => {
      if (dir > 0 && !canGoNext()) return;
      month = shiftMonth(month, dir * (mode === "days" ? 1 : 12));
      slide = dir > 0 ? "next" : "prev";
      draw();
    };

    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      if (b.dataset.d) { closeSheet(true); resolve(b.dataset.d); return; }
      if (b.dataset.m) { month = b.dataset.m; mode = "days"; draw(); return; }
      if (b.dataset.step) { step(Number(b.dataset.step)); $(`[data-step="${b.dataset.step}"]`, nav)?.focus({ preventScroll: true }); return; }
      if ("toggle" in b.dataset) {
        mode = mode === "days" ? "months" : "days";
        if (maxMonth && month > maxMonth) month = maxMonth;
        draw();
        $("[data-toggle]", nav).focus({ preventScroll: true });
      }
    });

    // Swipe sideways to change month.
    let startX = 0, startY = 0;
    body.addEventListener("touchstart", (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
    body.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - startX, dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }, { passive: true });

    // Arrow keys move between days, Page Up and Page Down between months.
    body.addEventListener("keydown", (e) => {
      const d = e.target.dataset?.d;
      if (!d) return;
      const days = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      const months = { PageUp: -1, PageDown: 1 }[e.key];
      if (!days && !months) return;
      e.preventDefault();
      const next = days ? addDays(d, days) : `${shiftMonth(d.slice(0, 7), months)}-${d.slice(8) > "28" ? "28" : d.slice(8)}`;
      if (!allowed(next)) return;
      focus = next;
      if (next.slice(0, 7) !== month) { month = next.slice(0, 7); draw(); }
      else $$("[data-d]", body).forEach((x) => (x.tabIndex = x.dataset.d === focus ? 0 : -1));
      $(`[data-d="${next}"]`, body)?.focus();
    });

    draw();
    $('.cal-day[tabindex="0"]', body)?.focus({ preventScroll: true });
  });
}

// A date control for forms: holds the date in a hidden input that fires "change" when a new one is picked.
export const dateField = ({ name = "", id = "", value, max = "", label = "Date", compact = false }) => `<div class="date-field">
    <input type="hidden"${name ? ` name="${esc(name)}"` : ""}${id ? ` id="${esc(id)}"` : ""} value="${esc(value)}" data-max="${esc(max)}">
    <button type="button" class="date-btn${compact ? " compact" : ""}" data-datepick data-label="${esc(label)}" aria-label="${esc(`${label}: ${dateLabel(value)}`)}" aria-haspopup="dialog">${ICON.calendar}<span class="date-text">${esc(dateLabel(value))}</span>${ICON.down}</button>
  </div>`;

export function initDateFields() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-datepick]");
    if (!btn) return;
    const input = btn.previousElementSibling;
    const css = getComputedStyle(btn);
    const accent = css.getPropertyValue("--accent").trim();
    const picked = await pickDate({ value: input.value, max: input.dataset.max, accent: accent ? `--accent:${accent};--on-accent:${css.getPropertyValue("--on-accent").trim()}` : "" });
    btn.focus({ preventScroll: true });
    if (!picked || picked === input.value) return;
    input.value = picked;
    $(".date-text", btn).textContent = dateLabel(picked);
    btn.setAttribute("aria-label", `${btn.dataset.label}: ${dateLabel(picked)}`);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// ---------- constants ----------

export const TYPE = {
  workouts: { name: "Workout", color: "var(--lift)", cls: "t-lifts" },
  cardio: { name: "Cardio", color: "var(--cardio)", cls: "t-cardio" },
  meals: { name: "Meal", color: "var(--diet)", cls: "t-meals" },
  body: { name: "Body", color: "var(--body)", cls: "t-body" },
};
export const MEAL_NAMES = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
export const ICON = {
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  forward: svg('<path d="M9 5l7 7-7 7"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: svg('<path d="M5 12.5l4.2 4.2L19 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', ' class="fill"'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
  timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>'),
  trophy: svg('<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20.5h7M10 17h4l.5 3.5h-5z"/>'),
  camera: svg('<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8.5 6 10 4h4l1.5 2"/>'),
  calendar: svg('<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  swap: svg('<path d="M7 4 4 7l3 3M4 7h13M17 20l3-3-3-3M20 17H7"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  arrowDown: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  trash: svg('<path d="M5 7h14M10 11v6M14 11v6M6.5 7l1 12.5h9L17.5 7M9.5 7V4.5h5V7"/>'),
  repeat: svg('<path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>'),
};

// ---------- charts ----------

export function lineChart(points, { color = "var(--cardio)", goal = null, suffix = "", height = 150 } = {}) {
  if (points.length < 2) return "";
  const W = 340, H = height, pl = 34, pr = 48, pt = 12, pb = 22;
  const xs = points.map((p) => parseYmd(p.x).getTime());
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys, goal ?? Infinity), hi = Math.max(...ys, goal ?? -Infinity);
  const padY = (hi - lo) * 0.12 || 1;
  lo -= padY; hi += padY;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (t) => pl + ((t - x0) / (x1 - x0 || 1)) * (W - pl - pr);
  const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const area = `${d}L${X(xs.at(-1)).toFixed(1)},${H - pb}L${X(xs[0]).toFixed(1)},${H - pb}Z`;
  const ticks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.85];
  const grid = ticks.map((v) => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, hi - lo < 10 ? 1 : 0)}</text>`).join("");
  const dates = `<text class="axis" x="${pl}" y="${H - 4}">${esc(fmtShort(points[0].x))}</text><text class="axis" x="${W - pr}" y="${H - 4}" text-anchor="end">${esc(fmtShort(points.at(-1).x))}</text>`;
  const dots = points.length <= 24 ? points.map((p, i) => `<circle class="dot" r="3.2" cx="${X(xs[i])}" cy="${Y(p.y)}"/>`).join("") : `<circle class="dot" r="4" cx="${X(xs.at(-1))}" cy="${Y(ys.at(-1))}"/>`;
  const goalLine = goal != null ? `<line class="goal" x1="${pl}" x2="${W - pr}" y1="${Y(goal)}" y2="${Y(goal)}"/><text class="axis" x="${W - pr + 6}" y="${Y(goal) + 4}">goal</text>` : "";
  const last = `<text class="last" x="${X(xs.at(-1)) + 8}" y="${Y(ys.at(-1)) + 5}">${fmt(ys.at(-1))}${suffix}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="--c:${color}" role="img" aria-label="Trend chart">${grid}${goalLine}<path class="area" d="${area}"/><path class="line" d="${d}"/>${dots}${last}${dates}</svg>`;
}

// ---------- tiny markdown for AI reviews ----------

export function md(src) {
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "", inList = false;
  for (const raw of esc(src).split(/\r?\n/)) {
    const line = raw.trim();
    const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) html += `<h2>${inline(h[1])}</h2>`;
    else if (line && !/^[-|:\s]+$/.test(line)) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}
