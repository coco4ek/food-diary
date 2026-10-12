import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  db, User, createLink, consumeLink, createSession, userBySession, deleteSession,
  getDays, putDay, takeUsage, refundUsage, setSetting,
} from "./db.js";
import { estimate, llmConfig, testConnection } from "./llm.js";
import { conf, confNum, view as configView, update as configUpdate } from "./config.js";
import { AuthError, normEmail, isEmail, checkAllowed, issueCode, checkCode, completeSignIn, ipLimit, inviteEmail, inviteByToken, joinLink, createJoinLink, isStaticCode, staticCodeEnabled, staticCodeEmail, verifyGuard, verifyFailed, verifyOk } from "./auth.js";
import { sendCode, sendInvite, sendTest, mailConfigured } from "./mail.js";
import { updaterState, requestUpdate } from "./updater.js";

const PORT = Number(process.env.PORT || 3000);
// Read from settings on every use, so edits in the app apply without a restart
const baseUrl = () => conf("base_url").replace(/\/+$/, "");
const SID = "kkal_sid";
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" }, bodyLimit: 14 * 1024 * 1024, trustProxy: true });

await app.register(cookie);
await app.register(fastifyStatic, { root: PUBLIC_DIR, index: "index.html" });

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "same-origin");
  return payload;
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const linkUrl = (token: string) => `${baseUrl()}/i/${token}`;

declare module "fastify" { interface FastifyRequest { user: User } }

async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const u = userBySession(req.cookies[SID]);
  if (!u) return reply.code(401).send({ error: "Нужно войти" });
  req.user = u;
}

function setSession(reply: FastifyReply, userId: number) {
  reply.setCookie(SID, createSession(userId), {
    path: "/", httpOnly: true, sameSite: "lax", secure: baseUrl().startsWith("https://"), maxAge: 60 * 60 * 24 * 365,
  });
}

/* ---------- links: /i/<token> signs in (invite or another-device link) ---------- */
app.get<{ Params: { token: string } }>("/i/:token", async (req, reply) => {
  const user = consumeLink(req.params.token);
  if (!user) return reply.redirect("/?link=invalid");
  setSession(reply, user.id);
  return reply.redirect("/");
});

app.get("/healthz", async () => ({ ok: true }));

/* ---------- email sign-in: request a 6-digit code, then verify it ---------- */
const authFail = (reply: FastifyReply, e: any) => {
  if (e instanceof AuthError) {
    if (e.retryAfter) reply.header("retry-after", String(e.retryAfter));
    return reply.code(e.statusCode).send({ error: e.message, retryAfter: e.retryAfter });
  }
  throw e;
};

// invite link → which address to send the code to (so the person doesn't type it)
app.get<{ Querystring: { t?: string } }>("/api/auth/invite", async (req, reply) => {
  try { ipLimit(req.ip, 60); } catch (e) { return authFail(reply, e); }
  const email = inviteByToken(String(req.query.t || ""));
  if (!email) return reply.code(404).send({ error: "Приглашение не найдено или уже использовано. Войди по почте или попроси новое приглашение." });
  return { email };
});

// sign-up link from a messenger → who invited (the person then types their own email)
app.get<{ Querystring: { t?: string } }>("/api/auth/join", async (req, reply) => {
  try { ipLimit(req.ip, 60); } catch (e) { return authFail(reply, e); }
  const link = joinLink(String(req.query.t || ""));
  if (!link) return reply.code(404).send({ error: "Ссылка-приглашение недействительна: её отозвали, она уже использована или устарела. Попроси новую." });
  return { by: link.byName || "" };
});

app.post<{ Body: { email?: string; join?: string } }>("/api/auth/request", async (req, reply) => {
  const email = normEmail(req.body?.email);
  if (!isEmail(email)) return reply.code(400).send({ error: "Проверь адрес почты" });
  const current = userBySession(req.cookies[SID]);
  const attachTo = current && !current.email ? current : null;
  try {
    ipLimit(req.ip);
    checkAllowed(email, attachTo, typeof req.body?.join === "string" ? req.body.join : undefined);
    const code = issueCode(email);
    await sendCode(email, code);
  } catch (e: any) {
    if (e instanceof AuthError) return authFail(reply, e);
    req.log.error({ err: e?.message }, "send code failed");
    return reply.code(502).send({ error: "Не удалось отправить письмо. Попробуй ещё раз чуть позже." });
  }
  return { ok: true, resendIn: 60 };
});

