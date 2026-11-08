// RepWise — Cloudflare Worker backend
// Serves the API under /api/*; the website files in /public are served by Cloudflare automatically.
//
// Bindings (see wrangler.jsonc): DB (D1), PHOTOS (R2), ASSETS (static files)
// Secrets: APP_PASSWORD, SESSION_SECRET, OPENAI_API_KEY (optional, for AI reviews)
// Vars: TIMEZONE (e.g. "Asia/Kolkata"), OPENAI_MODEL

const SESSION_COOKIE = "gl_session";
const SESSION_DAYS = 60;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const DEFAULT_MODEL = "gpt-6-luna";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const LB_PER_KG = 2.20462262;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

// Exercise library: free-exercise-db (public domain, The Unlicense), 870+ exercises with photos.
// Downloaded once, then kept in your own R2 bucket so it keeps working even if GitHub is down.
const LIB_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/";
const LIB_KEY = "library/exercises.json";
const LIB_ID_RE = /^[A-Za-z0-9_\-(),'.]{1,140}$/;

const KINDS = ["weight_reps", "reps", "time"]; // weight & reps | bodyweight reps (+ optional weight) | duration
const SET_TYPES = ["n", "w", "d", "f"]; // normal | warm-up | drop set | failure
const MUSCLES = ["abdominals", "abductors", "adductors", "biceps", "calves", "chest", "forearms", "glutes", "hamstrings", "lats", "lower back", "middle back", "neck", "quadriceps", "shoulders", "traps", "triceps"];
const EQUIPMENT = ["barbell", "dumbbell", "body only", "machine", "cable", "kettlebells", "bands", "e-z curl bar", "medicine ball", "exercise ball", "foam roll", "other"];

// ---------- small helpers ----------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const fail = (status, message) => json({ error: message }, status);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Monday of the week containing dateStr
function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(dateStr, -dow);
}

function num(v, { min = -1e9, max = 1e9 } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  if (!Number.isFinite(n)) throw new HttpError(400, `"${v}" is not a number`);
  if (n < min || n > max) throw new HttpError(400, `${n} is out of range`);
  return Math.round(n * 100) / 100;
}

