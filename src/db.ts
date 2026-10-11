import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/kkal.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  goal       INTEGER NOT NULL DEFAULT 2000,
  created_at INTEGER NOT NULL
);
-- one-time links: 'invite' creates a new user, 'login' signs an existing user in on another device
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('invite','login')),
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
-- one row per user per day; data = {"entries":[...]} exactly as the client renders it
CREATE TABLE IF NOT EXISTS days (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
-- app-wide settings edited by admins in the UI (override .env)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
`);

export const getSetting = (key: string): string | undefined =>
  (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
export function setSetting(key: string, value: string | null) {
  if (value === null) db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  else db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

export const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");
export const now = () => Date.now();

export type User = { id: number; name: string; is_admin: number; goal: number };

const DAY = 24 * 3600 * 1000;

export function createLink(opts: {
  kind: "invite" | "login";
  userId?: number;
  name?: string;
  isAdmin?: boolean;
  createdBy?: number;
}): string {
  const token = newToken();
  const ttl = opts.kind === "invite" ? 7 * DAY : 15 * 60 * 1000;
  db.prepare(
    `INSERT INTO tokens (token_hash, kind, user_id, name, is_admin, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(hash(token), opts.kind, opts.userId ?? null, opts.name ?? null, opts.isAdmin ? 1 : 0, opts.createdBy ?? null, now() + ttl);
  return token;
}

/** Consume a one-time link. Returns the user it signs in, or null if invalid/used/expired. */
export const consumeLink = db.transaction((token: string): User | null => {
  const row = db.prepare(`SELECT * FROM tokens WHERE token_hash = ?`).get(hash(token)) as any;
  if (!row || row.used_at || row.expires_at < now()) return null;
  db.prepare(`UPDATE tokens SET used_at = ? WHERE token_hash = ?`).run(now(), row.token_hash);
  if (row.kind === "login") {
    return (db.prepare(`SELECT id, name, is_admin, goal FROM users WHERE id = ?`).get(row.user_id) as User) ?? null;
  }
  const info = db
    .prepare(`INSERT INTO users (name, is_admin, created_at) VALUES (?, ?, ?)`)
    .run(row.name || "Пользователь", row.is_admin, now());
  return db.prepare(`SELECT id, name, is_admin, goal FROM users WHERE id = ?`).get(info.lastInsertRowid) as User;
});

export function createSession(userId: number): string {
  const token = newToken();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)`).run(hash(token), userId, now(), now());
  return token;
}

export function userBySession(token: string | undefined): User | null {
  if (!token) return null;
  const h = hash(token);
  const u = db
    .prepare(`SELECT u.id, u.name, u.is_admin, u.goal FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .get(h) as User | undefined;
  if (u) db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).run(now(), h);
  return u ?? null;
}

export const deleteSession = (token: string) => db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hash(token));

export function getDays(userId: number, from: string, to: string): Record<string, unknown> {
  const rows = db
    .prepare(`SELECT date, data FROM days WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`)
    .all(userId, from, to) as { date: string; data: string }[];
  return Object.fromEntries(rows.map((r) => [r.date, JSON.parse(r.data)]));
}

export function putDay(userId: number, date: string, data: unknown) {
  db.prepare(
    `INSERT INTO days (user_id, date, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(userId, date, JSON.stringify(data), now());
}

/** Atomically count one recognition; returns false when the daily limit is reached. */
export const takeUsage = db.transaction((userId: number, date: string, limit: number): boolean => {
  const row = db.prepare(`SELECT count FROM usage WHERE user_id = ? AND date = ?`).get(userId, date) as { count: number } | undefined;
  if ((row?.count ?? 0) >= limit) return false;
  db.prepare(
    `INSERT INTO usage (user_id, date, count) VALUES (?, ?, 1)
     ON CONFLICT (user_id, date) DO UPDATE SET count = count + 1`
  ).run(userId, date);
  return true;
});