app.post<{ Body: { email?: string; code?: string; join?: string } }>("/api/auth/verify", async (req, reply) => {
  const email = normEmail(req.body?.email);
  const code = String(req.body?.code ?? "").replace(/\D/g, "");
  if (!isEmail(email) || code.length !== 6) return reply.code(400).send({ error: "Введи 6 цифр из письма" });
  const current = userBySession(req.cookies[SID]);
  const attachTo = current && !current.email ? current : null;
  try {
    verifyGuard(email);
    if (!isStaticCode(email, code)) {
      try { checkCode(email, code); } catch (e) { verifyFailed(email); throw e; }
    }
    verifyOk(email);
    const user = completeSignIn(email, attachTo, typeof req.body?.join === "string" ? req.body.join : undefined);
    if (!attachTo) setSession(reply, user.id);
    req.log.info({ user: user.id, attached: !!attachTo }, "email sign-in");
    return { ok: true };
  } catch (e) { return authFail(reply, e); }
});

/* ---------- API (everything below requires a session) ---------- */
app.register(async (api) => {
  api.addHook("preHandler", requireUser);

  api.get("/me", async (req) => ({
    name: req.user.name, email: req.user.email, isAdmin: !!req.user.is_admin, goal: req.user.goal, dailyLimit: confNum("daily_limit"),
    mailConfigured: mailConfigured(), llmTimeoutSec: confNum("llm_timeout_sec"),
  }));

  api.put<{ Body: { goal?: number; name?: string } }>("/me", async (req, reply) => {
    const goal = Number(req.body?.goal);
    if (req.body?.goal !== undefined) {
      if (!Number.isFinite(goal) || goal < 800 || goal > 6000) return reply.code(400).send({ error: "Цель должна быть от 800 до 6000 ккал" });
      db.prepare(`UPDATE users SET goal = ? WHERE id = ?`).run(Math.round(goal), req.user.id);
    }
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(req.body.name.trim().slice(0, 60), req.user.id);
    }
    return { ok: true };
  });

  api.get<{ Querystring: { from: string; to: string } }>("/days", async (req, reply) => {
    const { from, to } = req.query;
    if (!DATE.test(from) || !DATE.test(to)) return reply.code(400).send({ error: "Неверный формат даты" });
    return { days: getDays(req.user.id, from, to) };
  });

  api.put<{ Params: { date: string }; Body: { entries: unknown } }>("/days/:date", async (req, reply) => {
    const date = req.params.date.replace(/^day-/, ""); // early app versions sent "day-YYYY-MM-DD"
    const entries = req.body?.entries;
    if (!DATE.test(date) || !Array.isArray(entries)) return reply.code(400).send({ error: "Неверные данные дня" });
    const size = JSON.stringify(entries).length;
    if (size > 512 * 1024) return reply.code(413).send({ error: "Слишком много записей за день" });
    putDay(req.user.id, date, { entries });
    return { ok: true };
  });

  api.post<{ Body: { text?: string; images?: string[]; date?: string } }>("/estimate", async (req, reply) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 4) : [];
    if (!text && !images.length) return reply.code(400).send({ error: "Пришли фото или описание еды" });
    for (const img of images) {
      if (typeof img !== "string" || !/^data:image\/(jpeg|png|webp|gif);base64,/.test(img) || img.length > 4 * 1024 * 1024) {
        return reply.code(400).send({ error: "Фото должно быть JPEG, PNG или WebP до 3 МБ" });
      }
    }
    const date = req.body?.date && DATE.test(req.body.date) ? req.body.date : new Date().toISOString().slice(0, 10);
    const limit = confNum("daily_limit");
    if (!takeUsage(req.user.id, date, limit)) {
      return reply.code(429).send({ error: `Лимит ${limit} распознаваний в день исчерпан` });
    }
    // the person pressed «Отменить» (or closed the app): stop paying for the model call
    const ac = new AbortController();
    reply.raw.on("close", () => { if (!reply.raw.writableFinished) ac.abort(); });
    try {
      return await estimate(text, images, ac.signal);
    } catch (e: any) {
      if (ac.signal.aborted) { refundUsage(req.user.id, date); req.log.info("estimate cancelled by client"); return; }
      req.log.warn({ err: e?.message }, "estimate failed");
      return reply.code(e?.statusCode || 502).send({ error: e?.message || "Ошибка распознавания" });
    }
  });

  // link to sign in on another device (15 min, one use)
  api.post("/login-link", async (req) => ({ url: linkUrl(createLink({ kind: "login", userId: req.user.id })) }));

  // admins invite by email (the person then signs in with a code) or by one-time link (7 days)
  api.post<{ Body: { email?: string; name?: string } }>("/invites", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Приглашать могут только администраторы" });
    const raw = (req.body?.email || "").trim();
    if (raw) {
      const email = normEmail(raw);
      if (!isEmail(email)) return reply.code(400).send({ error: "Проверь адрес почты" });
      if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(email)) return reply.code(409).send({ error: "Этот человек уже пользуется дневником" });
      const url = `${baseUrl()}/?invite=${inviteEmail(email, req.user.id)}`;
      let sent = false;
      try { await sendInvite(email, url, req.user.name); sent = mailConfigured(); }
      catch (e: any) { req.log.warn({ err: e?.message }, "invite mail failed"); }
      return { email, sent, url };
    }
    const name = (req.body?.name || "").trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: "Укажи email" });
    return { url: linkUrl(createLink({ kind: "invite", name, createdBy: req.user.id })) };
  });

  /* ---- people (admins only) ---- */
  api.get("/users", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Только для администраторов" });
    const users = db.prepare(
      `SELECT id, name, email, is_admin AS isAdmin, disabled, created_at AS createdAt, last_login_at AS lastLoginAt,
              (SELECT MAX(last_seen) FROM sessions WHERE user_id = users.id) AS lastSeen
       FROM users ORDER BY created_at`
    ).all();
    const invites = db.prepare(`SELECT email, created_at AS createdAt FROM email_invites ORDER BY created_at DESC`).all();
    const joinLinks = db.prepare(
      `SELECT id, multi, uses, created_at AS createdAt, expires_at AS expiresAt FROM join_links
       WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC`
    ).all(Date.now());
    return { users, invites, joinLinks, me: req.user.id };
  });

  api.put<{ Params: { id: string }; Body: { disabled?: boolean; isAdmin?: boolean } }>("/users/:id", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Только для администраторов" });
    const id = Number(req.params.id);
    if (id === req.user.id) return reply.code(400).send({ error: "Свой аккаунт так менять нельзя" });
    if (!db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id)) return reply.code(404).send({ error: "Нет такого пользователя" });
    if (typeof req.body?.disabled === "boolean") {
      db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(req.body.disabled ? 1 : 0, id);
      if (req.body.disabled) db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id); // sign out everywhere
    }
    if (typeof req.body?.isAdmin === "boolean") db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(req.body.isAdmin ? 1 : 0, id);
    req.log.info({ by: req.user.id, target: id, change: req.body }, "user updated");
    return { ok: true };
  });

  // delete a person for good: their diary, sessions and usage go too (ON DELETE CASCADE)
  api.delete<{ Params: { id: string } }>("/users/:id", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Только для администраторов" });
    const id = Number(req.params.id);
    if (id === req.user.id) return reply.code(400).send({ error: "Себя удалить нельзя" });
    const u = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(id) as { id: number; email: string | null } | undefined;
    if (!u) return reply.code(404).send({ error: "Нет такого пользователя" });
    db.transaction(() => {
      db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
      if (u.email) {
        db.prepare(`DELETE FROM email_codes WHERE email = ?`).run(u.email);
        db.prepare(`DELETE FROM email_invites WHERE email = ?`).run(u.email);
      }
    })();
    req.log.info({ by: req.user.id, deleted: id }, "user deleted");
    return { ok: true };
  });

  // sign-up links to send in a messenger: one-time (7 days) or multi-use until revoked
  api.post<{ Body: { multi?: boolean } }>("/join-links", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Приглашать могут только администраторы" });
    const multi = req.body?.multi === true;
    req.log.info({ by: req.user.id, multi }, "join link created");
    return { url: `${baseUrl()}/?join=${createJoinLink(req.user.id, multi)}`, multi };
  });
  api.delete<{ Params: { id: string } }>("/join-links/:id", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Только для администраторов" });
    db.prepare(`DELETE FROM join_links WHERE id = ?`).run(Number(req.params.id));
    return { ok: true };
  });

  api.delete<{ Params: { email: string } }>("/invites/:email", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Только для администраторов" });
    db.prepare(`DELETE FROM email_invites WHERE email = ?`).run(normEmail(req.params.email));
    return { ok: true };
  });

  /* ---- all settings (admins only). Secrets are write-only: only "set" and a hint come back. ---- */
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Настройки доступны только администраторам" });
  };

  api.get("/settings", { preHandler: adminOnly }, async () => ({ fields: configView(), envOnly: ["PORT", "DB_PATH", "ADMIN_EMAIL"] }));

  api.put<{ Body: { values?: Record<string, unknown> } }>("/settings", { preHandler: adminOnly }, async (req, reply) => {
    const err = configUpdate(req.body?.values || {});
    if (err) return reply.code(400).send({ error: err });
    req.log.info({ by: req.user.id, keys: Object.keys(req.body?.values || {}) }, "settings updated");
    return { fields: configView() };
  });

  // update from git: the app only drops a request file; deploy/update.sh on the host does the work
  api.get("/update", { preHandler: adminOnly }, async () => updaterState());
  api.post("/update", { preHandler: adminOnly }, async (req, reply) => {
    const r = requestUpdate();
    if ("error" in r) return reply.code(r.code).send({ error: r.error });
    req.log.info({ by: req.user.id }, "update requested");
    return r;
  });

  api.post("/settings/test-mail", { preHandler: adminOnly }, async (req, reply) => {
    const to = req.user.email;
    if (!to) return reply.code(400).send({ error: "У твоего аккаунта нет почты: привяжи её в «Аккаунте»" });
    if (!mailConfigured()) return reply.code(400).send({ error: "Сначала укажи SMTP-сервер и сохрани" });
    try { await sendTest(to); return { ok: true, message: `Письмо отправлено на ${to}. Проверь входящие и «Спам».` }; }
    catch (e: any) { return reply.code(502).send({ error: "Не удалось отправить: " + (e?.response || e?.message || e) }); }
  });

  api.post("/settings/test", { preHandler: adminOnly }, async (req, reply) => {
    try { return { ok: true, message: await testConnection() }; }
    catch (e: any) { return reply.code(e?.statusCode || 502).send({ error: e?.message || "Ошибка" }); }
  });

  api.post("/logout", async (req, reply) => {
    const sid = req.cookies[SID];
    if (sid) deleteSession(sid);
    reply.clearCookie(SID, { path: "/" });
    return { ok: true };
  });
}, { prefix: "/api" });

/* ---------- first run: print an admin invite ---------- */
const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
if (n === 0) {
  const url = linkUrl(createLink({ kind: "invite", name: "Администратор", isAdmin: true }));
  app.log.info(
    `\n\n  Пользователей ещё нет. Первый, кто войдёт по email${process.env.ADMIN_EMAIL ? ` (${process.env.ADMIN_EMAIL})` : ""}, станет администратором.` +
    `\n  Или откройте ссылку администратора (7 дней): ${url}\n` +
    (mailConfigured() ? "" : "  Почта (SMTP) не настроена: коды входа будут печататься в этот лог.\n")
  );
}

if (staticCodeEnabled()) {
  app.log.warn(`Включён постоянный код входа для ${staticCodeEmail()} (STATIC_LOGIN_CODE). Уберите его из .env, когда настроите почту.`);
}

await app.listen({ port: PORT, host: "0.0.0.0" });