function text(v, max = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ---------- database setup (runs once per server start; also upgrades older databases) ----------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, name TEXT, started_at INTEGER, duration_sec INTEGER, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date)`,
  `CREATE TABLE IF NOT EXISTS lifts (id INTEGER PRIMARY KEY AUTOINCREMENT, workout_id INTEGER, position INTEGER DEFAULT 0, date TEXT NOT NULL, exercise_id TEXT, exercise TEXT NOT NULL, kind TEXT DEFAULT 'weight_reps', sets_json TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_lifts_date ON lifts(date)`,
  `CREATE TABLE IF NOT EXISTS custom_exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'weight_reps', muscle TEXT, equipment TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS cardio (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, activity TEXT NOT NULL, minutes REAL, distance_km REAL, calories REAL, avg_hr REAL, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_cardio_date ON cardio(date)`,
  `CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, meal TEXT NOT NULL, description TEXT, calories REAL, protein_g REAL, photo_key TEXT, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date)`,
  `CREATE TABLE IF NOT EXISTS body (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, weight REAL, body_fat REAL, waist_cm REAL, photo_key TEXT, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_body_date ON body(date)`,
  `CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, week_start TEXT NOT NULL, week_end TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_week ON reviews(week_start)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, at)`,
];

// Columns added after the first release. Older databases get them on startup.
const ADDED_COLUMNS = {
  lifts: [
    ["workout_id", "INTEGER"],
    ["position", "INTEGER DEFAULT 0"],
    ["exercise_id", "TEXT"],
    ["kind", "TEXT DEFAULT 'weight_reps'"],
  ],
  workouts: [["client_id", "TEXT"]],
  cardio: [["client_id", "TEXT"]],
  meals: [["client_id", "TEXT"]],
  body: [["client_id", "TEXT"]],
};

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
      const tables = Object.keys(ADDED_COLUMNS);
      const infos = await Promise.all(tables.map((t) => env.DB.prepare(`PRAGMA table_info(${t})`).all()));
      const stmts = tables.flatMap((t, i) => {
        const have = new Set((infos[i].results || []).map((r) => r.name));
        return ADDED_COLUMNS[t].filter(([c]) => !have.has(c)).map(([c, type]) => env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`));
      });
      stmts.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_lifts_workout ON lifts(workout_id)"));
      stmts.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_lifts_key ON lifts(exercise_id, exercise)"));
      for (const t of ["workouts", "cardio", "meals", "body"]) {
        stmts.push(env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_client ON ${t}(client_id)`));
      }
      await env.DB.batch(stmts);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ---------- auth ----------

// Sessions are signed with the password too, so changing the password logs every device out.
const sessionKey = (env) => `${env.SESSION_SECRET}:${env.APP_PASSWORD}`;

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = await hmac(sessionKey(env), `session:${exp}`);
  return `${exp}.${sig}`;
}

async function isLoggedIn(request, env) {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) return false;
  const [expStr, sig] = raw.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const expected = await hmac(sessionKey(env), `session:${exp}`);
  return safeEqual(sig, expected);
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function handleLogin(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?")
    .bind(ip, now - LOGIN_WINDOW_MS)
    .first();
  if ((recent?.n || 0) >= LOGIN_MAX_FAILS) {
    return fail(429, "Too many wrong passwords. Wait 15 minutes and try again.");
  }

  const body = await readJson(request);
  const given = String(body.password || "");
  const a = await hmac(env.SESSION_SECRET, "pw:" + given);
  const b = await hmac(env.SESSION_SECRET, "pw:" + env.APP_PASSWORD);
  if (!safeEqual(a, b)) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)").bind(ip, now),
      env.DB.prepare("DELETE FROM login_attempts WHERE at < ?").bind(now - 864e5),
    ]);
    return fail(401, "Wrong password.");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

// ---------- simple entry types (cardio, meals, body) ----------

const MEALS = ["breakfast", "lunch", "dinner", "snack"];

const TYPES = {
  cardio: {
    columns: ["date", "activity", "minutes", "distance_km", "calories", "avg_hr", "notes"],
    clean(b) {
      const activity = text(b.activity, 60);
      if (!activity) throw new HttpError(400, "Enter an activity.");
      const minutes = num(b.minutes, { min: 0, max: 1440 });
      const distance_km = num(b.distance_km, { min: 0, max: 1000 });
      if (minutes === null && distance_km === null) throw new HttpError(400, "Add minutes or distance.");
      return {
        activity,
        minutes,
        distance_km,
        calories: num(b.calories, { min: 0, max: 20000 }),
        avg_hr: num(b.avg_hr, { min: 20, max: 250 }),
        notes: text(b.notes, 1000),
      };
    },
  },
  meals: {
    columns: ["date", "meal", "description", "calories", "protein_g", "photo_key", "notes"],
    clean(b) {
      const meal = MEALS.includes(b.meal) ? b.meal : "snack";
      const description = text(b.description, 500);
      const photo_key = cleanPhotoKey(b.photo_key);
      const calories = num(b.calories, { min: 0, max: 20000 });
      const protein_g = num(b.protein_g, { min: 0, max: 1000 });
      if (!description && !photo_key && calories === null && protein_g === null) throw new HttpError(400, "Describe the meal or add a photo.");
      return {
        meal,
        description,
        calories,
        protein_g,
        photo_key,
        notes: text(b.notes, 1000),
      };
    },
  },
  body: {
    columns: ["date", "weight", "body_fat", "waist_cm", "photo_key", "notes"],
    clean(b) {
      const out = {
        weight: num(b.weight, { min: 20, max: 700 }),
        body_fat: num(b.body_fat, { min: 1, max: 75 }),
        waist_cm: num(b.waist_cm, { min: 30, max: 300 }),
        photo_key: cleanPhotoKey(b.photo_key),
        notes: text(b.notes, 1000),
      };
      if (out.weight === null && out.body_fat === null && out.waist_cm === null && !out.photo_key)
        throw new HttpError(400, "Add a weight, measurement or photo.");
      return out;
    },
  },
};

const PHOTO_KEY_RE = /^(meal|body)\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

function cleanPhotoKey(k) {
  if (!k) return null;
  if (typeof k !== "string" || !PHOTO_KEY_RE.test(k)) throw new HttpError(400, "Invalid photo reference.");
  return k;
}

const cleanClientId = (v) => (typeof v === "string" && CLIENT_ID_RE.test(v) ? v : null);

async function createEntry(env, type, body) {
  const def = TYPES[type];
  if (!def) throw new HttpError(404, "Unknown entry type.");
  if (!isDate(body.date)) throw new HttpError(400, "Pick a valid date.");
  const client_id = cleanClientId(body.client_id);
  const row = { date: body.date, ...def.clean(body), client_id };
  const cols = [...def.columns, "client_id"];
  // A repeat of a save that already went through changes nothing and returns the original.
  const sql = `INSERT INTO ${type} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(client_id) DO NOTHING`;
  const res = await env.DB.prepare(sql).bind(...cols.map((c) => row[c] ?? null)).run();
  if (client_id) return env.DB.prepare(`SELECT * FROM ${type} WHERE client_id = ?`).bind(client_id).first();
  return env.DB.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(res.meta?.last_row_id).first();
}

async function updateEntry(env, type, id, body) {
  const def = TYPES[type];
  if (!def) throw new HttpError(404, "Unknown entry type.");
  const existing = await env.DB.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(id).first();
  if (!existing) throw new HttpError(404, "Entry not found.");
  if (!isDate(body.date)) throw new HttpError(400, "Pick a valid date.");
  const row = { date: body.date, ...def.clean(body) };
  const cols = def.columns;
  await env.DB.prepare(`UPDATE ${type} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => row[c] ?? null), id)
    .run();
  if (existing.photo_key && existing.photo_key !== row.photo_key) await env.PHOTOS.delete(existing.photo_key);
  return env.DB.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(id).first();
}

