// RepWise — workout logging: exercise library, picker, live workout, rest timer, workout details.
import {
  $, $$, esc, fmt, today, ymd, fmtDay, fmtShort, fmtClock, fmtMinutes, e1rm, toNum, S, unit, api, OfflineError,
  toast, openSheet, closeSheet, choose, confirmSheet, ICON, store, getQ, setQ, dropFailed, newClientId, claimView,
  loadExercises, lineChart, dateField, holdBack, releaseBack,
} from "./core.js";

// ======================================================================
// Exercise library (free-exercise-db, public domain), loaded through our own server
// ======================================================================

export const MUSCLES = {
  chest: "Chest", lats: "Lats", "middle back": "Upper back", "lower back": "Lower back", traps: "Traps",
  shoulders: "Shoulders", biceps: "Biceps", triceps: "Triceps", forearms: "Forearms", abdominals: "Abs",
  quadriceps: "Quads", hamstrings: "Hamstrings", glutes: "Glutes", calves: "Calves",
  adductors: "Adductors", abductors: "Abductors", neck: "Neck",
};
export const EQUIPMENT = {
  barbell: "Barbell", dumbbell: "Dumbbell", machine: "Machine", cable: "Cable", "body only": "Bodyweight",
  kettlebells: "Kettlebell", bands: "Band", "e-z curl bar": "EZ bar", "medicine ball": "Medicine ball",
  "exercise ball": "Exercise ball", "foam roll": "Foam roller", other: "Other",
};
const KIND_NAMES = { weight_reps: "Weight and reps", reps: "Bodyweight reps", time: "Duration" };

// Common gym exercises, shown first and ranked higher in search.
const POPULAR = [
  "Barbell Bench Press - Medium Grip", "Barbell Full Squat", "Barbell Deadlift", "Pullups", "Dumbbell Bench Press",
  "Incline Dumbbell Press", "Wide-Grip Lat Pulldown", "Seated Cable Rows", "Leg Press", "Romanian Deadlift",
  "Standing Military Press", "Dumbbell Shoulder Press", "Bent Over Barbell Row", "One-Arm Dumbbell Row",
  "Barbell Curl", "Dumbbell Bicep Curl", "Hammer Curls", "Triceps Pushdown", "Dips - Triceps Version",
  "Side Lateral Raise", "Face Pull", "Leg Extensions", "Lying Leg Curls", "Barbell Hip Thrust",
  "Standing Calf Raises", "Cable Crossover", "Pushups", "Chin-Up", "Plank", "Hanging Leg Raise", "Crunches",
  "Goblet Squat", "Dumbbell Lunges", "Barbell Incline Bench Press - Medium Grip", "Barbell Shrug",
];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const POP_RANK = new Map(POPULAR.map((n, i) => [norm(n), i]));

const ALIASES = [
  [/\bpull ?ups?\b/, ["pullups", "pull up"]],
  [/\bchin ?ups?\b/, ["chin up"]],
  [/\bpush ?ups?\b/, ["pushups", "push up"]],
  [/\bsit ?ups?\b/, ["sit up"]],
  [/\brdl\b/, ["romanian deadlift"]],
  [/\bohp\b/, ["military press", "shoulder press", "overhead press"]],
  [/\boverhead press\b/, ["military press", "shoulder press", "overhead press"]],
  [/\bdb\b/, ["dumbbell"]],
  [/\bbb\b/, ["barbell"]],
  [/\bkb\b/, ["kettlebell"]],
  [/\bez\b/, ["ez", "e z"]],
  [/\bskull ?crushers?\b/, ["skullcrusher", "lying triceps"]],
  [/\blat pull ?downs?\b/, ["lat pulldown", "pulldown"]],
  [/\bflyes?\b|\bflys?\b/, ["fly", "flye", "butterfly", "crossover"]],
  [/\bbicep\b/, ["bicep", "biceps"]],
  [/\btricep\b/, ["tricep", "triceps"]],
];

function kindOf(x) {
  if (x.category === "stretching" || x.category === "cardio") return "time";
  if (/\b(plank|hold|wall sit|l sit|isometric|dead hang)\b/i.test(norm(x.name))) return "time";
  if (!x.equipment || x.equipment === "body only") return "reps";
  return "weight_reps";
}

function indexEntry(e) {
  e.n = norm(e.name);
  e.words = e.n.split(" ");
  e.compact = e.n.replace(/ /g, "");
  e.pop = POP_RANK.has(e.n) ? POP_RANK.get(e.n) : null;
  return e;
}

function libEntry(x) {
  return indexEntry({
    id: x.id, name: String(x.name || x.id), muscles: x.primaryMuscles || [], secondary: x.secondaryMuscles || [],
    equipment: x.equipment || "body only", category: x.category || "strength", level: x.level || "", mechanic: x.mechanic || "",
    instructions: Array.isArray(x.instructions) ? x.instructions : [], images: Array.isArray(x.images) ? x.images.length : 0,
    kind: kindOf(x), custom: false,
  });
}
function customEntry(c) {
  return indexEntry({
    id: `custom:${c.id}`, cid: c.id, name: c.name, muscles: c.muscle ? [c.muscle] : [], secondary: [],
    equipment: c.equipment || "other", category: "strength", level: "", instructions: [], images: 0, kind: c.kind || "weight_reps", custom: true,
  });
}

let LIB = null;        // { list, byId }
let LIB_ERR = null;
let libPromise = null;
let CUSTOM = null;     // custom entries

export function loadLibrary() {
  if (LIB) return Promise.resolve(LIB);
  if (!libPromise) {
    libPromise = (async () => {
      let res;
      try { res = await fetch("/api/library/data", { credentials: "same-origin" }); }
      catch { throw new OfflineError("You're offline, so the full exercise list can't load. Your recent exercises still work."); }
      if (!res.ok) {
        const msg = (await res.json().catch(() => null))?.error;
        throw new Error(msg || "The exercise list didn't load.");
      }
      const data = await res.json();
      const list = data.map(libEntry);
      LIB = { list, byId: new Map(list.map((e) => [e.id, e])) };
      LIB_ERR = null;
      return LIB;
    })().catch((e) => { LIB_ERR = e; throw e; }).finally(() => (libPromise = null));
  }
  return libPromise;
}
async function loadCustom(force = false) {
  if (!CUSTOM || force) {
    try { CUSTOM = (await api("GET", "/custom-exercises")).map(customEntry); }
    catch { return CUSTOM || []; } // stays unloaded, so the next screen tries again
  }
  return CUSTOM;
}
const allEntries = () => [...(CUSTOM || []), ...(LIB?.list || [])];

export function entryFor(id, name, kind) {
  if (id && LIB?.byId.has(id)) return LIB.byId.get(id);
  if (id && CUSTOM) { const c = CUSTOM.find((e) => e.id === id); if (c) return c; }
  return indexEntry({ id: id || null, name, muscles: [], secondary: [], equipment: "", category: "", instructions: [], images: 0, kind: kind || "weight_reps", custom: !!id && String(id).startsWith("custom:") });
}

