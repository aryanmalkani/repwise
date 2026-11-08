// RepWise — screens and navigation. No build step, no libraries.
import {
  $, $$, esc, fmt, today, parseYmd, addDays, mondayOf, fmtDay, fmtShort, fmtClock, S, unit, store,
  api, OfflineError, ApiError, setUnauthorizedHandler, loadExercises, getQ, setQ, getFailed, setFailed, dropFailed,
  newClientId, claimView, currentView, toast, openSheet, closeSheet, initSheet, initDateFields, dateField, holdBack, releaseBack,
  choose, confirmSheet, TYPE, MEAL_NAMES, ICON, lineChart, md,
} from "./core.js";
import {
  startWorkout, reopenWorkout, activeWorkout, renderLiveWorkout, renderWorkoutDetail, renderWorkoutEdit, setRouteKind,
  workoutRow, workoutStats, thumb, openExerciseDetail, setText, exerciseTrend,
} from "./workout.js";

const view = $("#view");
const tabbar = $("#tabbar");
const CARDIO_PRESETS = ["Run", "Walk", "Cycle", "Incline walk", "Rower", "Stairs", "Swim", "Elliptical", "HIIT", "Sport"];

initSheet();
initDateFields();
setUnauthorizedHandler(() => {
  S.me = null;
  store.del("gymlog-me");
  showLogin();
});

// ---------- offline queue ----------

async function blobToDataUrl(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
async function dataUrlToBlob(url) { return (await fetch(url)).blob(); }

// Offline, logged out or server trouble: nothing is wrong with the entry, so it stays queued for later.
const worthRetrying = (e) => e instanceof OfflineError || (e instanceof ApiError && (e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500));
const entries = (n) => `${n} saved ${n === 1 ? "entry" : "entries"}`;

// Screens that only display data can be redrawn at any time. Never redraw one the user may be typing in.
const canRedraw = () => /^(#\/?)?(history(\/progress)?|photos|coach)?$/.test(location.hash) && $("#sheet").hidden && !$(".overlay");

// New entries can be added while this runs, so each step re-reads the queue instead of saving an old copy over it.
let flushing = false;
async function flushQueue() {
  if (flushing || !S.me || !getQ().length) return;
  flushing = true;
  let sent = 0, rejected = 0;
  try {
    for (let item; (item = getQ()[0]); ) {
      try {
        if (item.photo) {
          const blob = await dataUrlToBlob(item.photo.dataUrl);
          const { key } = await api("POST", `/photos?kind=${item.photo.kind}&date=${item.data.date}`, blob);
          item.data.photo_key = key;
          item.photo = null;
          const q = getQ();
          q[0] = item;
          setQ(q);
        }
        await api("POST", item.path || `/entries/${item.type}`, item.data);
        sent++;
      } catch (e) {
        if (worthRetrying(e) || !setFailed([...getFailed(), { ...item, id: newClientId(), error: e.message }])) break;
        rejected++;
      }
      const q = getQ();
      q.shift();
      setQ(q);
    }
  } finally {
    flushing = false;
    if (rejected) toast(`${entries(rejected)} couldn't upload. Open Today to fix ${rejected === 1 ? "it" : "them"}.`, true);
    else if (sent) toast(`Uploaded ${entries(sent)}.`);
    if (sent || rejected) {
      S.exercises = null;
      if (canRedraw()) route();
    }
  }
}
window.addEventListener("online", flushQueue);
document.addEventListener("visibilitychange", () => { if (!document.hidden) flushQueue(); });
setInterval(flushQueue, 60000); // a weak signal may never fire the "online" event

// ---------- uploads the server rejected ----------

const queuedType = (item) => (item.path ? item.path.split("/").pop() : item.type);
const queuedLabel = (item) => `${item.data.name || item.data.activity || item.data.description || TYPE[queuedType(item)].name}, ${fmtShort(item.data.date)}`;

function fixFailed(item) {
  const type = queuedType(item);
  if (type === "workouts") return reopenWorkout(item.data, item.id);
  S.draft = { ...item, type };
  location.hash = `#/log/${type}`;
}

async function openFailed() {
  const list = getFailed();
  const id = list.length === 1
    ? list[0].id
    : await choose("Couldn't upload", list.map((f) => ({ label: queuedLabel(f), hint: f.error, value: f.id })), { subtitle: "The server rejected these. Tap one to fix or discard it." });
  const item = list.find((f) => f.id === id);
  if (!item) return;
  const action = await choose(queuedLabel(item), [
    { label: "Fix it", value: "fix" },
    { label: "Discard it", value: "discard", danger: true },
  ], { subtitle: item.error });
  if (action === "fix") fixFailed(item);
  if (action === "discard") { dropFailed(item.id); toast("Discarded"); route(); }
}

// ---------- the + menu ----------

$("#logBtn").addEventListener("click", () => {
  const live = activeWorkout();
  const panel = openSheet(`
    <h2 id="sheetTitle">Log</h2>
    <div class="choices">
      <button type="button" class="choice t-lifts" data-start><b>${live ? "Resume workout" : "Workout"}</b><span>${live ? "Your workout is still running" : "Exercises, sets and reps"}</span></button>
      <a class="choice t-cardio" href="#/log/cardio"><b>Cardio</b><span>Runs, rides, walks</span></a>
      <a class="choice t-meals" href="#/log/meals"><b>Diet</b><span>Food photos, calories, protein</span></a>
      <a class="choice t-body" href="#/log/body"><b>Body</b><span>Weight and progress photo</span></a>
    </div>`);
  $("[data-start]", panel).addEventListener("click", () => { closeSheet(true); startWorkout(); });
});

// ---------- rows ----------

function remember(type, e) { S.byId[`${type}:${e.id}`] = e; }

function rowHtml(type, e) {
  if (type === "workouts") return workoutRow(e);
  remember(type, e);
  let title = "", meta = [], val = "", img = "";
  if (type === "cardio") {
    title = e.activity;
    if (e.distance_km != null) meta.push(`${fmt(e.distance_km, 2)} km`);
    if (e.avg_hr != null) meta.push(`${fmt(e.avg_hr, 0)} bpm`);
    if (e.calories != null) meta.push(`${fmt(e.calories, 0)} kcal`);
    val = e.minutes != null ? `${fmt(e.minutes, 0)} min` : `${fmt(e.distance_km, 2)} km`;
  } else if (type === "meals") {
    title = e.description || MEAL_NAMES[e.meal];
    meta.push(MEAL_NAMES[e.meal]);
    if (e.protein_g != null) meta.push(`${fmt(e.protein_g, 0)} g protein`);
    val = e.calories != null ? `${fmt(e.calories, 0)} kcal` : "";
  } else {
    title = e.weight != null ? "Weigh-in" : e.photo_key ? "Progress photo" : "Measurements";
    if (e.body_fat != null) meta.push(`${fmt(e.body_fat)}% body fat`);
    if (e.waist_cm != null) meta.push(`${fmt(e.waist_cm)} cm waist`);
    if (e.weight != null && e.photo_key) meta.push("photo");
    val = e.weight != null ? `${fmt(e.weight)} ${unit()}` : "";
  }
  if (e.notes && !meta.length) meta.push(e.notes);
  if (e.photo_key) img = `<img class="thumb" loading="lazy" alt="" src="/api/photos/${encodeURIComponent(e.photo_key)}">`;
  return `<a class="row" href="#/edit/${type}/${e.id}" style="--c:${TYPE[type].color}">
    <span class="edge"></span>${img}
    <span class="main"><span class="title">${esc(title)}</span><span class="meta">${esc(meta.join(", "))}</span></span>
    <span class="val">${esc(val)}</span></a>`;
}

function flatten(data, filter = "all") {
  const out = [];
  for (const type of Object.keys(TYPE)) {
    if (filter !== "all" && filter !== type) continue;
    for (const e of data[type] || []) out.push({ type, e });
  }
  const order = { workouts: 0, cardio: 1, meals: 2, body: 3 };
  out.sort((a, b) => b.e.date.localeCompare(a.e.date) || order[a.type] - order[b.type] || b.e.id - a.e.id);
  return out;
}

function groupedList(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.e.date)) groups.set(it.e.date, []);
    groups.get(it.e.date).push(it);
  }
  return [...groups].map(([date, list]) => `
    <section class="daygroup"><h3>${esc(fmtDay(date, true))}</h3>
      <div class="list">${list.map((it) => rowHtml(it.type, it.e)).join("")}</div>
    </section>`).join("");
}