async function deleteEntry(env, type, id) {
  if (!TYPES[type]) throw new HttpError(404, "Unknown entry type.");
  const row = await env.DB.prepare(`SELECT * FROM ${type} WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, "Entry not found.");
  await env.DB.prepare(`DELETE FROM ${type} WHERE id = ?`).bind(id).run();
  if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
  return { ok: true };
}

// ---------- workouts ----------

function parseLift(row) {
  let sets = [];
  try {
    sets = JSON.parse(row.sets_json);
  } catch {}
  const { sets_json, ...rest } = row;
  return {
    ...rest,
    kind: KINDS.includes(row.kind) ? row.kind : "weight_reps",
    sets: sets.map((s) => ({ type: SET_TYPES.includes(s.type) ? s.type : "n", w: s.w ?? 0, r: s.r ?? null, t: s.t ?? null })),
  };
}

function cleanSet(s, kind, exName) {
  const type = SET_TYPES.includes(s?.type) ? s.type : "n";
  const w = num(s?.w, { min: 0, max: 2000 }) ?? 0;
  if (kind === "time") {
    const t = num(s?.t, { min: 0, max: 86400 });
    if (!t) throw new HttpError(400, `Each set of ${exName} needs a time.`);
    return { type, w, t: Math.round(t) };
  }
  const r = num(s?.r, { min: 0, max: 1000 });
  if (!r) throw new HttpError(400, `Each set of ${exName} needs reps.`);
  return { type, w, r };
}

function cleanWorkout(b) {
  if (!isDate(b.date)) throw new HttpError(400, "Pick a valid date.");
  const list = Array.isArray(b.exercises) ? b.exercises : [];
  if (!list.length) throw new HttpError(400, "Add at least one exercise.");
  if (list.length > 40) throw new HttpError(400, "That's more than 40 exercises.");
  const exercises = list.map((e, i) => {
    const name = text(e?.name, 100);
    if (!name) throw new HttpError(400, "Each exercise needs a name.");
    const kind = KINDS.includes(e.kind) ? e.kind : "weight_reps";
    const raw = Array.isArray(e.sets) ? e.sets : [];
    if (!raw.length) throw new HttpError(400, `${name} has no sets.`);
    if (raw.length > 50) throw new HttpError(400, `${name} has more than 50 sets.`);
    return {
      exercise_id: e.exercise_id ? String(e.exercise_id).slice(0, 150) : null,
      name,
      kind,
      notes: text(e.notes, 1000),
      position: i,
      sets: raw.map((s) => cleanSet(s, kind, name)),
    };
  });
  const started = Number(b.started_at);
  const dur = num(b.duration_sec, { min: 0, max: 86400 });
  return {
    client_id: cleanClientId(b.client_id),
    date: b.date,
    name: text(b.name, 80) || "Workout",
    notes: text(b.notes, 1000),
    started_at: Number.isFinite(started) && started > 0 ? Math.round(started) : null,
    duration_sec: dur == null ? null : Math.round(dur),
    exercises,
  };
}

const keyOf = (e) => e.exercise_id || e.name;

// Best values from a list of sets, ignoring warm-ups.
function bests(kind, sets) {
  const b = { e1rm: 0, weight: 0, reps: 0, time: 0 };
  for (const s of sets) {
    if (s.type === "w") continue;
    if (kind === "time") b.time = Math.max(b.time, s.t || 0);
    else {
      if (s.w > 0) {
        b.e1rm = Math.max(b.e1rm, e1rm(s.w, s.r || 0));
        b.weight = Math.max(b.weight, s.w);
      } else b.reps = Math.max(b.reps, s.r || 0);
    }
  }
  return b;
}

async function findPRs(env, w, excludeId) {
  if (!w.exercises.length) return [];
  const stmts = w.exercises.map((e) =>
    env.DB.prepare(
      `SELECT sets_json, kind FROM lifts WHERE ((exercise_id IS NOT NULL AND exercise_id = ?) OR (exercise_id IS NULL AND exercise = ?))
       AND date <= ? AND (workout_id IS NULL OR workout_id != ?)`
    ).bind(e.exercise_id || "", e.name, w.date, excludeId || 0)
  );
  const results = await env.DB.batch(stmts);
  const prs = [];
  w.exercises.forEach((e, i) => {
    const rows = (results[i].results || []).map(parseLift);
    if (!rows.length) return; // first time doing it: nothing to beat yet
    const prev = bests(e.kind, rows.flatMap((r) => r.sets));
    const now = bests(e.kind, e.sets);
    if (now.e1rm > prev.e1rm + 0.01) prs.push({ exercise: e.name, label: "Best estimated 1-rep max", value: round(now.e1rm), unit: "weight" });
    if (now.weight > prev.weight) prs.push({ exercise: e.name, label: "Heaviest weight", value: now.weight, unit: "weight" });
    if (now.reps > prev.reps) prs.push({ exercise: e.name, label: "Most reps", value: now.reps, unit: "reps" });
    if (now.time > prev.time) prs.push({ exercise: e.name, label: "Longest time", value: now.time, unit: "sec" });
  });
  return prs;
}

function liftInserts(env, w, workoutIdSql, workoutIdParam) {
  return w.exercises.map((e) =>
    env.DB.prepare(
      `INSERT INTO lifts (workout_id, position, date, exercise_id, exercise, kind, sets_json, notes) VALUES (${workoutIdSql}, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(...(workoutIdParam != null ? [workoutIdParam] : []), e.position, w.date, e.exercise_id, e.name, e.kind, JSON.stringify(e.sets), e.notes)
  );
}

// The workout already saved under this client_id, if this request is a repeat of it.
async function alreadySaved(env, w) {
  if (!w.client_id) return null;
  const row = await env.DB.prepare("SELECT id FROM workouts WHERE client_id = ?").bind(w.client_id).first();
  return row ? { workout: await getWorkout(env, row.id), prs: [] } : null;
}

async function createWorkout(env, body) {
  const w = cleanWorkout(body);
  const repeat = await alreadySaved(env, w);
  if (repeat) return repeat;
  const prs = await findPRs(env, w, 0);
  let results;
  try {
    // One atomic batch: the workout and all its exercises are saved together or not at all.
    results = await env.DB.batch([
      env.DB.prepare("INSERT INTO workouts (date, name, started_at, duration_sec, notes, client_id) VALUES (?, ?, ?, ?, ?, ?)").bind(
        w.date,
        w.name,
        w.started_at,
        w.duration_sec,
        w.notes,
        w.client_id
      ),
      ...liftInserts(env, w, "(SELECT MAX(id) FROM workouts)", null),
    ]);
  } catch (err) {
    // Two copies of the same save arrived together and the other one won.
    const saved = await alreadySaved(env, w);
    if (saved) return saved;
    throw err;
  }
  return { workout: await getWorkout(env, results[0].meta.last_row_id), prs };
}

async function updateWorkout(env, id, body) {
  const existing = await env.DB.prepare("SELECT id FROM workouts WHERE id = ?").bind(id).first();
  if (!existing) throw new HttpError(404, "Workout not found.");
  const w = cleanWorkout(body);
  const prs = await findPRs(env, w, id);
  await env.DB.batch([
    env.DB.prepare("UPDATE workouts SET date = ?, name = ?, started_at = ?, duration_sec = ?, notes = ? WHERE id = ?").bind(
      w.date,
      w.name,
      w.started_at,
      w.duration_sec,
      w.notes,
      id
    ),
    env.DB.prepare("DELETE FROM lifts WHERE workout_id = ?").bind(id),
    ...liftInserts(env, w, "?", id),
  ]);
  return { workout: await getWorkout(env, id), prs };
}

async function getWorkout(env, id) {
  const [w, lifts] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM workouts WHERE id = ?").bind(id),
    env.DB.prepare("SELECT * FROM lifts WHERE workout_id = ? ORDER BY position, id").bind(id),
  ]);
  const row = w.results?.[0];
  if (!row) throw new HttpError(404, "Workout not found.");
  return { ...row, exercises: (lifts.results || []).map(parseLift) };
}

