import { randomInt, timingSafeEqual } from "node:crypto";
import { db, hash, now, newToken, User, USER_COLS } from "./db.js";
import { conf, confNum } from "./config.js";

const CODE_TTL = 10 * 60 * 1000;
const RESEND_AFTER = 60 * 1000;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

/*
 * Temporary fixed code for one address (e.g. while SMTP is not set up).
 * STATIC_LOGIN_CODE=6 digits; STATIC_LOGIN_EMAIL defaults to ADMIN_EMAIL.
 */
const STATIC_EMAIL = (process.env.STATIC_LOGIN_EMAIL || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const staticCode = () => conf("static_login_code").trim();
export const staticCodeEnabled = () => /^\d{6}$/.test(staticCode()) && !!STATIC_EMAIL;
export const staticCodeEmail = () => STATIC_EMAIL;
export function isStaticCode(email: string, code: string): boolean {
  if (!staticCodeEnabled() || email !== STATIC_EMAIL) return false;
  const a = Buffer.from(code), b = Buffer.from(staticCode());
  return a.length === b.length && timingSafeEqual(a, b);
}

/* Failed code entries per address, across all codes (in memory): 10 per hour. */
const fails = new Map<string, number[]>();
export function verifyGuard(email: string) {
  const t = Date.now(), list = (fails.get(email) || []).filter((x) => t - x < 3600_000);
  fails.set(email, list);
  if (list.length >= 10) throw new AuthError("Слишком много неверных кодов. Попробуй через час.", 429, 3600);
}
export const verifyFailed = (email: string) => { fails.set(email, [...(fails.get(email) || []), Date.now()]); };
export const verifyOk = (email: string) => { fails.delete(email); };

export const normEmail = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
export const isEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export const userByEmail = (email: string) =>
  db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`).get(email) as User | undefined;

const userCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
const isInvited = (email: string) => !!db.prepare(`SELECT 1 FROM email_invites WHERE email = ?`).get(email);

export class AuthError extends Error {
  constructor(message: string, public statusCode = 400, public retryAfter?: number) { super(message); }
}

/**
 * Invite-only: may this address receive a code? Allowed are existing users, invited
 * addresses, ADMIN_EMAIL, and anyone while the app has no users yet (first admin).
 * `attachTo` is a signed-in user adding an email to an account made by an invite link.
 */
export function checkAllowed(email: string, attachTo: User | null) {
  const u = userByEmail(email);
  if (u) {
    if (u.disabled) throw new AuthError("Этот аккаунт заблокирован. Напиши администратору.", 403);
    if (attachTo && u.id !== attachTo.id) throw new AuthError("Этот email уже привязан к другому аккаунту.", 409);
    return;
  }
  if (attachTo) return;
  // with ADMIN_EMAIL set, nobody else can claim the empty app first
  if (isInvited(email) || email === ADMIN_EMAIL || (userCount() === 0 && !ADMIN_EMAIL)) return;
  throw new AuthError("Вход только по приглашению. Попроси администратора пригласить этот email.", 403);
}

/** Create and store a fresh code; enforces resend delay and hourly limit per address. */
export const issueCode = db.transaction((email: string): string => {
  const row = db.prepare(`SELECT * FROM email_codes WHERE email = ?`).get(email) as any;
  const t = now();
  let windowStart = t, windowCount = 1;
  if (row) {
    const wait = row.sent_at + RESEND_AFTER - t;
    if (wait > 0) throw new AuthError(`Новый код можно запросить через ${Math.ceil(wait / 1000)} с`, 429, Math.ceil(wait / 1000));
    if (t - row.window_start < 3600_000) {
      windowStart = row.window_start; windowCount = row.window_count + 1;
      if (windowCount > MAX_PER_HOUR) throw new AuthError("Слишком много запросов кода. Попробуй через час.", 429, 3600);
    }
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at, window_start, window_count)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, sent_at = excluded.sent_at, window_start = excluded.window_start, window_count = excluded.window_count`
  ).run(email, hash(email + ":" + code), t + CODE_TTL, t, windowStart, windowCount);
  return code;
});

/**
 * Check a code. Wrong guesses are counted; after MAX_ATTEMPTS the code is burned.
 * The transaction returns a status instead of throwing: a throw would roll back
 * the attempt counter and allow unlimited guessing.
 */
const checkCodeTx = db.transaction((email: string, code: string): "ok" | "expired" | "locked" | number => {
  const row = db.prepare(`SELECT * FROM email_codes WHERE email = ?`).get(email) as any;
  if (!row || row.expires_at < now()) return "expired";
  if (row.attempts >= MAX_ATTEMPTS) return "locked";
  if (row.code_hash !== hash(email + ":" + code)) {
    db.prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?`).run(email);
    return MAX_ATTEMPTS - row.attempts - 1;
  }
  // keep the row (resend timing) but make the code unusable
  db.prepare(`UPDATE email_codes SET expires_at = 0 WHERE email = ?`).run(email);
  return "ok";
});

export function checkCode(email: string, code: string) {
  const r = checkCodeTx(email, code);
  if (r === "ok") return;
  if (r === "expired") throw new AuthError("Код устарел. Запроси новый.", 400);
  if (r === "locked") throw new AuthError("Слишком много неверных попыток. Запроси новый код.", 429);
  throw new AuthError(r > 0 ? `Неверный код. Осталось попыток: ${r}` : "Неверный код. Запроси новый.", 400);
}

/** After a valid code: find, attach or create the account. Returns the user to sign in. */
export const completeSignIn = db.transaction((email: string, attachTo: User | null): User => {
  checkAllowed(email, attachTo);
  const existing = userByEmail(email);
  if (existing) return existing;
  if (attachTo) {
    db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(email, attachTo.id);
    return { ...attachTo, email };
  }
  const first = userCount() === 0;
  const admin = first || email === ADMIN_EMAIL ? 1 : 0;
  const name = email.split("@")[0].slice(0, 60);
  const info = db.prepare(`INSERT INTO users (name, email, is_admin, goal, created_at) VALUES (?, ?, ?, ?, ?)`).run(name, email, admin, confNum("default_goal"), now());
  db.prepare(`DELETE FROM email_invites WHERE email = ?`).run(email);
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(info.lastInsertRowid) as User;
});

/** Simple per-IP limiter for code requests (in memory; resets on restart). */
const hits = new Map<string, number[]>();
export function ipLimit(ip: string, max = 20, windowMs = 3600_000) {
  const t = now();
  const list = (hits.get(ip) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) throw new AuthError("Слишком много попыток с этого адреса. Попробуй позже.", 429, 600);
  list.push(t); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
}

/**
 * Invite an address. Returns a fresh invite key for the link in the letter (a random key, not the
 * email itself, so nobody can put someone else's address into a link). Re-inviting rotates the key.
 */
export function inviteEmail(email: string, by: number): string {
  const token = newToken();
  db.prepare(
    `INSERT INTO email_invites (email, invited_by, created_at, token_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET token_hash = excluded.token_hash, invited_by = excluded.invited_by, created_at = excluded.created_at`
  ).run(email, by, now(), hash(token));
  return token;
}

/** Which address an invite link belongs to (null if the key is unknown or already used). */
export function inviteByToken(token: string): string | null {
  if (!token || token.length > 100) return null;
  const row = db.prepare(`SELECT email FROM email_invites WHERE token_hash = ?`).get(hash(token)) as { email: string } | undefined;
  return row?.email ?? null;
}