// ---------- screens ----------

function head(title, sub = "", actions = "") {
  return `<header class="head"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>${actions ? `<div class="head-actions">${actions}</div>` : ""}</header>`;
}
const loading = () => `<div class="spin">Loading…</div>`;

async function renderToday() {
  const fresh = claimView();
  const t = today();
  const start = mondayOf(t), end = addDays(start, 6);
  const longDate = parseYmd(t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const top = head("This week", longDate, `<a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>`);
  view.innerHTML = top + loading();

  const [week, bodyHist, reviews] = await Promise.all([
    api("GET", `/range?from=${start}&to=${end}`),
    api("GET", "/body-history"),
    S.me.ai ? api("GET", "/reviews").catch(() => []) : Promise.resolve([]),
  ]);
  if (!fresh()) return;

  // the week bar
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const has = (type, d) => (week[type] || []).some((e) => e.date === d);
  const plates = (d) => {
    const p = ["workouts", "cardio", "meals", "body"].filter((tp) => has(tp, d)).map((tp, i) => `<i class="plate ${tp}" style="animation-delay:${i * 60}ms"></i>`);
    return p.length ? p.join("") : `<i class="plate none"></i>`;
  };
  const weekHtml = `<div class="week animate" aria-label="What you logged each day this week">${days.map((d) => {
    const cls = d === t ? "today" : d > t ? "future" : "";
    const letters = parseYmd(d).toLocaleDateString(undefined, { weekday: "short" });
    return `<div class="day ${cls}"><div class="plates">${plates(d)}</div><span class="dow">${esc(letters)}</span><span class="dnum">${parseYmd(d).getDate()}</span></div>`;
  }).join("")}</div>
  <div class="legend"><span style="--c:var(--lift)">Lifting</span><span style="--c:var(--cardio)">Cardio</span><span style="--c:var(--diet)">Diet</span><span style="--c:var(--body)">Body</span></div>`;

  // stats
  const trainDays = new Set([...week.workouts.map((l) => l.date), ...week.cardio.map((c) => c.date)]).size;
  let sets = 0, volume = 0;
  for (const w of week.workouts) { const s = workoutStats(w); sets += s.sets; volume += s.volume; }
  const cardioMin = week.cardio.reduce((m, c) => m + (c.minutes || 0), 0);
  const cardioKm = week.cardio.reduce((m, c) => m + (c.distance_km || 0), 0);
  const dietDays = {};
  for (const m of week.meals) {
    const d = (dietDays[m.date] ||= { p: 0, n: 0 });
    if (m.protein_g != null) { d.p += m.protein_g; d.n++; }
  }
  const pDays = Object.values(dietDays).filter((d) => d.n);
  const avgP = pDays.length ? pDays.reduce((a, d) => a + d.p, 0) / pDays.length : null;
  const pTarget = Number(S.settings.protein_target) || null;
  const stats = `<div class="stats">
    <div class="stat" style="--c:var(--lift)"><div class="v">${trainDays}<small>/7</small></div><div class="k">Training days</div></div>
    <div class="stat" style="--c:var(--lift)"><div class="v">${sets}</div><div class="k">${volume ? `Working sets, ${fmt(volume / 1000, 1)}k ${unit()} lifted` : "Working sets"}</div></div>
    <div class="stat" style="--c:var(--cardio)"><div class="v">${fmt(cardioMin, 0)}<small>min</small></div><div class="k">Cardio${cardioKm ? `, ${fmt(cardioKm, 1)} km` : ""}</div></div>
    <div class="stat" style="--c:var(--diet)"><div class="v">${avgP != null ? fmt(avgP, 0) : "–"}<small>g</small></div><div class="k">Avg protein a day${pTarget ? ` of ${pTarget}` : ""}</div>
      ${pTarget && avgP != null ? `<div class="bar"><i style="width:${Math.min(100, (avgP / pTarget) * 100)}%"></i></div>` : ""}</div>
  </div>`;

  const startCard = activeWorkout() ? "" : `<button type="button" class="start-card" id="startWk">
      <span class="start-plus">${ICON.plus}</span><span class="main"><b>Start a workout</b><span>Pick exercises, log sets as you go</span></span></button>`;

  // body weight
  const weights = bodyHist.filter((b) => b.weight != null).map((b) => ({ x: b.date, y: b.weight }));
  const recentW = weights.filter((p) => p.x >= addDays(t, -90));
  let weightHtml = "";
  if (weights.length) {
    const last = weights.at(-1);
    const ref = [...weights].reverse().find((p) => p.x <= addDays(last.x, -28));
    const delta = ref ? last.y - ref.y : null;
    const goal = Number(S.settings.bodyweight_goal) || null;
    weightHtml = `<h2 class="section">Body weight <a href="#/history/progress">Trends</a></h2>
      <div class="card">
        <div class="bignum">${fmt(last.y)}<small> ${unit()}</small></div>
        <div class="muted small">${esc(fmtDay(last.x))}${delta != null ? `, ${delta > 0 ? "+" : ""}${fmt(delta)} ${unit()} in 4 weeks` : ""}</div>
        ${lineChart(recentW.length >= 2 ? recentW : weights.slice(-30), { color: "var(--body)", goal })}
      </div>`;
  }

  // today's log
  const todays = flatten({ workouts: week.workouts.filter((e) => e.date === t), cardio: week.cardio.filter((e) => e.date === t), meals: week.meals.filter((e) => e.date === t), body: week.body.filter((e) => e.date === t) });
  const todayHtml = `<h2 class="section">Logged today</h2>` + (todays.length
    ? `<div class="list">${todays.map((it) => rowHtml(it.type, it.e)).join("")}</div>`
    : `<div class="list"><div class="empty"><strong>Nothing yet today</strong>Tap + to log a workout, a run, a meal or a weigh-in.</div></div>`);

  let reviewHtml = "";
  if (reviews.length) {
    const r = reviews[0];
    reviewHtml = `<h2 class="section">Coach <a href="#/coach">All reviews</a></h2>
      <a class="card review collapsed" href="#/coach" style="display:block;text-decoration:none">
        <div class="when">Week of ${esc(fmtShort(r.week_start))}</div><div class="md">${md(r.content)}</div></a>`;
  }

  const pending = getQ().length;
  const pendingHtml = pending ? `<p><span class="offline-pill">${pending} ${pending === 1 ? "entry" : "entries"} waiting to upload</span></p>` : "";
  const failed = getFailed().length;
  const failedHtml = failed ? `<button type="button" class="notice" id="failedBtn"><b>${entries(failed)} couldn't upload.</b> Tap to fix or discard.</button>` : "";

  view.innerHTML = top + failedHtml + pendingHtml + weekHtml + stats + startCard + todayHtml + weightHtml + reviewHtml;
  $("#startWk")?.addEventListener("click", () => startWorkout());
  $("#failedBtn")?.addEventListener("click", openFailed);
}

async function renderHistory() {
  const fresh = claimView();
  const seg = `<div class="seg" role="group" aria-label="View">
      <button type="button" aria-pressed="true">Log</button>
      <button type="button" aria-pressed="false" data-go="#/history/progress">Progress</button></div>`;
  const filters = [["all", "All"], ["workouts", "Workouts"], ["cardio", "Cardio"], ["meals", "Diet"], ["body", "Body"]];
  const chips = `<div class="chips" style="margin-top:14px">${filters.map(([k, label]) =>
    `<button type="button" class="chip" data-filter="${k}" aria-pressed="${S.historyFilter === k}">${label}</button>`).join("")}</div>`;
  view.innerHTML = head("History") + seg + chips + loading();

  const to = today();
  const from = addDays(mondayOf(to), -7 * (S.historyWeeks - 1));
  const data = await api("GET", `/range?from=${from}&to=${to}`);
  if (!fresh()) return;
  const items = flatten(data, S.historyFilter);
  const body = items.length
    ? groupedList(items)
    : `<div class="list" style="margin-top:18px"><div class="empty"><strong>No entries</strong>Nothing logged since ${esc(fmtShort(from))}. Tap + to add one.</div></div>`;
  view.innerHTML = head("History") + seg + chips + body +
    `<p style="margin-top:20px"><button type="button" class="btn ghost block" id="more">Show 4 more weeks</button></p>`;

  $$("[data-filter]").forEach((b) => b.addEventListener("click", () => { S.historyFilter = b.dataset.filter; renderHistory(); }));
  $("#more").addEventListener("click", () => { S.historyWeeks += 4; renderHistory(); });
}

async function renderProgress() {
  const fresh = claimView();
  const seg = `<div class="seg" role="group" aria-label="View">
      <button type="button" aria-pressed="false" data-go="#/history">Log</button>
      <button type="button" aria-pressed="true">Progress</button></div>`;
  view.innerHTML = head("History") + seg + loading();
  const [exercises, bodyHist] = await Promise.all([loadExercises(true), api("GET", "/body-history")]);
  if (!fresh()) return;

  let liftHtml = `<h2 class="section">Exercises</h2><div class="list"><div class="empty"><strong>No workouts yet</strong>Log a workout and each exercise's progress shows up here.</div></div>`;
  if (exercises.length) {
    const sorted = [...exercises].sort((a, b) => b.times - a.times || b.date.localeCompare(a.date));
    const cur = sorted.find((e) => e.key === S.progressKey) || sorted[0];
    S.progressKey = cur.key;
    const hist = await api("GET", "/history?key=" + encodeURIComponent(cur.key));
    if (!fresh()) return;
    const kind = cur.kind;
    const { best, pts } = exerciseTrend(kind, hist);
    const weighted = best && kind !== "time" && best.s.w > 0;
    const bigLabel = kind === "time" ? "longest hold" : weighted ? `${unit()} est. 1-rep max` : "most reps";
    const bigVal = !best ? "–" : kind === "time" ? fmtClock(best.v) : fmt(best.v, weighted ? 1 : 0);
    liftHtml = `<h2 class="section">Exercises</h2>
      <div class="chips">${sorted.map((e) => `<button type="button" class="chip" data-key="${esc(e.key)}" aria-pressed="${e.key === cur.key}">${esc(e.exercise)}</button>`).join("")}</div>
      <div class="card" style="margin-top:10px">
        <button type="button" class="wx-id" id="exAbout">${thumb(cur.exercise_id, cur.exercise)}<span class="main"><span class="title">${esc(cur.exercise)}</span><span class="meta">${hist.length} ${hist.length === 1 ? "session" : "sessions"}, tap for how-to</span></span></button>
        <div class="bignum" style="margin-top:12px">${bigVal}<small> ${bigLabel}</small></div>
        <div class="muted small">${best ? `Best set ${esc(setText(kind, best.s))} on ${esc(fmtDay(best.date))}` : ""}</div>
        ${pts.length >= 2 ? lineChart(pts, { color: "var(--lift)", suffix: kind === "time" ? " s" : "" }) : `<p class="muted small">Log this exercise on another day to see a trend line.</p>`}
      </div>`;
  }

  const weights = bodyHist.filter((b) => b.weight != null).map((b) => ({ x: b.date, y: b.weight }));
  const waist = bodyHist.filter((b) => b.waist_cm != null).map((b) => ({ x: b.date, y: b.waist_cm }));
  const goal = Number(S.settings.bodyweight_goal) || null;
  const bodyHtml = `<h2 class="section">Body weight</h2>` + (weights.length >= 2
    ? `<div class="card">${lineChart(weights, { color: "var(--body)", goal })}</div>`
    : `<div class="list"><div class="empty"><strong>Not enough weigh-ins</strong>Log your weight on two different days to see the trend.</div></div>`) +
    (waist.length >= 2 ? `<h2 class="section">Waist</h2><div class="card">${lineChart(waist, { color: "var(--body)", suffix: " cm" })}</div>` : "");

  view.innerHTML = head("History") + seg + liftHtml + bodyHtml;
  $$("[data-key]").forEach((b) => b.addEventListener("click", () => { S.progressKey = b.dataset.key; renderProgress(); }));
  $("[data-key][aria-pressed=true]")?.scrollIntoView({ inline: "center", block: "nearest" });
  $("#exAbout")?.addEventListener("click", () => {
    const cur = exercises.find((e) => e.key === S.progressKey);
    openExerciseDetail({ id: cur.exercise_id, name: cur.exercise, kind: cur.kind });
  });
}

async function renderPhotos() {
  const fresh = claimView();
  const seg = `<div class="seg" role="group" aria-label="Photo type">
    <button type="button" data-ptab="body" aria-pressed="${S.photoTab === "body"}">Progress</button>
    <button type="button" data-ptab="meals" aria-pressed="${S.photoTab === "meals"}">Diet</button></div>`;
  const add = `<a class="btn small ${S.photoTab === "body" ? "t-body" : "t-meals"} accent" href="#/log/${S.photoTab}">Add photo</a>`;
  view.innerHTML = head("Photos", "", add) + seg + loading();

  let photos;
  if (S.photoTab === "body") {
    photos = (await api("GET", "/body-history")).filter((b) => b.photo_key).reverse().map((e) => ({ type: "body", e }));
  } else {
    const data = await api("GET", `/range?from=${addDays(today(), -180)}&to=${today()}`);
    photos = data.meals.filter((m) => m.photo_key).map((e) => ({ type: "meals", e }));
  }
  if (!fresh()) return;
  photos.forEach((p) => remember(p.type, p.e));

  let selected = [];
  const draw = () => {
    const compareBar = S.photoTab === "body" && photos.length >= 2
      ? `<p class="muted small" style="margin:14px 2px 8px">${selected.length ? `${selected.length} of 2 picked to compare` : "Tap a photo to view it. Long-press two photos to compare them."}</p>` : `<div style="height:14px"></div>`;
    const compare = selected.length === 2 ? (() => {
      const [a, b] = selected.map((id) => photos.find((p) => p.e.id === id).e).sort((x, y) => x.date.localeCompare(y.date));
      const diff = a.weight != null && b.weight != null ? `${b.weight - a.weight > 0 ? "+" : ""}${fmt(b.weight - a.weight)} ${unit()}` : "";
      return `<div class="card" style="margin-bottom:12px"><div class="compare">
        ${[a, b].map((p) => `<figure><img alt="Progress photo ${esc(p.date)}" src="/api/photos/${encodeURIComponent(p.photo_key)}"><figcaption>${esc(fmtShort(p.date))}${p.weight != null ? `, ${fmt(p.weight)} ${unit()}` : ""}</figcaption></figure>`).join("")}
        </div><p class="muted small" style="margin:8px 0 0">${Math.round((parseYmd(b.date) - parseYmd(a.date)) / 864e5)} days apart${diff ? `, ${diff}` : ""}</p>
        <button type="button" class="more" id="clearCmp">Clear comparison</button></div>`;
    })() : "";
    const grid = photos.length
      ? `<div class="pgrid">${photos.map((p) => {
          const i = selected.indexOf(p.e.id);
          return `<button type="button" data-pid="${p.e.id}" aria-pressed="${i >= 0}" aria-label="Photo from ${esc(fmtDay(p.e.date))}">
            <img loading="lazy" alt="" src="/api/photos/${encodeURIComponent(p.e.photo_key)}"><span class="d">${esc(fmtShort(p.e.date))}</span>${i >= 0 ? `<span class="tick">${i + 1}</span>` : ""}</button>`;
        }).join("")}</div>`
      : `<div class="list"><div class="empty"><strong>No ${S.photoTab === "body" ? "progress" : "meal"} photos yet</strong>${S.photoTab === "body" ? "Take one each week in the same spot and light so changes are easy to see." : "Add a photo when you log a meal."}</div></div>`;
    view.innerHTML = head("Photos", "", add) + seg + compareBar + compare + grid;
    $$("[data-ptab]").forEach((b) => b.addEventListener("click", () => { S.photoTab = b.dataset.ptab; renderPhotos(); }));
    $("#clearCmp")?.addEventListener("click", () => { selected = []; draw(); });
    $$("[data-pid]").forEach((b) => {
      const id = Number(b.dataset.pid);
      let timer, long = false;
      const toggle = () => {
        if (S.photoTab !== "body") return;
        long = true;
        selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected.slice(-1), id];
        draw();
        if (selected.length === 2) window.scrollTo(0, 0);
      };
      b.addEventListener("touchstart", () => { long = false; timer = setTimeout(toggle, 450); }, { passive: true });
      b.addEventListener("touchend", () => clearTimeout(timer));
      b.addEventListener("touchmove", () => clearTimeout(timer), { passive: true });
      b.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!long) toggle(); });
      b.addEventListener("click", () => {
        if (long) { long = false; return; }
        if (selected.length && S.photoTab === "body") { toggle(); long = false; return; }
        openViewer(photos.find((p) => p.e.id === id));
      });
    });
  };
  draw();
}