async function deleteWorkout(env, id) {
  const existing = await env.DB.prepare("SELECT id FROM workouts WHERE id = ?").bind(id).first();
  if (!existing) throw new HttpError(404, "Workout not found.");
  await env.DB.batch([env.DB.prepare("DELETE FROM lifts WHERE workout_id = ?").bind(id), env.DB.prepare("DELETE FROM workouts WHERE id = ?").bind(id)]);
  return { ok: true };
}

// ---------- ranges ----------

async function listRange(env, from, to) {
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, "from and to must be dates.");
  const simple = Object.keys(TYPES);
  const results = await env.DB.batch([
    env.DB.prepare("SELECT * FROM workouts WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 1000").bind(from, to),
    env.DB.prepare("SELECT * FROM lifts WHERE date BETWEEN ? AND ? ORDER BY position, id LIMIT 20000").bind(from, to),
    ...simple.map((t) => env.DB.prepare(`SELECT * FROM ${t} WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 2000`).bind(from, to)),
  ]);
  const byWorkout = new Map();
  for (const l of (results[1].results || []).map(parseLift)) {
    if (!byWorkout.has(l.workout_id)) byWorkout.set(l.workout_id, []);
    byWorkout.get(l.workout_id).push(l);
  }
  const out = { workouts: (results[0].results || []).map((w) => ({ ...w, exercises: byWorkout.get(w.id) || [] })) };
  simple.forEach((t, i) => (out[t] = results[i + 2].results || []));
  return out;
}

// ---------- settings ----------

const SETTING_KEYS = ["goal", "calorie_target", "protein_target", "unit", "bodyweight_goal"];

async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const s = { unit: "kg" };
  for (const r of results || []) s[r.key] = r.value;
  return s;
}

// Switching between kg and lb rewrites every logged weight, so each number keeps its real meaning.
function convertWeights(env, factor) {
  return [
    env.DB.prepare("UPDATE body SET weight = round(weight * ?, 2) WHERE weight IS NOT NULL").bind(factor),
    env.DB.prepare(
      `UPDATE lifts SET sets_json = (
         SELECT json_group_array(json_set(s.value, '$.w', round(json_extract(s.value, '$.w') * ?, 2)))
         FROM json_each(lifts.sets_json) AS s
       )`
    ).bind(factor),
    env.DB.prepare("UPDATE settings SET value = CAST(round(CAST(value AS REAL) * ?, 2) AS TEXT) WHERE key = 'bodyweight_goal' AND value IS NOT NULL").bind(factor),
  ];
}

