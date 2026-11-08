-- RepWise database schema (Cloudflare D1 / SQLite).
-- You do not need to run this: the app creates these tables itself the first time it starts.
-- It is here for reference and for `npm run db:init` if you prefer.

CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, name TEXT, started_at INTEGER, duration_sec INTEGER, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_client ON workouts(client_id);
CREATE TABLE IF NOT EXISTS lifts (id INTEGER PRIMARY KEY AUTOINCREMENT, workout_id INTEGER, position INTEGER DEFAULT 0, date TEXT NOT NULL, exercise_id TEXT, exercise TEXT NOT NULL, kind TEXT DEFAULT 'weight_reps', sets_json TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_lifts_date ON lifts(date);
CREATE INDEX IF NOT EXISTS idx_lifts_workout ON lifts(workout_id);
CREATE INDEX IF NOT EXISTS idx_lifts_key ON lifts(exercise_id, exercise);
CREATE TABLE IF NOT EXISTS custom_exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'weight_reps', muscle TEXT, equipment TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cardio (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, activity TEXT NOT NULL, minutes REAL, distance_km REAL, calories REAL, avg_hr REAL, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_cardio_date ON cardio(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cardio_client ON cardio(client_id);
CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, meal TEXT NOT NULL, description TEXT, calories REAL, protein_g REAL, photo_key TEXT, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meals_client ON meals(client_id);
CREATE TABLE IF NOT EXISTS body (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, weight REAL, body_fat REAL, waist_cm REAL, photo_key TEXT, notes TEXT, client_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_body_date ON body(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_body_client ON body(client_id);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, week_start TEXT NOT NULL, week_end TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_reviews_week ON reviews(week_start);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, at);