function openViewer({ type, e }) {
  const el = document.createElement("div");
  el.className = "viewer";
  const caption = type === "body"
    ? [fmtDay(e.date, true), e.weight != null ? `${fmt(e.weight)} ${unit()}` : "", e.notes || ""].filter(Boolean).join(", ")
    : [fmtDay(e.date, true), MEAL_NAMES[e.meal], e.description || "", e.calories != null ? `${fmt(e.calories, 0)} kcal` : ""].filter(Boolean).join(", ");
  el.innerHTML = `<header><button type="button" data-x>Done</button><button type="button" data-edit>Edit</button></header>
    <img alt="" src="/api/photos/${encodeURIComponent(e.photo_key)}"><footer>${esc(caption)}</footer>`;
  document.body.appendChild(el);
  holdBack();
  const close = () => { el.remove(); releaseBack(); };
  $("[data-x]", el).addEventListener("click", close);
  $("[data-edit]", el).addEventListener("click", () => { close(); location.hash = `#/edit/${type}/${e.id}`; });
}

async function renderCoach() {
  const fresh = claimView();
  view.innerHTML = head("Coach", "Weekly review of your logs") + loading();
  const reviews = S.me.ai ? await api("GET", "/reviews") : [];
  if (!fresh()) return;
  const off = !S.me.ai
    ? `<div class="notice">AI reviews are off. Add your OpenAI API key as the <b>OPENAI_API_KEY</b> secret (see the setup guide).</div>` : "";
  const buttons = S.me.ai ? `<div class="btn-row">
      <button type="button" class="btn" data-which="this">Review this week</button>
      <button type="button" class="btn ghost" data-which="last">Review last week</button></div>
      <p class="muted small" style="margin:10px 2px 0">A new review is also written automatically every Sunday evening. Photos are never sent to the AI.</p>` : "";
  const list = reviews.length
    ? reviews.map((r, i) => `<article class="card review ${i ? "collapsed" : ""}">
        <div class="when">Week of ${esc(fmtShort(r.week_start))}</div>
        <div class="meta">Written ${esc(fmtDay(r.created_at.slice(0, 10)))}</div>
        <div class="md">${md(r.content)}</div>
        ${i ? `<button type="button" class="more" data-expand>Show full review</button>` : ""}</article>`).join("")
    : S.me.ai ? `<div class="list"><div class="empty"><strong>No reviews yet</strong>Log a few days, then tap Review this week.</div></div>` : "";
  view.innerHTML = head("Coach", "Weekly review of your logs") + off + buttons + `<div style="margin-top:20px">${list}</div>`;

  $$("[data-expand]").forEach((b) => b.addEventListener("click", () => { b.closest(".review").classList.remove("collapsed"); b.remove(); }));
  $$("[data-which]").forEach((b) => b.addEventListener("click", async () => {
    $$("[data-which]").forEach((x) => (x.disabled = true));
    const label = b.textContent;
    b.textContent = "Reviewing…";
    try {
      await api("POST", "/reviews", { which: b.dataset.which, today: today() });
      toast("Review ready");
      if (fresh()) renderCoach();
    } catch (e) {
      toast(e.message, true);
      b.textContent = label;
      $$("[data-which]").forEach((x) => (x.disabled = false));
    }
  }));
}