function variants(q) {
  let out = [norm(q)];
  for (const [re, subs] of ALIASES) {
    const next = [];
    for (const v of out) {
      if (re.test(v)) subs.forEach((s) => next.push(v.replace(new RegExp(re.source, "g"), s)));
      else next.push(v);
    }
    out = next;
  }
  return [...new Set(out)].slice(0, 8);
}
function scoreOne(e, q) {
  if (!q) return 0;
  const toks = q.split(" ");
  let s = 0;
  if (e.n === q) s = 1000;
  else if (e.n.startsWith(q)) s = 500;
  if (toks.every((t) => e.words.some((w) => w.startsWith(t)))) s = Math.max(s, 300);
  else {
    const c = q.replace(/ /g, "");
    if (c.length >= 3 && e.compact.includes(c)) s = Math.max(s, 150);
  }
  if (s && e.words[0]?.startsWith(toks[0])) s += 30;
  return s;
}
function score(e, vars, recent) {
  let best = 0;
  for (const v of vars) best = Math.max(best, scoreOne(e, v));
  if (!best) return 0;
  if (recent.has(e.id || e.name)) best += 120 - Math.min(60, recent.get(e.id || e.name));
  if (e.pop != null) best += 80 - e.pop;
  if (e.custom) best += 40;
  if (e.category === "stretching") best -= 60;
  return best - e.name.length * 0.3;
}

const muscleLabel = (e) => (e.muscles || []).map((m) => MUSCLES[m] || m).join(", ");
const equipLabel = (e) => EQUIPMENT[e.equipment] || "";
const entryMeta = (e) => [muscleLabel(e), equipLabel(e)].filter(Boolean).join(", ") || KIND_NAMES[e.kind] || "";

const imgUrl = (id, n = 0) => `/api/library/img/${encodeURIComponent(id)}/${n}.jpg`;
const hasLibImage = (id) => id && !String(id).startsWith("custom:");

export function thumb(id, name, cls = "") {
  const letter = esc(String(name || "?").trim().charAt(0).toUpperCase() || "?");
  const img = hasLibImage(id) ? `<img loading="lazy" decoding="async" alt="" src="${imgUrl(id)}" onerror="this.remove()">` : "";
  return `<span class="ex-thumb ${cls}" data-l="${letter}">${img}</span>`;
}

// ======================================================================
// Exercise picker (full screen, searchable, multi-select)
// ======================================================================

export function openPicker({ title = "Add exercises", multi = true, onPick }) {
  const el = document.createElement("div");
  el.className = "overlay picker";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", title);
  el.innerHTML = `
    <header class="pk-head">
      <button type="button" class="link" data-x>Cancel</button>
      <h2>${esc(title)}</h2>
      <button type="button" class="link" data-create>New</button>
    </header>
    <div class="pk-tools">
      <label class="pk-search">${ICON.search}<input type="search" placeholder="Search exercises" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search exercises"><button type="button" class="pk-clear" hidden aria-label="Clear search">${ICON.x}</button></label>
      <div class="pk-filters"><button type="button" class="pill" data-f="muscle"></button><button type="button" class="pill" data-f="equip"></button></div>
    </div>
    <div class="pk-list"><div class="spin">Loading exercises…</div></div>
    <div class="pk-foot" hidden><button type="button" class="btn accent block" data-add></button></div>`;
  document.body.appendChild(el);
  document.body.classList.add("locked");
  holdBack();

  const st = { q: "", muscle: "", equip: "", sel: new Map() };
  const input = $("input", el), listEl = $(".pk-list", el), foot = $(".pk-foot", el);
  let recent = [], recentRank = new Map(), observer = null;

  const close = () => {
    observer?.disconnect();
    el.remove();
    if ($("#sheet").hidden) document.body.classList.remove("locked");
    releaseBack();
  };

  const drawFilters = () => {
    const m = $("[data-f=muscle]", el), q = $("[data-f=equip]", el);
    m.innerHTML = `${esc(st.muscle ? MUSCLES[st.muscle] : "All muscles")}${ICON.down}`;
    q.innerHTML = `${esc(st.equip ? EQUIPMENT[st.equip] : "All equipment")}${ICON.down}`;
    m.classList.toggle("on", !!st.muscle);
    q.classList.toggle("on", !!st.equip);
  };
  const drawFoot = () => {
    const n = st.sel.size;
    foot.hidden = !multi || !n;
    $("[data-add]", foot).textContent = `Add ${n} ${n === 1 ? "exercise" : "exercises"}`;
  };

  const rowHtml = (e) => `<div class="pk-row" data-id="${esc(e.id || e.name)}" aria-selected="${st.sel.has(e.id || e.name)}">
      <button type="button" class="pk-pick">${thumb(e.id, e.name)}<span class="main"><span class="title">${esc(e.name)}</span><span class="meta">${esc(entryMeta(e))}</span></span></button>
      <button type="button" class="pk-info" aria-label="About ${esc(e.name)}">${ICON.info}</button></div>`;

  const sections = () => {
    const pass = (e) => (!st.muscle || e.muscles.includes(st.muscle)) && (!st.equip || e.equipment === st.equip);
    const all = allEntries().filter(pass);
    if (st.q.trim()) {
      const vars = variants(st.q);
      const hits = all.map((e) => [e, score(e, vars, recentRank)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([e]) => e);
      const recentOnly = !LIB ? recent.filter(pass).filter((e) => !hits.includes(e) && vars.some((v) => scoreOne(e, v))) : [];
      const items = [...hits, ...recentOnly];
      return [{ title: items.length ? `${items.length} ${items.length === 1 ? "match" : "matches"}` : "", items }];
    }
    const az = (a, b) => a.name.localeCompare(b.name);
    if (st.muscle || st.equip) {
      const items = [...all].sort((a, b) => (a.pop ?? 999) - (b.pop ?? 999) || az(a, b));
      return [{ title: `${items.length} exercises`, items }];
    }
    const out = [];
    const rec = recent.slice(0, 10);
    if (rec.length) out.push({ title: "Recent", items: rec });
    if (CUSTOM?.length) out.push({ title: "Your exercises", items: CUSTOM });
    const pop = (LIB?.list || []).filter((e) => e.pop != null).sort((a, b) => a.pop - b.pop);
    if (pop.length) out.push({ title: "Popular", items: pop });
    if (LIB) out.push({ title: `All exercises (${LIB.list.length})`, items: [...LIB.list].sort(az) });
    return out;
  };

  const draw = () => {
    observer?.disconnect();
    const secs = sections();
    const flat = [];
    for (const s of secs) {
      if (s.title) flat.push(`<h3 class="pk-sec">${esc(s.title)}</h3>`);
      for (const e of s.items) flat.push(rowHtml(e));
    }
    let html = "";
    if (LIB_ERR && !LIB) html += `<div class="notice pk-notice">${esc(LIB_ERR.message)} <button type="button" class="link" data-retry>Try again</button></div>`;
    const empty = !secs.some((s) => s.items.length);
    if (empty && st.q.trim()) {
      html += `<div class="empty"><strong>No exercises match "${esc(st.q.trim())}"</strong>Try a shorter word, or add it as your own exercise.
        <p><button type="button" class="btn ghost small" data-create>Create "${esc(st.q.trim())}"</button></p></div>`;
    } else if (empty) {
      html += `<div class="empty"><strong>No exercises here</strong>Clear the filters or create your own exercise.</div>`;
    }
    listEl.innerHTML = html;
    let shown = 0;
    const more = () => {
      const chunk = flat.slice(shown, shown + 60);
      shown += chunk.length;
      listEl.insertAdjacentHTML("beforeend", chunk.join(""));
      const sentinel = $(".pk-more", listEl);
      sentinel?.remove();
      if (shown < flat.length) {
        listEl.insertAdjacentHTML("beforeend", `<div class="pk-more"></div>`);
        observer = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) { observer.disconnect(); more(); } }, { root: listEl, rootMargin: "600px" });
        observer.observe($(".pk-more", listEl));
      }
    };
    more();
  };

  const find = (key) => allEntries().find((e) => (e.id || e.name) === key) || recent.find((e) => (e.id || e.name) === key);

  el.addEventListener("click", async (ev) => {
    const t = ev.target;
    if (t.closest("[data-x]")) return close();
    if (t.closest("[data-retry]")) { listEl.innerHTML = `<div class="spin">Loading exercises…</div>`; await loadLibrary().catch(() => {}); return draw(); }
    if (t.closest(".pk-clear")) { input.value = ""; st.q = ""; $(".pk-clear", el).hidden = true; draw(); input.focus(); return; }
    if (t.closest("[data-add]")) { close(); onPick([...st.sel.values()]); return; }
    if (t.closest("[data-create]")) {
      const made = await openCustomForm(st.q.trim());
      if (!made) return;
      if (!multi) { close(); onPick([made]); return; }
      st.sel.set(made.id, made);
      input.value = ""; st.q = ""; $(".pk-clear", el).hidden = true;
      drawFoot(); draw();
      return;
    }
    const f = t.closest("[data-f]");
    if (f) {
      const isM = f.dataset.f === "muscle";
      const source = allEntries();
      const map = isM ? MUSCLES : EQUIPMENT;
      const count = (k) => source.filter((e) => (isM ? e.muscles.includes(k) : e.equipment === k)).length;
      const opts = [{ label: isM ? "All muscles" : "All equipment", value: "", current: !(isM ? st.muscle : st.equip) }]
        .concat(Object.entries(map).map(([k, label]) => ({ label, hint: `${count(k)} exercises`, value: k, current: (isM ? st.muscle : st.equip) === k })).filter((o) => count(o.value) > 0));
      const v = await choose(isM ? "Muscle" : "Equipment", opts);
      if (v === null) return;
      if (isM) st.muscle = v; else st.equip = v;
      drawFilters(); draw(); listEl.scrollTop = 0;
      return;
    }
    const row = t.closest(".pk-row");
    if (!row) return;
    const e = find(row.dataset.id);
    if (!e) return;
    if (t.closest(".pk-info")) return openExerciseDetail(e);
    if (!multi) { close(); onPick([e]); return; }
    const key = e.id || e.name;
    if (st.sel.has(key)) st.sel.delete(key); else st.sel.set(key, e);
    $$(`.pk-row[data-id="${CSS.escape(key)}"]`, el).forEach((r) => r.setAttribute("aria-selected", st.sel.has(key)));
    drawFoot();
  });
  let qTimer;
  input.addEventListener("input", () => {
    $(".pk-clear", el).hidden = !input.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { st.q = input.value; draw(); listEl.scrollTop = 0; }, 90);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

  drawFilters();
  drawFoot();
  Promise.all([loadLibrary().catch(() => null), loadCustom(), loadExercises().catch(() => [])]).then(([, , ex]) => {
    recent = (ex || []).map((r) => entryFor(r.exercise_id, r.exercise, r.kind));
    recentRank = new Map(recent.map((e, i) => [e.id || e.name, i]));
    draw();
  });
}