async function saveSettings(env, body) {
  const before = (await getSettings(env)).unit || "kg";
  const after = "unit" in body ? (body.unit === "lb" ? "lb" : "kg") : before;
  const stmts = [];
  for (const k of SETTING_KEYS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === "unit") v = v === "lb" ? "lb" : "kg";
    else if (k === "goal") v = text(v, 600);
    else v = num(v, { min: 0, max: 100000 });
    stmts.push(
      env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(
        k,
        v === null ? null : String(v)
      )
    );
  }
  if (after !== before) stmts.push(...convertWeights(env, after === "lb" ? LB_PER_KG : 1 / LB_PER_KG));
  if (stmts.length) await env.DB.batch(stmts);
  return getSettings(env);
}

// ---------- photos ----------

async function uploadPhoto(request, env, url) {
  const kind = url.searchParams.get("kind") === "body" ? "body" : "meal";
  const date = url.searchParams.get("date");
  if (!isDate(date)) throw new HttpError(400, "Pick a valid date.");
  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
  if (!ext) throw new HttpError(415, "Photos must be JPEG, PNG or WebP.");
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_PHOTO_BYTES) throw new HttpError(413, "Photo is larger than 8 MB.");
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, "The photo was empty.");
  if (buf.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, "Photo is larger than 8 MB.");
  const key = `${kind}/${date}/${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
  return json({ key });
}

async function servePhoto(env, key) {
  if (!PHOTO_KEY_RE.test(key)) return fail(404, "Photo not found.");
  const obj = await env.PHOTOS.get(key);
  if (!obj) return fail(404, "Photo not found.");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

// ---------- exercise library ----------

async function libraryData(env) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=604800" };
  const obj = await env.PHOTOS.get(LIB_KEY);
  if (obj) return new Response(obj.body, { headers });
  let res;
  try {
    res = await fetch(LIB_BASE + "dist/exercises.json");
  } catch {
    throw new HttpError(502, "Couldn't download the exercise list. Try again in a minute.");
  }
  if (!res.ok) throw new HttpError(502, "Couldn't download the exercise list. Try again in a minute.");
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 100 || new Uint8Array(buf)[0] !== 0x5b /* [ */) throw new HttpError(502, "The exercise list download was incomplete. Try again.");
  await env.PHOTOS.put(LIB_KEY, buf, { httpMetadata: { contentType: "application/json" } });
  return new Response(buf, { headers });
}

async function libraryImage(env, id, n) {
  if (!LIB_ID_RE.test(id) || id.includes("..")) return fail(404, "Image not found.");
  const key = `library/img/${id}/${n}.jpg`;
  const headers = { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" };
  const obj = await env.PHOTOS.get(key);
  if (obj) return new Response(obj.body, { headers });
  let res;
  try {
    res = await fetch(`${LIB_BASE}exercises/${encodeURIComponent(id)}/${n}.jpg`);
  } catch {
    return fail(502, "Couldn't load the image.");
  }
  if (!res.ok) return fail(404, "Image not found.");
  const buf = await res.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 3 * 1024 * 1024) return fail(502, "Couldn't load the image.");
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: "image/jpeg" } });
  return new Response(buf, { headers });
}

async function createCustomExercise(env, b) {
  const name = text(b.name, 80);
  if (!name) throw new HttpError(400, "Enter a name for the exercise.");
  const kind = KINDS.includes(b.kind) ? b.kind : "weight_reps";
  const muscle = MUSCLES.includes(b.muscle) ? b.muscle : null;
  const equipment = EQUIPMENT.includes(b.equipment) ? b.equipment : null;
  const dupe = await env.DB.prepare("SELECT id FROM custom_exercises WHERE lower(name) = lower(?)").bind(name).first();
  if (dupe) throw new HttpError(409, `You already have an exercise called "${name}".`);
  const r = await env.DB.prepare("INSERT INTO custom_exercises (name, kind, muscle, equipment) VALUES (?, ?, ?, ?)").bind(name, kind, muscle, equipment).run();
  return env.DB.prepare("SELECT * FROM custom_exercises WHERE id = ?").bind(r.meta.last_row_id).first();
}

// ---------- weekly AI review ----------

const e1rm = (w, r) => (r <= 1 ? w : w * (1 + r / 30)); // Epley estimate

function round(n, d = 1) {
  return n == null ? null : Math.round(n * 10 ** d) / 10 ** d;
}

const flatLifts = (range) => range.workouts.flatMap((w) => w.exercises.map((e) => ({ ...e, date: w.date })));

async function buildWeekSummary(env, start) {
  const end = addDays(start, 6);
  const histStart = addDays(start, -28);
  const [week, hist, settings] = await Promise.all([listRange(env, start, end), listRange(env, histStart, addDays(start, -1)), getSettings(env)]);
  const unit = settings.unit || "kg";

  // Lifting (warm-up sets are left out of volume and records)
  const histBest = {};
  for (const l of flatLifts(hist)) {
    const b = bests(l.kind, l.sets);
    const h = (histBest[l.exercise] ||= { e1rm: 0, reps: 0, time: 0 });
    h.e1rm = Math.max(h.e1rm, b.e1rm);
    h.reps = Math.max(h.reps, b.reps);
    h.time = Math.max(h.time, b.time);
  }
  const byEx = {};
  for (const l of flatLifts(week)) {
    const e = (byEx[l.exercise] ||= { kind: l.kind, sessions: new Set(), working: 0, warmup: 0, drop: 0, failure: 0, volume: 0, best: null, bestE1rm: 0, maxReps: 0, maxTime: 0, notes: [] });
    e.sessions.add(l.date);
    for (const s of l.sets) {
      if (s.type === "w") {
        e.warmup++;
        continue;
      }
      e.working++;
      if (s.type === "d") e.drop++;
      if (s.type === "f") e.failure++;
      if (l.kind === "time") e.maxTime = Math.max(e.maxTime, s.t || 0);
      else {
        e.volume += (s.w || 0) * (s.r || 0);
        if (s.w > 0) {
          const est = e1rm(s.w, s.r);
          if (est > e.bestE1rm) {
            e.bestE1rm = est;
            e.best = `${s.w}${unit} x ${s.r}`;
          }
        } else e.maxReps = Math.max(e.maxReps, s.r || 0);
      }
    }
    if (l.notes) e.notes.push(l.notes);
  }
  const lifting = Object.entries(byEx).map(([name, e]) => {
    const prev = histBest[name];
    const out = { exercise: name, sessions: e.sessions.size, working_sets: e.working, warmup_sets: e.warmup };
    if (e.drop) out.drop_sets = e.drop;
    if (e.failure) out.failure_sets = e.failure;
    if (e.kind === "time") {
      out.longest_hold_sec = e.maxTime;
      out.prev_4wk_longest_sec = prev?.time || "no history";
    } else if (e.bestE1rm) {
      out.volume = Math.round(e.volume);
      out.best_set = e.best;
      out.est_1rm = round(e.bestE1rm);
      out.prev_4wk_best_est_1rm = prev?.e1rm ? round(prev.e1rm) : "no history";
    } else {
      out.max_reps = e.maxReps;
      out.prev_4wk_max_reps = prev?.reps || "no history";
    }
    if (e.notes.length) out.notes = e.notes.slice(0, 3).map((n) => n.slice(0, 160));
    return out;
  });
  const workouts = week.workouts.map((w) => ({
    date: w.date,
    name: w.name,
    minutes: w.duration_sec ? Math.round(w.duration_sec / 60) : "not timed",
    exercises: w.exercises.length,
  }));

  // Cardio
  const cardio = {};
  for (const c of week.cardio) {
    const a = (cardio[c.activity] ||= { sessions: 0, minutes: 0, km: 0, calories: 0 });
    a.sessions++;
    a.minutes += c.minutes || 0;
    a.km += c.distance_km || 0;
    a.calories += c.calories || 0;
  }
  for (const a of Object.values(cardio)) {
    a.minutes = round(a.minutes);
    a.km = round(a.km, 2);
    a.calories = Math.round(a.calories);
  }
  const histCardioMin = hist.cardio.reduce((t, c) => t + (c.minutes || 0), 0);

  // Diet
  const days = {};
  for (const m of week.meals) {
    const d = (days[m.date] ||= { calories: 0, protein_g: 0, meals: 0, with_numbers: 0, items: [] });
    d.meals++;
    if (m.calories != null || m.protein_g != null) d.with_numbers++;
    d.calories += m.calories || 0;
    d.protein_g += m.protein_g || 0;
    const label = [m.meal, m.description].filter(Boolean).join(": ");
    if (label) d.items.push(label.slice(0, 90) + (m.photo_key && !m.description ? " (photo only)" : ""));
  }
  const diet = Object.entries(days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      meals_logged: d.meals,
      calories: d.with_numbers ? Math.round(d.calories) : "not counted",
      protein_g: d.with_numbers ? Math.round(d.protein_g) : "not counted",
      items: d.items.slice(0, 6),
    }));

  // Body
  const bodyWeek = [...week.body].sort((a, b) => a.date.localeCompare(b.date));
  const weights = bodyWeek.filter((b) => b.weight != null).map((b) => ({ date: b.date, weight: b.weight }));
  const histWeights = hist.body.filter((b) => b.weight != null).map((b) => b.weight);
  const body = {
    weigh_ins: weights,
    prev_4wk_avg_weight: histWeights.length ? round(histWeights.reduce((a, b) => a + b, 0) / histWeights.length) : "no history",
    body_fat: bodyWeek.filter((b) => b.body_fat != null).map((b) => ({ date: b.date, pct: b.body_fat })),
    waist_cm: bodyWeek.filter((b) => b.waist_cm != null).map((b) => ({ date: b.date, cm: b.waist_cm })),
    progress_photos_taken: bodyWeek.filter((b) => b.photo_key).length,
  };

  const trainingDays = new Set([...week.workouts.map((w) => w.date), ...week.cardio.map((c) => c.date)]);
  const histTrainingDays = new Set([...hist.workouts.map((w) => w.date), ...hist.cardio.map((c) => c.date)]);

  const summary = {
    week: `${start} to ${end}`,
    weight_unit: unit,
    goals: {
      goal: settings.goal || "not set",
      calorie_target: settings.calorie_target || "not set",
      protein_target_g: settings.protein_target || "not set",
      bodyweight_goal: settings.bodyweight_goal || "not set",
    },
    training_days: trainingDays.size,
    prev_4wk_avg_training_days_per_week: round(histTrainingDays.size / 4),
    workouts,
    lifting,
    cardio,
    prev_4wk_avg_cardio_minutes_per_week: round(histCardioMin / 4),
    diet_days_logged: diet.length,
    diet,
    body,
  };
  const empty = !week.workouts.length && !week.cardio.length && !week.meals.length && !week.body.length;
  return { start, end, summary, empty };
}

const SYSTEM_PROMPT = `You are a supportive, no-nonsense strength and nutrition coach reviewing one person's training log for the week.
Write in plain English for someone reading on a phone. Use short Markdown: "## " headings and "- " bullets, at most about 300 words.
Sections, in order:
## The week in one line
## Wins
## Watch-outs
## Next week
Rules:
- Only use numbers that appear in the data. Never invent lifts, weights, calories or dates.
- Warm-up sets are already excluded from volume and records. Drop sets and failure sets are counted as working sets.
- Compare against the previous 4 weeks where history exists; call out new estimated 1RM, rep or hold-time highs as PRs.
- If something wasn't logged (for example no calories counted), say so briefly instead of guessing.
- Relate advice to their stated goal and targets when set.
- Give 2–4 specific, doable actions for next week.
- No medical diagnoses. If something looks risky (very low calories, sharp weight change, pain in notes), suggest checking with a professional.`;

async function callOpenAI(env, summary) {
  const model = env.OPENAI_MODEL || DEFAULT_MODEL;
  const base = {
    model,
    instructions: SYSTEM_PROMPT,
    input: "Here is my log for the week as JSON:\n" + JSON.stringify(summary),
    max_output_tokens: 2500, // covers the model's reasoning as well as the review itself
    store: false, // health logs aren't kept on OpenAI's servers as stored responses
  };
  const attempt = (body) =>
    fetch(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let res = await attempt({ ...base, reasoning: { effort: "low" } });
  if (res.status === 400) res = await attempt(base); // the chosen model doesn't support reasoning settings
  if (!res.ok) {
    const raw = await res.text();
    let err = {};
    try {
      err = JSON.parse(raw).error || {};
    } catch {}
    if (res.status === 401) throw new HttpError(502, "OpenAI rejected the API key. Check the OPENAI_API_KEY secret.");
    if (res.status === 429) {
      const outOfCredit = err.type === "insufficient_quota" || /credit|spend_limit|usage_limit/.test(err.code || "");
      throw new HttpError(429, outOfCredit ? "Your OpenAI credit or spending limit has run out. Add credit in your OpenAI account, then try again." : "OpenAI is busy right now. Try again in a minute.");
    }
    throw new HttpError(502, `The AI service returned an error (${res.status}): ${err.message || raw.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = (data.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("")
    .trim();
  // A half-finished review shouldn't replace a good one.
  if (!content || data.incomplete_details) throw new HttpError(502, "The AI didn't finish the review. Try again.");
  return { content, model };
}

async function generateReview(env, start) {
  if (!env.OPENAI_API_KEY) throw new HttpError(400, "AI reviews are off. Add the OPENAI_API_KEY secret to turn them on.");
  const { end, summary, empty } = await buildWeekSummary(env, start);
  if (empty) throw new HttpError(400, "Nothing is logged for that week yet.");
  const { content, model } = await callOpenAI(env, summary);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews WHERE week_start = ?").bind(start),
    env.DB.prepare("INSERT INTO reviews (week_start, week_end, content, model) VALUES (?, ?, ?, ?)").bind(start, end, content, model),
  ]);
  return env.DB.prepare("SELECT * FROM reviews WHERE week_start = ?").bind(start).first();
}