function renderSettings() {
  const s = S.settings;
  view.innerHTML = `<button type="button" class="back" data-go="#/">${ICON.back}Today</button>` + head("Settings") + `
    <form id="settings">
      <label class="field"><span>Your goal</span><textarea name="goal" placeholder="For example: lean bulk, bench 100 kg by March, run 5 km under 25 min">${esc(s.goal || "")}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Daily calories</span><div class="unit-wrap"><input name="calorie_target" inputmode="numeric" value="${esc(s.calorie_target || "")}" placeholder="2600"><em>kcal</em></div></label>
        <label class="field"><span>Daily protein</span><div class="unit-wrap"><input name="protein_target" inputmode="numeric" value="${esc(s.protein_target || "")}" placeholder="150"><em>g</em></div></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Goal weight</span><div class="unit-wrap"><input name="bodyweight_goal" inputmode="decimal" value="${esc(s.bodyweight_goal || "")}" placeholder="75"><em>${unit()}</em></div></label>
        <div class="field"><span>Weight unit</span><div class="seg" role="group" aria-label="Weight unit" style="min-height:50px;align-items:center">
          <button type="button" data-unit="kg" aria-pressed="${unit() === "kg"}">kg</button><button type="button" data-unit="lb" aria-pressed="${unit() === "lb"}">lb</button></div></div>
      </div>
      <p class="muted small" style="margin:0 2px">The coach uses your goal and targets when it writes your weekly review.</p>
      <button class="btn block" type="submit">Save settings</button>
    </form>
    <h2 class="section">Your data</h2>
    <div class="list settings-list">
      <a class="row" href="/api/export" download><span class="main"><span class="title">Export all logs</span><span class="meta">Downloads a JSON file. Photos stay in your storage.</span></span></a>
      <button type="button" class="row" id="logout"><span class="main"><span class="title" style="color:var(--danger)">Log out</span></span></button>
    </div>
    <p class="muted small" style="margin-top:16px">AI model: ${esc(S.me.ai ? S.me.model : "off")}. Weekly reviews follow the ${esc(S.me.timezone)} time zone. Exercise photos and instructions come from the free-exercise-db project (public domain).</p>`;

  let chosenUnit = unit();
  $$("[data-unit]").forEach((b) => b.addEventListener("click", () => {
    chosenUnit = b.dataset.unit;
    $$("[data-unit]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  $("#settings").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const changingUnit = chosenUnit !== unit();
    if (changingUnit) {
      if (activeWorkout() || getQ().length || getFailed().length) return toast("Finish your workout and clear any saved entries before changing units.", true);
      if (!(await confirmSheet(`Switch to ${chosenUnit}?`, `Convert my weights to ${chosenUnit}`, { subtitle: "Every weight you've logged will be converted.", danger: false }))) return;
    }
    try {
      S.settings = await api("PUT", "/settings", { goal: f.get("goal"), calorie_target: f.get("calorie_target"), protein_target: f.get("protein_target"), bodyweight_goal: f.get("bodyweight_goal"), unit: chosenUnit });
      S.me.settings = S.settings;
      store.set("gymlog-me", S.me);
      toast("Settings saved");
      if (changingUnit) {
        S.exercises = null;
        if (location.hash === "#/settings") renderSettings();
      }
    } catch (e) { toast(e.message, true); }
  });
  $("#logout").addEventListener("click", async () => {
    if (!(await confirmSheet("Log out of RepWise on this phone?", "Log out"))) return;
    try { await api("POST", "/logout", {}); } catch {}
    store.del("gymlog-me");
    S.me = null;
    showLogin();
  });
}

// ---------- entry forms (cardio, meals, body) ----------

function defaultMeal() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return h < 10.5 ? "breakfast" : h < 15 ? "lunch" : h < 18 ? "snack" : "dinner";
}

async function compressPhoto(file, max = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That photo couldn't be opened. Try another one."));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("That photo couldn't be processed."))), "image/jpeg", quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function photoField(kind, existingKey) {
  const src = existingKey ? `/api/photos/${encodeURIComponent(existingKey)}` : "";
  return `<div class="field"><span>${kind === "body" ? "Progress photo" : "Food photo"}</span>
    <label class="photo-pick">
      <span class="ph" id="phPrev">${src ? `<img alt="" src="${src}">` : ICON.camera}</span>
      <span><b id="phLabel">${src ? "Change photo" : kind === "body" ? "Take a progress photo" : "Take or choose a food photo"}</b><br><span class="muted small">Private. Only you can see it.</span></span>
      <input type="file" accept="image/*" id="photoInput">
    </label>
    ${src ? `<button type="button" class="more" id="removePhoto" style="justify-self:start">Remove photo</button>` : ""}</div>`;
}

async function renderForm(type, id) {
  const existing = id ? S.byId[`${type}:${id}`] : null;
  if (id && !existing) { location.replace("#/history"); return; }
  const draft = !id && S.draft?.type === type ? S.draft : null;
  S.draft = null;
  const e = existing || draft?.data || {};
  const clientId = draft?.data.client_id || newClientId();
  const T = TYPE[type];
  const title = existing ? `Edit ${T.name.toLowerCase()}` : type === "meals" ? "Diet" : T.name;
  let fields = "";

  if (type === "cardio") {
    const act = e.activity || "";
    fields = `
      <div class="field"><span>Activity</span>
        <div class="chips">${CARDIO_PRESETS.map((a) => `<button type="button" class="chip" data-act="${a}" aria-pressed="${a === act}">${a}</button>`).join("")}</div>
        <input name="activity" class="input" value="${esc(act)}" placeholder="Or type your own" autocapitalize="sentences" required></div>
      <div class="grid2">
        <label class="field"><span>Time</span><div class="unit-wrap"><input name="minutes" inputmode="decimal" value="${esc(e.minutes ?? "")}" placeholder="30"><em>min</em></div></label>
        <label class="field"><span>Distance</span><div class="unit-wrap"><input name="distance_km" inputmode="decimal" value="${esc(e.distance_km ?? "")}" placeholder="5"><em>km</em></div></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Calories</span><div class="unit-wrap"><input name="calories" inputmode="numeric" value="${esc(e.calories ?? "")}" placeholder="optional"><em>kcal</em></div></label>
        <label class="field"><span>Avg heart rate</span><div class="unit-wrap"><input name="avg_hr" inputmode="numeric" value="${esc(e.avg_hr ?? "")}" placeholder="optional"><em>bpm</em></div></label>
      </div>
      <label class="field"><span>Notes</span><textarea name="notes" placeholder="Pace, route, how it felt">${esc(e.notes || "")}</textarea></label>`;
  } else if (type === "meals") {
    const meal = e.meal || defaultMeal();
    fields = `
      <div class="field"><span>Meal</span><div class="seg" role="group" aria-label="Meal">${Object.entries(MEAL_NAMES).map(([k, v]) => `<button type="button" data-meal="${k}" aria-pressed="${k === meal}">${v}</button>`).join("")}</div></div>
      ${photoField("meal", e.photo_key)}
      <label class="field"><span>What you ate</span><input name="description" value="${esc(e.description || "")}" placeholder="Chicken, rice, salad" autocapitalize="sentences"></label>
      <div class="grid2">
        <label class="field"><span>Calories</span><div class="unit-wrap"><input name="calories" inputmode="numeric" value="${esc(e.calories ?? "")}" placeholder="optional"><em>kcal</em></div></label>
        <label class="field"><span>Protein</span><div class="unit-wrap"><input name="protein_g" inputmode="numeric" value="${esc(e.protein_g ?? "")}" placeholder="optional"><em>g</em></div></label>
      </div>
      <label class="field"><span>Notes</span><textarea name="notes" placeholder="Optional">${esc(e.notes || "")}</textarea></label>`;
  } else {
    fields = `
      <label class="field"><span>Body weight</span><div class="unit-wrap"><input name="weight" inputmode="decimal" value="${esc(e.weight ?? "")}" placeholder="75.0"><em>${unit()}</em></div></label>
      <div class="grid2">
        <label class="field"><span>Body fat</span><div class="unit-wrap"><input name="body_fat" inputmode="decimal" value="${esc(e.body_fat ?? "")}" placeholder="optional"><em>%</em></div></label>
        <label class="field"><span>Waist</span><div class="unit-wrap"><input name="waist_cm" inputmode="decimal" value="${esc(e.waist_cm ?? "")}" placeholder="optional"><em>cm</em></div></label>
      </div>
      ${photoField("body", e.photo_key)}
      <label class="field"><span>Notes</span><textarea name="notes" placeholder="Morning, after bathroom, before food is most consistent">${esc(e.notes || "")}</textarea></label>`;
  }

  const actions = existing
    ? `<button class="btn accent block" type="submit">Save changes</button>
       <button class="btn danger block" type="button" id="del">Delete this entry</button>`
    : `<button class="btn accent block" type="submit">Save</button>`;

  view.innerHTML = `<div class="${T.cls}">
    <button type="button" class="back" id="cancel">${ICON.back}Cancel</button>
    <div class="form-title"><span class="disc"></span><h1>${esc(title)}</h1></div>
    <form id="entry" novalidate>
      <div class="field"><span>Date</span>${dateField({ name: "date", value: e.date || today(), max: addDays(today(), 1) })}</div>
      ${fields}
      ${actions}
    </form></div>`;

  const form = $("#entry");
  $("#cancel").addEventListener("click", goBack);

  if (type === "cardio") {
    $$("[data-act]").forEach((b) => b.addEventListener("click", () => {
      form.activity.value = b.dataset.act;
      $$("[data-act]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    }));
    form.activity.addEventListener("input", () => $$("[data-act]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.act === form.activity.value)));
  }

  let meal = e.meal || defaultMeal();
  $$("[data-meal]").forEach((b) => b.addEventListener("click", () => {
    meal = b.dataset.meal;
    $$("[data-meal]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));

  let photoBlob = null, photoKey = e.photo_key || null;
  const showPicked = () => {
    $("#phPrev").innerHTML = `<img alt="" src="${URL.createObjectURL(photoBlob)}">`;
    $("#phLabel").textContent = "Change photo";
  };
  $("#photoInput")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      photoBlob = await compressPhoto(file);
      showPicked();
    } catch (err) { toast(err.message, true); }
  });
  $("#removePhoto")?.addEventListener("click", (ev) => {
    photoKey = null; photoBlob = null;
    $("#phPrev").innerHTML = ICON.camera;
    $("#phLabel").textContent = "Add a photo";
    ev.target.remove();
  });

  $("#del")?.addEventListener("click", async () => {
    if (!(await confirmSheet("Delete this entry?", "Delete entry", { subtitle: "This can't be undone." }))) return;
    try {
      await api("DELETE", `/entries/${type}/${id}`);
      delete S.byId[`${type}:${id}`];
      toast("Deleted");
      goBack();
    } catch (err) { toast(err.message, true); }
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btns = $$("button[type=submit]", form);
    const f = new FormData(form);
    const data = { date: f.get("date"), notes: f.get("notes") };
    if (!existing) data.client_id = clientId;
    if (type === "cardio") {
      Object.assign(data, { activity: f.get("activity"), minutes: f.get("minutes"), distance_km: f.get("distance_km"), calories: f.get("calories"), avg_hr: f.get("avg_hr") });
      if (!String(data.activity || "").trim()) return toast("Pick or type an activity.", true);
    } else if (type === "meals") {
      Object.assign(data, { meal, description: f.get("description"), calories: f.get("calories"), protein_g: f.get("protein_g") });
      const blank = (v) => !String(v ?? "").trim();
      if (blank(data.description) && blank(data.calories) && blank(data.protein_g) && !photoBlob && !photoKey) return toast("Describe the meal or add a photo.", true);
    } else {
      Object.assign(data, { weight: f.get("weight"), body_fat: f.get("body_fat"), waist_cm: f.get("waist_cm") });
    }
    if (!data.date) return toast("Pick a date.", true);

    btns.forEach((b) => (b.disabled = true));
    const kind = type === "body" ? "body" : "meal";
    try {
      let queuedPhoto = null;
      if (photoBlob) {
        try {
          const { key } = await api("POST", `/photos?kind=${kind}&date=${data.date}`, photoBlob);
          photoKey = key;
          photoBlob = null; // already uploaded, so tapping Save again won't send it twice
        } catch (err) {
          if (!(err instanceof OfflineError) || existing) throw err;
          queuedPhoto = { kind, dataUrl: await blobToDataUrl(photoBlob) };
        }
      }
      if (type === "meals" || type === "body") data.photo_key = photoKey;

      const addToQueue = () => {
        const q = getQ();
        q.push({ path: `/entries/${type}`, data, photo: queuedPhoto });
        if (!setQ(q)) throw new Error("You're offline and this phone is out of space to hold the entry.");
      };
      // An entry whose photo couldn't upload goes in the queue whole, so the two are never separated.
      let queued = !!queuedPhoto;
      if (queued) addToQueue();
      else {
        try {
          const saved = existing ? await api("PUT", `/entries/${type}/${id}`, data) : await api("POST", `/entries/${type}`, data);
          remember(type, saved);
        } catch (err) {
          if (!(err instanceof OfflineError) || existing) throw err;
          addToQueue();
          queued = true;
        }
      }
      if (draft) dropFailed(draft.id);
      toast(queued ? "Saved on this phone. It uploads when you're back online." : existing ? "Changes saved" : "Saved");
      goBack();
    } catch (err) {
      toast(err.message, true);
      btns.forEach((b) => (b.disabled = false));
    }
  });

  if (draft?.photo) {
    photoBlob = await dataUrlToBlob(draft.photo.dataUrl);
    showPicked();
  }
}

function goBack() { location.hash = S.returnTo || "#/"; }

// ---------- login ----------

function showLogin() {
  claimView();
  tabbar.hidden = true;
  setRouteKind("other");
  document.body.classList.add("bare");
  view.innerHTML = `<div class="login">
    <img class="login-art" src="/gym.svg" alt="" width="800" height="520">
    <div><h1>RepWise</h1><p>Log every set, track every meal, and get a coach's read on your week.</p></div>
    <form id="login">
      <input type="text" name="username" value="me" autocomplete="username" hidden>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn block" type="submit">Log in</button>
    </form></div>`;
  $("#login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("button", ev.target);
    btn.disabled = true;
    try {
      await api("POST", "/login", { password: ev.target.password.value });
      await boot();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  });
}

// ---------- router ----------

// [pattern, render, tab (null = full screen, no tab bar)]
const ROUTES = [
  [/^\/?$/, renderToday, "today"],
  [/^\/history$/, renderHistory, "history"],
  [/^\/history\/progress$/, renderProgress, "history"],
  [/^\/photos$/, renderPhotos, "photos"],
  [/^\/coach$/, renderCoach, "coach"],
  [/^\/settings$/, renderSettings, "today"],
  [/^\/workout$/, () => renderLiveWorkout(view), null],
  [/^\/w\/(\d+)$/, (m) => renderWorkoutDetail(view, Number(m[1])), "history"],
  [/^\/w\/(\d+)\/edit$/, (m) => renderWorkoutEdit(view, Number(m[1])), null],
  [/^\/log\/lifts$/, () => { location.replace("#/"); startWorkout(); }, null],
  [/^\/log\/(cardio|meals|body)$/, (m) => renderForm(m[1]), null],
  [/^\/edit\/(cardio|meals|body)\/(\d+)$/, (m) => renderForm(m[1], Number(m[2])), null],
];

function showError(title, message, retry) {
  view.innerHTML = `<div class="list" style="margin-top:40px"><div class="empty"><strong>${esc(title)}</strong>${esc(message)}</div></div>
    <p style="margin-top:14px"><button type="button" class="btn ghost block" id="retry">Try again</button></p>`;
  $("#retry").addEventListener("click", retry);
}

async function route() {
  if (!S.me) return;
  closeSheet();
  $$(".overlay").forEach((o) => o.remove());
  document.body.classList.remove("locked");
  const path = location.hash.replace(/^#/, "") || "/";
  const hit = ROUTES.map(([re, fn, tab]) => [path.match(re), fn, tab]).find(([m]) => m);
  if (!hit) { location.replace("#/"); return; }
  const [m, fn, tab] = hit;
  const isFull = tab === null;
  const isDetail = /^\/w\/\d+$/.test(path);
  if (!isFull && !isDetail) S.returnTo = "#" + path;
  tabbar.hidden = isFull;
  document.body.classList.toggle("bare", isFull);
  setRouteKind(path === "/workout" ? "workout" : isFull ? "other" : "tab");
  $$("#tabbar a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  claimView(); // anything still loading for the previous screen must not draw
  window.scrollTo(0, 0);
  let drawing = currentView();
  try {
    const done = fn(m); // a screen that loads data makes its own claim as it starts
    drawing = currentView();
    await done;
  } catch (e) {
    if (drawing !== currentView() || !S.me) return;
    const offline = e instanceof OfflineError;
    showError(offline ? "You're offline" : "That didn't load", offline ? "Your logs will show once you're connected. You can still log with the + button." : e.message, route);
  }
}
window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) location.hash = go.dataset.go;
});

// ---------- start ----------

async function boot() {
  try {
    S.me = await api("GET", "/me");
    store.set("gymlog-me", S.me);
  } catch (e) {
    if (e.status === 401) return; // the login screen is already showing
    if (!(e instanceof OfflineError)) { showError("RepWise couldn't start", e.message, boot); return; }
    S.me = store.get("gymlog-me");
    if (!S.me) {
      view.innerHTML = `<div class="list" style="margin-top:40px"><div class="empty"><strong>You're offline</strong>Connect to the internet to log in.</div></div>`;
      return;
    }
  }
  S.settings = S.me.settings || { unit: "kg" };
  tabbar.hidden = false;
  route();
  flushQueue();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
boot();