function openCustomForm(prefill = "") {
  return new Promise((resolve) => {
    let kind = "weight_reps";
    const panel = openSheet(`
      <h2 id="sheetTitle">New exercise</h2>
      <form class="custom-form">
        <label class="field"><span>Name</span><input name="name" value="${esc(prefill)}" maxlength="80" autocapitalize="words" required></label>
        <div class="field"><span>How you log it</span><div class="seg" role="group" aria-label="How you log it">
          ${Object.entries(KIND_NAMES).map(([k, v]) => `<button type="button" data-kind="${k}" aria-pressed="${k === kind}">${k === "weight_reps" ? "Weight" : k === "reps" ? "Bodyweight" : "Time"}</button>`).join("")}</div></div>
        <div class="grid2">
          <label class="field"><span>Main muscle</span><select name="muscle"><option value="">Choose</option>${Object.entries(MUSCLES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label>
          <label class="field"><span>Equipment</span><select name="equipment"><option value="">Choose</option>${Object.entries(EQUIPMENT).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label>
        </div>
        <button type="submit" class="btn accent block t-lifts">Save exercise</button>
      </form>`, () => resolve(null));
    $$("[data-kind]", panel).forEach((b) => b.addEventListener("click", () => {
      kind = b.dataset.kind;
      $$("[data-kind]", panel).forEach((x) => x.setAttribute("aria-pressed", x === b));
    }));
    $("form", panel).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const btn = $("button[type=submit]", panel);
      btn.disabled = true;
      try {
        const row = await api("POST", "/custom-exercises", { name: f.get("name"), kind, muscle: f.get("muscle"), equipment: f.get("equipment") });
        const e = customEntry(row);
        if (CUSTOM) { CUSTOM.push(e); CUSTOM.sort((a, b) => a.name.localeCompare(b.name)); }
        else await loadCustom();
        closeSheet(true);
        toast("Exercise saved");
        resolve(e);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
  });
}

// ======================================================================
// Exercise details (photos, how-to, your history)
// ======================================================================

export async function openExerciseDetail(ref) {
  const id = ref.id ?? ref.exercise_id ?? null;
  const name = ref.name;
  const key = id || name;
  let e = entryFor(id, name, ref.kind);
  const draw = (historyHtml) => {
    const media = e.images >= 2
      ? `<div class="exd-media"><img alt="${esc(e.name)}, start position" src="${imgUrl(e.id, 0)}" onerror="this.parentNode.remove()"><img class="f1" alt="${esc(e.name)}, end position" src="${imgUrl(e.id, 1)}" onerror="this.remove()"></div>`
      : e.images === 1 ? `<div class="exd-media"><img alt="${esc(e.name)}" src="${imgUrl(e.id, 0)}" onerror="this.parentNode.remove()"></div>` : "";
    const tags = [
      ...e.muscles.map((m) => `<span class="tag main">${esc(MUSCLES[m] || m)}</span>`),
      ...e.secondary.map((m) => `<span class="tag">${esc(MUSCLES[m] || m)}</span>`),
      e.equipment && EQUIPMENT[e.equipment] ? `<span class="tag">${esc(EQUIPMENT[e.equipment])}</span>` : "",
      e.level ? `<span class="tag">${esc(e.level[0].toUpperCase() + e.level.slice(1))}</span>` : "",
    ].join("");
    return `<div class="exd">${media}
      <h2 id="sheetTitle">${esc(e.name)}</h2>
      ${tags ? `<div class="tags">${tags}</div>` : ""}
      ${historyHtml}
      ${e.instructions.length ? `<h3 class="exd-h">How to do it</h3><ol class="steps">${e.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
      ${!e.instructions.length && !e.images ? `<p class="muted small">${e.custom ? "Your own exercise." : ""} Logged as ${esc(KIND_NAMES[e.kind] || "weight and reps").toLowerCase()}.</p>` : ""}
    </div>`;
  };
  const panel = openSheet(draw(`<div class="exd-hist muted small">Loading your history…</div>`));
  if (id && !LIB && hasLibImage(id)) { await loadLibrary().catch(() => {}); e = entryFor(id, name, ref.kind); }
  let hist = [];
  try { hist = await api("GET", "/history?key=" + encodeURIComponent(key)); } catch {}
  if (!panel.isConnected || $("#sheet").hidden) return;
  panel.innerHTML = draw(historyHtml(e, hist));
}

// Reps and estimated max aren't on the same scale, so an exercise is measured by whichever most of its sets use.
function setScorer(kind, lifts) {
  if (kind === "time") return (s) => s.t || 0;
  const sets = lifts.flatMap((l) => l.sets).filter((s) => s.type !== "w");
  const weighted = sets.filter((s) => s.w > 0).length;
  return weighted > 0 && weighted * 2 >= sets.length
    ? (s) => (s.w > 0 ? e1rm(s.w, s.r) : null)
    : (s) => (s.w > 0 ? null : s.r || 0);
}

function bestOf(lifts, score) {
  let best = null;
  for (const l of lifts) for (const s of l.sets) {
    if (s.type === "w") continue;
    const v = score(s);
    if (v != null && (!best || v > best.v)) best = { v, s, date: l.date };
  }
  return best;
}

// The best set ever, and one chart point per day.
export function exerciseTrend(kind, hist) {
  const score = setScorer(kind, hist);
  const byDate = new Map();
  for (const l of hist) {
    const b = bestOf([l], score);
    if (b && (!byDate.has(l.date) || b.v > byDate.get(l.date))) byDate.set(l.date, b.v);
  }
  return { best: bestOf(hist, score), pts: [...byDate].map(([x, y]) => ({ x, y: Math.round(y * 10) / 10 })) };
}

export const setText = (kind, s) =>
  kind === "time" ? `${fmtClock(s.t || 0)}` : kind === "reps" && !(s.w > 0) ? `${fmt(s.r, 0)} reps` : `${kind === "reps" ? "+" : ""}${fmt(s.w, 2)} ${unit()} × ${fmt(s.r, 0)}`;

function historyHtml(e, hist) {
  if (!hist.length) return `<div class="exd-hist muted small">You haven't logged this yet.</div>`;
  const kind = hist.at(-1).kind || e.kind;
  const { best, pts } = exerciseTrend(kind, hist);
  const label = kind === "time" ? "Longest hold" : best && best.s.w > 0 ? "Best set" : "Most reps";
  const last = hist.slice(-3).reverse();
  return `<div class="exd-hist card">
      <div class="exd-best"><div><span class="muted small">${label}</span><b>${best ? esc(setText(kind, best.s)) : "–"}</b></div>
      ${best && kind !== "time" && best.s.w > 0 ? `<div><span class="muted small">Est. 1-rep max</span><b>${fmt(best.v)} ${unit()}</b></div>` : ""}
      <div><span class="muted small">Sessions</span><b>${hist.length}</b></div></div>
      ${pts.length >= 2 ? lineChart(pts, { color: "var(--lift)", height: 120 }) : ""}
      <div class="exd-last">${last.map((l) => `<div><span class="muted small">${esc(fmtDay(l.date))}</span> ${l.sets.filter((s) => s.type !== "w").map((s) => esc(setText(kind, s))).join(", ")}</div>`).join("")}</div>
    </div>`;
}

// ======================================================================
// Workout state
// ======================================================================

const WKEY = "gymlog-workout";
const REST_KEY = "gymlog-rest";
const MAX_OVERNIGHT_SEC = 6 * 3600; // longer than this past midnight means it was left running
let LIVE = store.get(WKEY);
let EDIT = null;
let uidN = Date.now();
const uid = () => (++uidN).toString(36);
export const activeWorkout = () => LIVE;

const saveLive = () => { if (LIVE) store.set(WKEY, LIVE); };
let saveTimer;
const saveLiveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveLive, 250); };

const keyOfEx = (ex) => ex.exercise_id || ex.name;
function restFor(key) { const p = store.get(REST_KEY, {}); return key in p ? p[key] : p.__default ?? 90; }
function setRestPref(key, sec) { const p = store.get(REST_KEY, {}); p[key] = sec; store.set(REST_KEY, p); }

const blankSet = (type = "n") => ({ uid: uid(), type, w: "", r: "", t: "", done: false });
const prevFor = (ex) => (S.exercises || []).find((e) => e.key === keyOfEx(ex)) || null;

function exerciseFromEntry(e) {
  const ex = { uid: uid(), exercise_id: e.id || null, name: e.name, kind: e.kind || "weight_reps", notes: "", rest: 0, sets: [] };
  ex.rest = restFor(keyOfEx(ex));
  const prev = prevFor(ex);
  ex.sets = prev?.sets?.length ? prev.sets.map((s) => blankSet(s.type)) : [blankSet(), blankSet(), blankSet()];
  return ex;
}

function timeName(d = new Date()) {
  const h = d.getHours();
  return h < 11 ? "Morning workout" : h < 16 ? "Afternoon workout" : h < 21 ? "Evening workout" : "Night workout";
}

function stateFromWorkout(w, mode) {
  return {
    mode, id: w.id, name: w.name || "Workout", date: mode === "edit" ? w.date : today(), notes: w.notes || "",
    started_at: mode === "edit" ? w.started_at : Date.now(),
    duration_min: w.duration_sec ? Math.round(w.duration_sec / 60) : "",
    restEnd: null, restTotal: 0,
    exercises: w.exercises.map((e) => ({
      uid: uid(), exercise_id: e.exercise_id || null, name: e.exercise || e.name, kind: e.kind || "weight_reps", notes: mode === "edit" ? e.notes || "" : "",
      rest: restFor(e.exercise_id || e.exercise || e.name),
      sets: e.sets.map((s) => ({ uid: uid(), type: s.type || "n", w: s.w ? String(s.w) : "", r: s.r != null ? String(s.r) : "", t: s.t != null ? String(s.t) : "", done: false })),
    })),
  };
}

export function startWorkout({ from = null } = {}) {
  if (LIVE) { location.hash = "#/workout"; return; }
  LIVE = from ? stateFromWorkout(from, "live") : { mode: "live", name: timeName(), date: today(), started_at: Date.now(), notes: "", exercises: [], restEnd: null, restTotal: 0 };
  LIVE.openPicker = !from;
  saveLive();
  location.hash = "#/workout";
}

// Reopen a workout the server rejected, so a bad number can be corrected and saved again.
export function reopenWorkout(payload, failedId) {
  if (LIVE) { toast("Finish or discard your current workout first.", true); return; }
  LIVE = stateFromWorkout(payload, "live");
  Object.assign(LIVE, { date: payload.date, started_at: payload.started_at || Date.now(), clientId: payload.client_id, failedId, keptDuration: payload.duration_sec ?? null });
  LIVE.exercises.forEach((ex, i) => {
    ex.notes = payload.exercises[i].notes || "";
    ex.sets.forEach((s) => (s.done = true));
  });
  saveLive();
  location.hash = "#/workout";
}

export function workoutStats(w, { onlyDone = false } = {}) {
  let sets = 0, volume = 0;
  for (const ex of w.exercises) for (const s of ex.sets) {
    if (onlyDone && !s.done) continue;
    if (s.type === "w") continue;
    sets++;
    if (ex.kind !== "time") volume += (toNum(s.w) || 0) * (toNum(s.r) || 0);
  }
  return { sets, volume: Math.round(volume), exercises: w.exercises.length };
}

export function workoutRow(w) {
  const st = workoutStats(w);
  const first = w.exercises[0];
  const meta = [`${st.exercises} ${st.exercises === 1 ? "exercise" : "exercises"}`, `${st.sets} ${st.sets === 1 ? "set" : "sets"}`];
  if (w.duration_sec >= 60) meta.push(fmtMinutes(w.duration_sec));
  return `<a class="row" href="#/w/${w.id}" style="--c:var(--lift)"><span class="edge"></span>${first ? thumb(first.exercise_id, first.exercise || first.name, "sm") : ""}
    <span class="main"><span class="title">${esc(w.name || "Workout")}</span><span class="meta">${esc(meta.join(", "))}</span></span>
    <span class="val">${st.volume ? `${fmt(st.volume, 0)} ${unit()}` : ""}</span></a>`;
}

// ======================================================================
// Workout editor (live logging and editing a saved workout)
// ======================================================================

const TYPE_INFO = {
  w: { name: "Warm-up", hint: "Not counted in volume or records" },
  n: { name: "Normal", hint: "A regular working set" },
  d: { name: "Drop set", hint: "Lower the weight and keep going right away" },
  f: { name: "Failure", hint: "Taken until you couldn't do another rep" },
};

function prevForSet(prevSets, sets, j) {
  if (!prevSets?.length) return null;
  const type = sets[j].type;
  let k = 0;
  for (let i = 0; i < j; i++) if (sets[i].type === type) k++;
  return prevSets.filter((p) => p.type === type)[k] || null;
}
function prevText(kind, p) {
  if (!p) return "–";
  if (kind === "time") return fmtClock(p.t || 0);
  if (kind === "reps" && !(p.w > 0)) return `${fmt(p.r, 0)} reps`;
  return `${kind === "reps" ? "+" : ""}${fmt(p.w, 2)} × ${fmt(p.r, 0)}`;
}

function setRowHtml(st, ex, j, num, p) {
  const s = ex.sets[j];
  const label = s.type === "n" ? num : s.type.toUpperCase();
  const ph = (f) => (p && p[f] != null && p[f] !== "" ? fmt(p[f], 2) : f === "w" && ex.kind === "reps" ? "0" : "");
  const live = st.mode === "live";
  return `<div class="sg-row${s.done && live ? " done" : ""}" data-set="${s.uid}">
    <button type="button" class="st st-${s.type}" data-act="settype" aria-label="Set ${esc(String(label))}, ${TYPE_INFO[s.type].name}. Change set type">${label}</button>
    <button type="button" class="prev" data-act="copyprev"${p ? "" : " disabled"} aria-label="${p ? "Copy previous: " + esc(prevText(ex.kind, p)) : "No previous set"}">${esc(prevText(ex.kind, p))}</button>
    ${ex.kind !== "time" ? `<input data-f="w" inputmode="decimal" enterkeyhint="next" value="${esc(s.w)}" placeholder="${esc(ph("w"))}" aria-label="${ex.kind === "reps" ? "Added weight" : "Weight"}, set ${esc(String(label))}">` : ""}
    <input data-f="${ex.kind === "time" ? "t" : "r"}" inputmode="numeric" enterkeyhint="done" value="${esc(ex.kind === "time" ? s.t : s.r)}" placeholder="${esc(ph(ex.kind === "time" ? "t" : "r"))}" aria-label="${ex.kind === "time" ? "Seconds" : "Reps"}, set ${esc(String(label))}">
    ${live ? `<button type="button" class="chk" data-act="done" aria-pressed="${s.done}" aria-label="Set ${esc(String(label))} done">${ICON.check}</button>` : ""}
  </div>`;
}

function exHtml(st, ex) {
  const prev = prevFor(ex);
  const cols = ex.kind === "time" ? "time" : "wr";
  const live = st.mode === "live";
  let n = 0;
  const rows = ex.sets.map((s, j) => { if (s.type === "n") n++; return setRowHtml(st, ex, j, n, prevForSet(prev?.sets, ex.sets, j)); }).join("");
  const e = entryFor(ex.exercise_id, ex.name, ex.kind);
  return `<section class="wx" data-ex="${ex.uid}">
    <div class="wx-head">
      <button type="button" class="wx-id" data-act="info">${thumb(ex.exercise_id, ex.name)}<span class="main"><span class="title">${esc(ex.name)}</span><span class="meta">${esc(entryMeta(e))}</span></span></button>
      <button type="button" class="icon-btn flat" data-act="exmenu" aria-label="Options for ${esc(ex.name)}">${ICON.dots}</button>
    </div>
    <div class="wx-sub">
      <input class="wx-note" data-field="notes" value="${esc(ex.notes)}" placeholder="Add a note" aria-label="Note for ${esc(ex.name)}">
      ${live ? `<button type="button" class="wx-rest" data-act="rest">${ICON.timer}${ex.rest ? fmtClock(ex.rest) : "Off"}</button>` : ""}
    </div>
    <div class="sets-grid ${cols}${live ? "" : " nochk"}">
      <div class="sg-head"><span>Set</span><span>Previous</span>${ex.kind !== "time" ? `<span>${ex.kind === "reps" ? "+" + unit() : unit()}</span>` : ""}<span>${ex.kind === "time" ? "Seconds" : "Reps"}</span>${live ? `<span class="sg-chk">${ICON.check}</span>` : ""}</div>
      ${rows}
    </div>
    <button type="button" class="wx-addset" data-act="addset">${ICON.plus}Add set</button>
  </section>`;
}

function editorHtml(st) {
  const live = st.mode === "live";
  return `<div class="wk t-lifts">
    <header class="wk-bar">
      ${live ? `<button type="button" class="icon-btn flat" data-act="minimize" aria-label="Hide workout and keep it running">${ICON.down}</button>`
             : `<button type="button" class="link" data-act="cancel">Cancel</button>`}
      <div class="wk-bar-title">${live ? `<span>Workout</span><b id="wkClock">${fmtClock((Date.now() - st.started_at) / 1000)}</b>` : `<span>Edit workout</span>`}</div>
      <button type="button" class="btn small accent" data-act="finish">${live ? "Finish" : "Save"}</button>
    </header>
    <input class="wk-name" id="wkName" value="${esc(st.name)}" maxlength="80" aria-label="Workout name">
    <div class="wk-meta">
      ${dateField({ id: "wkDate", value: st.date, max: today(), label: "Workout date", compact: true })}
      ${live ? "" : `<label class="wk-chip">${ICON.timer}<input id="wkDur" inputmode="numeric" value="${esc(st.duration_min)}" placeholder="0" aria-label="Duration in minutes"><span>min</span></label>`}
    </div>
    <div class="wk-stats"><div><b id="stVol">0</b><span>Volume, ${unit()}</span></div><div><b id="stSets">0</b><span>${live ? "Sets done" : "Sets"}</span></div><div><b id="stEx">0</b><span>Exercises</span></div></div>
    <div id="wkList">${st.exercises.map((ex) => exHtml(st, ex)).join("")}</div>
    ${st.exercises.length ? "" : `<div class="wk-empty"><b>No exercises yet</b>Add the exercises you're doing today. You can search all ${LIB ? LIB.list.length : "870+"} of them.</div>`}
    <button type="button" class="btn block wk-add" data-act="add">${ICON.plus}Add exercises</button>
    ${live ? `<button type="button" class="btn block danger" data-act="discard">Discard workout</button>` : ""}
  </div>`;
}

let CURRENT = null; // state being shown in the editor

function updateStats(st) {
  const s = workoutStats(st, { onlyDone: st.mode === "live" });
  const v = $("#stVol"), n = $("#stSets"), e = $("#stEx");
  if (v) v.textContent = fmt(s.volume, 0);
  if (n) n.textContent = s.sets;
  if (e) e.textContent = s.exercises;
}

function rerenderEx(st, ex) {
  const sec = $(`[data-ex="${ex.uid}"]`);
  if (sec) sec.outerHTML = exHtml(st, ex);
  updateStats(st);
}
const persist = (st, soon = false) => { if (st.mode === "live") (soon ? saveLiveSoon : saveLive)(); };

function flagRow(row, msg) {
  toast(msg, true);
  row?.classList.remove("shake");
  void row?.offsetWidth;
  row?.classList.add("shake");
}

async function renderEditor(view, st, fresh = claimView()) {
  CURRENT = st;
  await Promise.all([loadExercises().catch(() => []), loadCustom()]);
  if (!fresh()) return;
  loadLibrary().then(() => { if (CURRENT === st) $$(".wx").forEach((sec) => { const ex = st.exercises.find((x) => x.uid === sec.dataset.ex); if (ex) { const m = $(".wx-id .meta", sec); if (m) m.textContent = entryMeta(entryFor(ex.exercise_id, ex.name, ex.kind)); } }); }).catch(() => {});
  view.innerHTML = editorHtml(st);
  updateStats(st);
  const root = $(".wk", view);

  root.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.id === "wkName") { st.name = t.value; return persist(st, true); }
    if (t.id === "wkDur") { st.duration_min = t.value; return; }
    const sec = t.closest("[data-ex]");
    const ex = sec && st.exercises.find((x) => x.uid === sec.dataset.ex);
    if (!ex) return;
    if (t.dataset.field === "notes") { ex.notes = t.value; return persist(st, true); }
    const row = t.closest("[data-set]");
    const s = row && ex.sets.find((x) => x.uid === row.dataset.set);
    if (s && t.dataset.f) { s[t.dataset.f] = t.value.replace(",", "."); updateStats(st); persist(st, true); }
  });
  root.addEventListener("change", (ev) => {
    if (ev.target.id === "wkDate" && ev.target.value) { st.date = ev.target.value; persist(st); }
  });
  // Move to the reps box after the weight box when "next" is tapped.
  root.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || !ev.target.dataset.f) return;
    ev.preventDefault();
    const inputs = $$("input[data-f]", root);
    const i = inputs.indexOf(ev.target);
    if (inputs[i + 1]) inputs[i + 1].focus(); else ev.target.blur();
  });

  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const sec = b.closest("[data-ex]");
    const ex = sec && st.exercises.find((x) => x.uid === sec.dataset.ex);
    const row = b.closest("[data-set]");
    const j = ex && row ? ex.sets.findIndex((x) => x.uid === row.dataset.set) : -1;
    const s = j >= 0 ? ex.sets[j] : null;

    switch (act) {
      case "minimize": location.hash = "#/"; return;
      case "cancel": EDIT = null; history.length > 1 ? history.back() : (location.hash = `#/w/${st.id}`); return;
      case "finish": return finish(st);
      case "discard":
        if (await confirmSheet("Discard this workout?", "Discard workout", { subtitle: "Nothing from it will be saved.", noLabel: "Keep logging" })) {
          LIVE = null; store.del(WKEY); stopRest(); toast("Workout discarded"); location.hash = "#/";
        }
        return;
      case "add":
        openPicker({ title: "Add exercises", onPick: (entries) => {
          const added = entries.map(exerciseFromEntry);
          st.exercises.push(...added);
          persist(st);
          renderEditor(view, st).then(() => $(`[data-ex="${added[0]?.uid}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
        } });
        return;
      case "info": return openExerciseDetail({ id: ex.exercise_id, name: ex.name, kind: ex.kind });
      case "exmenu": {
        const i = st.exercises.indexOf(ex);
        const v = await choose(ex.name, [
          { label: "How to do it", icon: ICON.info, value: "info" },
          { label: "Replace exercise", icon: ICON.swap, value: "replace" },
          ...(i > 0 ? [{ label: "Move up", icon: ICON.up, value: "up" }] : []),
          ...(i < st.exercises.length - 1 ? [{ label: "Move down", icon: ICON.arrowDown, value: "down" }] : []),
          { label: "Remove exercise", icon: ICON.trash, value: "remove", danger: true },
        ]);
        if (v === "info") openExerciseDetail({ id: ex.exercise_id, name: ex.name, kind: ex.kind });
        if (v === "replace") openPicker({ title: "Replace exercise", multi: false, onPick: ([e]) => {
          const fresh = exerciseFromEntry(e);
          if (fresh.kind === ex.kind) fresh.sets = ex.sets.map((x) => ({ ...x, uid: uid() }));
          st.exercises[st.exercises.indexOf(ex)] = fresh;
          persist(st); renderEditor(view, st);
        } });
        if (v === "up" || v === "down") {
          st.exercises.splice(i, 1);
          st.exercises.splice(v === "up" ? i - 1 : i + 1, 0, ex);
          persist(st); renderEditor(view, st);
        }
        if (v === "remove") {
          const hasData = ex.sets.some((x) => x.done || x.r || x.t);
          if (!hasData || (await confirmSheet(`Remove ${ex.name}?`, "Remove exercise", { subtitle: "Its sets will be deleted from this workout." }))) {
            st.exercises.splice(st.exercises.indexOf(ex), 1);
            persist(st); renderEditor(view, st);
          }
        }
        return;
      }
      case "rest": {
        const opts = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300].map((sec) => ({ label: sec ? fmtClock(sec) : "Off", value: sec, current: ex.rest === sec }));
        const v = await choose(`Rest timer for ${ex.name}`, opts, { subtitle: "Starts when you check off a set." });
        if (v === null) return;
        ex.rest = v;
        setRestPref(keyOfEx(ex), v);
        persist(st); rerenderEx(st, ex);
        return;
      }
      case "addset": {
        const last = ex.sets.at(-1);
        const ns = blankSet("n");
        if (last) { ns.w = last.w; ns.r = last.r; ns.t = last.t; }
        ex.sets.push(ns);
        persist(st); rerenderEx(st, ex);
        $(`[data-set="${ns.uid}"] input`)?.focus();
        return;
      }
      case "copyprev": {
        const p = prevForSet(prevFor(ex)?.sets, ex.sets, j);
        if (!p) return;
        if (ex.kind === "time") s.t = String(p.t ?? ""); else { s.w = p.w ? String(p.w) : ""; s.r = String(p.r ?? ""); }
        persist(st); rerenderEx(st, ex);
        return;
      }
      case "settype": {
        const v = await choose("Set type", [
          ...Object.entries(TYPE_INFO).map(([k, info]) => ({ label: info.name, hint: info.hint, value: k, current: s.type === k, icon: `<span class="st st-${k}">${k === "n" ? "1" : k.toUpperCase()}</span>` })),
          { label: "Remove set", value: "remove", danger: true, icon: ICON.trash },
        ]);
        if (v === null) return;
        if (v === "remove") { ex.sets.splice(j, 1); if (!ex.sets.length) ex.sets.push(blankSet()); }
        else s.type = v;
        persist(st); rerenderEx(st, ex);
        return;
      }
      case "done": {
        unlockAudio();
        if (!s.done) {
          const p = prevForSet(prevFor(ex)?.sets, ex.sets, j);
          if (ex.kind === "time") {
            if (s.t === "" && p?.t) s.t = String(p.t);
            if (!(toNum(s.t) > 0)) return flagRow(row, "Enter the time in seconds first.");
          } else {
            if (s.r === "" && p?.r) s.r = String(p.r);
            if (s.w === "" && p?.w > 0) s.w = String(p.w);
            if (!(toNum(s.r) > 0)) return flagRow(row, "Enter your reps first.");
            if (s.w !== "" && Number.isNaN(toNum(s.w))) return flagRow(row, "That weight isn't a number.");
          }
          s.done = true;
          if (ex.rest) startRest(ex.rest);
        } else s.done = false;
        persist(st); rerenderEx(st, ex);
        return;
      }
    }
  });

  if (st.mode === "live" && st.openPicker) {
    st.openPicker = false;
    persist(st);
    $("[data-act=add]", root).click();
  }
  updateRestBar();
}

async function finish(st) {
  const live = st.mode === "live";
  const hasMain = (ex, s) => (ex.kind === "time" ? toNum(s.t) > 0 : toNum(s.r) > 0);
  if (live) {
    const pending = [];
    let done = 0;
    for (const ex of st.exercises) for (const s of ex.sets) { if (s.done) done++; else if (hasMain(ex, s)) pending.push(s); }
    if (!done && !pending.length) return toast("Check off at least one set before finishing.", true);
    if (pending.length) {
      const c = await choose(`${pending.length} ${pending.length === 1 ? "set isn't" : "sets aren't"} checked off`, [
        { label: "Count them and finish", hint: "They're saved as done", value: "mark" },
        { label: "Leave them out and finish", value: "drop" },
        { label: "Keep logging", value: null },
      ]);
      if (!c) return;
      if (c === "mark") pending.forEach((s) => (s.done = true));
    }
  } else {
    for (const ex of st.exercises) {
      if (ex.sets.some((s) => !hasMain(ex, s) && (s.w !== "" || s.r !== "" || s.t !== "")))
        return toast(`Add ${ex.kind === "time" ? "a time" : "reps"} to every set of ${ex.name}, or remove the empty set.`, true);
    }
  }
  const val = (v) => { const n = toNum(v); return Number.isNaN(n) ? null : n; };
  if (live && !st.clientId) { st.clientId = newClientId(); persist(st); }
  const elapsed = live ? Math.round((Date.now() - st.started_at) / 1000) : 0;
  const payload = {
    client_id: st.clientId,
    date: st.date, name: (st.name || "").trim() || timeName(), notes: st.notes || "",
    started_at: st.started_at || null,
    duration_sec: live ? elapsed : st.duration_min !== "" ? Math.round(toNum(st.duration_min) * 60) || null : null,
    exercises: st.exercises
      .map((ex) => ({
        exercise_id: ex.exercise_id, name: ex.name, kind: ex.kind, notes: ex.notes,
        sets: ex.sets.filter((s) => (live ? s.done : hasMain(ex, s))).map((s) => ({ type: s.type, w: val(s.w) ?? 0, r: val(s.r), t: val(s.t) })),
      }))
      .filter((ex) => ex.sets.length),
  };
  if (!payload.exercises.length) return toast("There are no sets to save.", true);
  if (live) {
    // The clock only counts if the workout wasn't backdated or left running overnight.
    const startedOn = ymd(new Date(st.started_at));
    if (st.keptDuration !== undefined) payload.duration_sec = st.keptDuration;
    else if (payload.date !== startedOn || (startedOn !== today() && elapsed > MAX_OVERNIGHT_SEC)) payload.duration_sec = null;
  }

  const clearLive = () => { LIVE = null; store.del(WKEY); stopRest(); if (st.failedId) dropFailed(st.failedId); };
  const btn = $("[data-act=finish]");
  if (btn) btn.disabled = true;
  try {
    const res = live ? await api("POST", "/workouts", payload) : await api("PUT", `/workouts/${st.id}`, payload);
    try { sessionStorage.setItem("gymlog-saved", JSON.stringify({ id: res.workout.id, prs: res.prs, fresh: live })); } catch {}
    if (live) clearLive(); else EDIT = null;
    S.exercises = null;
    location.hash = `#/w/${res.workout.id}`;
  } catch (err) {
    if (err instanceof OfflineError && live) {
      const q = getQ();
      q.push({ path: "/workouts", data: payload });
      if (setQ(q)) {
        clearLive();
        toast("Saved on this phone. It uploads when you're back online.");
        location.hash = "#/";
        return;
      }
    }
    toast(err.message, true);
    if (btn) btn.disabled = false;
  }
}

export async function renderLiveWorkout(view) {
  if (!LIVE) { location.replace("#/"); return; }
  await renderEditor(view, LIVE);
}

export async function renderWorkoutEdit(view, id) {
  const fresh = claimView();
  if (!EDIT || EDIT.id !== id) {
    view.innerHTML = `<div class="spin">Loading…</div>`;
    const w = await api("GET", `/workouts/${id}`);
    if (!fresh()) return;
    EDIT = stateFromWorkout(w, "edit");
  }
  await renderEditor(view, EDIT, fresh);
}

// ======================================================================
// Rest timer and the "workout in progress" bar
// ======================================================================

let actx = null;
function unlockAudio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
  } catch {}
}
function beep() {
  try { navigator.vibrate?.([120, 80, 120]); } catch {}
  if (!actx) return;
  try {
    const t = actx.currentTime;
    for (const off of [0, 0.25]) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.3, t + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.18);
      o.connect(g).connect(actx.destination);
      o.start(t + off);
      o.stop(t + off + 0.2);
    }
  } catch {}
}
function startRest(sec) {
  if (!LIVE) return;
  LIVE.restEnd = Date.now() + sec * 1000;
  LIVE.restTotal = sec;
  saveLive();
  updateRestBar();
}
function stopRest() {
  if (LIVE) { LIVE.restEnd = null; saveLive(); }
  updateRestBar();
}

let routeKind = "other";
export function setRouteKind(k) { routeKind = k; updateWorkoutBar(); updateRestBar(); }

function updateRestBar() {
  const bar = $("#restbar");
  const on = !!(LIVE?.restEnd && LIVE.restEnd > Date.now() && routeKind === "workout");
  bar.hidden = !on;
  document.body.classList.toggle("resting", on);
  if (!on) return;
  const left = (LIVE.restEnd - Date.now()) / 1000;
  $(".rb-time", bar).textContent = fmtClock(Math.ceil(left));
  $(".rb-fill", bar).style.transform = `scaleX(${Math.max(0, Math.min(1, left / (LIVE.restTotal || 1)))})`;
}
export function updateWorkoutBar() {
  const bar = $("#wkbar");
  const on = !!LIVE && routeKind === "tab";
  bar.hidden = !on;
  document.body.classList.toggle("has-wkbar", on);
  if (!on) return;
  const resting = LIVE.restEnd && LIVE.restEnd > Date.now();
  $("#wkbarTime").textContent = resting ? `Rest ${fmtClock(Math.ceil((LIVE.restEnd - Date.now()) / 1000))}` : fmtClock((Date.now() - LIVE.started_at) / 1000);
}

function initBars() {
  $("#restbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rb]");
    if (!b || !LIVE?.restEnd) return;
    const v = b.dataset.rb;
    if (v === "skip") return stopRest();
    LIVE.restEnd += Number(v) * 1000;
    LIVE.restTotal = Math.max(LIVE.restTotal + Number(v), 1);
    if (LIVE.restEnd <= Date.now()) return stopRest();
    saveLive();
    updateRestBar();
  });
  setInterval(() => {
    if (!LIVE) return;
    const clock = $("#wkClock");
    if (clock && CURRENT === LIVE) clock.textContent = fmtClock((Date.now() - LIVE.started_at) / 1000);
    if (LIVE.restEnd && LIVE.restEnd <= Date.now()) {
      LIVE.restEnd = null;
      saveLive();
      beep();
      toast("Rest is over. Time for your next set.");
    }
    updateRestBar();
    updateWorkoutBar();
  }, 1000);
}
initBars();