// ---------- export ----------

async function exportAll(env) {
  const tables = ["workouts", "lifts", "custom_exercises", ...Object.keys(TYPES), "reviews", "settings"];
  const results = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`)));
  const out = { exported_at: new Date().toISOString() };
  tables.forEach((t, i) => (out[t] = results[i].results || []));
  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="repwise-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}

// ---------- router ----------

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method;

  if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
    return fail(500, "Setup isn't finished: add the APP_PASSWORD and SESSION_SECRET secrets, then deploy again.");
  }

  // Requests that change data must come from the app itself (blocks cross-site form posts).
  if (method !== "GET" && method !== "HEAD" && request.headers.get("x-gymlog") !== "1") {
    return fail(403, "Blocked request.");
  }

  await ensureSchema(env);

  if (path === "/login" && method === "POST") return handleLogin(request, env);
  if (path === "/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

  if (!(await isLoggedIn(request, env))) return fail(401, "Log in to continue.");

  if (path === "/me" && method === "GET") {
    return json({
      ok: true,
      ai: !!env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || DEFAULT_MODEL,
      timezone: env.TIMEZONE || "UTC",
      settings: await getSettings(env),
    });
  }

  if (path === "/settings" && method === "PUT") return json(await saveSettings(env, await readJson(request)));

  if (path === "/range" && method === "GET") {
    return json(await listRange(env, url.searchParams.get("from"), url.searchParams.get("to")));
  }

  // Last time you did each exercise (fills the "Previous" column) and how often you've done it.
  if (path === "/exercises" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM (
         SELECT l.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(l.exercise_id, l.exercise) ORDER BY l.date DESC, l.id DESC) AS rn,
                COUNT(*) OVER (PARTITION BY COALESCE(l.exercise_id, l.exercise)) AS times
         FROM lifts l)
       WHERE rn = 1 ORDER BY date DESC, id DESC LIMIT 500`
    ).all();
    return json((results || []).map((r) => ({ ...parseLift(r), key: keyOf({ exercise_id: r.exercise_id, name: r.exercise }) })));
  }

  if (path === "/history" && method === "GET") {
    const key = text(url.searchParams.get("key"), 150);
    if (!key) throw new HttpError(400, "Pick an exercise.");
    const { results } = await env.DB.prepare(
      "SELECT * FROM lifts WHERE COALESCE(exercise_id, exercise) = ? ORDER BY date ASC, id ASC LIMIT 2000"
    )
      .bind(key)
      .all();
    return json((results || []).map(parseLift));
  }

  if (path === "/body-history" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM body ORDER BY date ASC, id ASC LIMIT 3000").all();
    return json(results || []);
  }

  let m;
  if (path === "/workouts" && method === "POST") return json(await createWorkout(env, await readJson(request)), 201);
  if ((m = path.match(/^\/workouts\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "GET") return json(await getWorkout(env, id));
    if (method === "PUT") return json(await updateWorkout(env, id, await readJson(request)));
    if (method === "DELETE") return json(await deleteWorkout(env, id));
  }

  if (path === "/library/data" && method === "GET") return libraryData(env);
  if ((m = path.match(/^\/library\/img\/([^/]+)\/([0-9])\.jpg$/)) && method === "GET") {
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return fail(404, "Image not found.");
    }
    return libraryImage(env, id, m[2]);
  }

  if (path === "/custom-exercises" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM custom_exercises ORDER BY name COLLATE NOCASE").all();
    return json(results || []);
  }
  if (path === "/custom-exercises" && method === "POST") return json(await createCustomExercise(env, await readJson(request)), 201);
  if ((m = path.match(/^\/custom-exercises\/(\d+)$/)) && method === "DELETE") {
    await env.DB.prepare("DELETE FROM custom_exercises WHERE id = ?").bind(Number(m[1])).run();
    return json({ ok: true });
  }

  if ((m = path.match(/^\/entries\/(\w+)$/)) && method === "POST") {
    return json(await createEntry(env, m[1], await readJson(request)), 201);
  }
  if ((m = path.match(/^\/entries\/(\w+)\/(\d+)$/))) {
    if (method === "PUT") return json(await updateEntry(env, m[1], Number(m[2]), await readJson(request)));
    if (method === "DELETE") return json(await deleteEntry(env, m[1], Number(m[2])));
  }

  if (path === "/photos" && method === "POST") return uploadPhoto(request, env, url);
  if ((m = path.match(/^\/photos\/(.+)$/)) && method === "GET") return servePhoto(env, decodeURIComponent(m[1]));

  if (path === "/reviews" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM reviews ORDER BY week_start DESC LIMIT 52").all();
    return json(results || []);
  }
  if (path === "/reviews" && method === "POST") {
    const body = await readJson(request);
    const today = isDate(body.today) ? body.today : todayIn(env.TIMEZONE);
    let start = isDate(body.week_start) ? weekStart(body.week_start) : weekStart(today);
    if (body.which === "last") start = addDays(weekStart(today), -7);
    return json(await generateReview(env, start), 201);
  }

  if (path === "/export" && method === "GET") return exportAll(env);

  return fail(404, "Not found.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return fail(err.status, err.message);
        console.error(err);
        return fail(500, "Something went wrong on the server: " + (err?.message || err));
      }
    }
    // Everything else is a static file from /public.
    return env.ASSETS.fetch(request);
  },

  // Runs on the schedule in wrangler.jsonc (Sunday evening) and reviews the week that's ending.
  async scheduled(event, env, ctx) {
    if (!env.OPENAI_API_KEY) return;
    const start = weekStart(todayIn(env.TIMEZONE));
    ctx.waitUntil(
      ensureSchema(env)
        .then(() => generateReview(env, start))
        .catch((err) => console.log("Weekly review skipped:", err.message))
    );
  },
};

// Exported for local tests.
export const _internal = { weekStart, addDays, todayIn, buildWeekSummary, e1rm, resetSchema: () => (schemaReady = null) };