// ======================================================================
// Saved workout details
// ======================================================================

export async function renderWorkoutDetail(view, id) {
  const fresh = claimView();
  view.innerHTML = `<div class="spin">Loading…</div>`;
  const w = await api("GET", `/workouts/${id}`);
  if (!fresh()) return;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem("gymlog-saved")); } catch {}
  if (saved?.id !== id) saved = null;
  else try { sessionStorage.removeItem("gymlog-saved"); } catch {}
  loadLibrary().catch(() => {});

  const st = workoutStats(w);
  const prs = saved?.prs || [];
  const prValue = (p) => (p.unit === "weight" ? `${fmt(p.value)} ${unit()}` : p.unit === "sec" ? fmtClock(p.value) : `${fmt(p.value, 0)} reps`);
  const exHtmlRO = (e) => {
    let n = 0;
    const lines = e.sets.map((s) => {
      if (s.type === "n") n++;
      const label = s.type === "n" ? n : s.type.toUpperCase();
      const est = e.kind !== "time" && s.w > 0 && s.type !== "w" ? `<span class="muted">${fmt(e1rm(s.w, s.r), 0)} est. max</span>` : "<span></span>";
      return `<div class="wd-set"><span class="st st-${s.type}">${label}</span><span>${esc(setText(e.kind, s))}</span>${est}</div>`;
    }).join("");
    return `<section class="card wd-ex">
      <button type="button" class="wx-id" data-info="${esc(e.exercise_id || "")}" data-name="${esc(e.exercise)}" data-kind="${esc(e.kind)}">${thumb(e.exercise_id, e.exercise)}<span class="main"><span class="title">${esc(e.exercise)}</span><span class="meta">${(() => { const n = e.sets.filter((s) => s.type !== "w").length; return `${n} working ${n === 1 ? "set" : "sets"}`; })()}</span></span></button>
      ${e.notes ? `<p class="wd-note">${esc(e.notes)}</p>` : ""}
      <div class="wd-sets">${lines}</div></section>`;
  };

  view.innerHTML = `
    <button type="button" class="back" data-go="${esc(S.returnTo || "#/history")}">${ICON.back}Back</button>
    ${saved?.fresh ? `<div class="done-hero"><span class="done-disc">${ICON.check}</span><div><b>Workout saved</b><span>${prs.length ? `You set ${prs.length} new ${prs.length === 1 ? "record" : "records"}.` : "Nice work. It's in your log."}</span></div></div>` : ""}
    <header class="head"><div><h1>${esc(w.name || "Workout")}</h1><div class="sub">${esc(fmtDay(w.date, true))}${w.duration_sec >= 60 ? `, ${fmtMinutes(w.duration_sec)}` : ""}</div></div></header>
    <div class="wk-stats"><div><b>${fmt(st.volume, 0)}</b><span>Volume, ${unit()}</span></div><div><b>${st.sets}</b><span>Working sets</span></div><div><b>${st.exercises}</b><span>Exercises</span></div></div>
    ${prs.length ? `<h2 class="section">New records</h2><div class="list prs">${prs.map((p) => `<div class="row"><span class="pr-icon">${ICON.trophy}</span><span class="main"><span class="title">${esc(p.exercise)}</span><span class="meta">${esc(p.label)}</span></span><span class="val">${esc(prValue(p))}</span></div>`).join("")}</div>` : ""}
    <h2 class="section">Exercises</h2>
    <div class="wd-list">${w.exercises.map(exHtmlRO).join("")}</div>
    <div class="wd-actions">
      <button type="button" class="btn ghost" data-wd="edit">${ICON.edit}Edit</button>
      <button type="button" class="btn ghost" data-wd="repeat">${ICON.repeat}Repeat</button>
    </div>
    <button type="button" class="btn danger block" data-wd="delete">Delete workout</button>`;

  view.querySelectorAll("[data-info]").forEach((b) => b.addEventListener("click", () => openExerciseDetail({ id: b.dataset.info || null, name: b.dataset.name, kind: b.dataset.kind })));
  view.querySelector("[data-wd=edit]").addEventListener("click", () => { EDIT = stateFromWorkout(w, "edit"); location.hash = `#/w/${id}/edit`; });
  view.querySelector("[data-wd=repeat]").addEventListener("click", () => {
    if (LIVE) { toast("Finish or discard your current workout first.", true); return; }
    startWorkout({ from: w });
  });
  view.querySelector("[data-wd=delete]").addEventListener("click", async () => {
    if (!(await confirmSheet("Delete this workout?", "Delete workout", { subtitle: "This can't be undone." }))) return;
    try { await api("DELETE", `/workouts/${id}`); S.exercises = null; toast("Workout deleted"); location.hash = "#/history"; }
    catch (e) { toast(e.message, true); }
  });
}
