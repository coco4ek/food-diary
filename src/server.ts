import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  db, User, createLink, consumeLink, createSession, userBySession, deleteSession,
  getDays, putDay, takeUsage, setSetting,
} from "./db.js";
import { estimate, llmConfig, testConnection } from "./llm.js";
import { AuthError, normEmail, isEmail, checkAllowed, issueCode, checkCode, completeSignIn, ipLimit, inviteEmail } from "./auth.js";
import { sendCode, sendInvite, mailConfigured } from "./mail.js";

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 40);
const SECURE = BASE_URL.startsWith("https://");
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
const linkUrl = (token: string) => `${BASE_URL}/i/${token}`;

declare module "fastify" { interface FastifyRequest { user: User } }

async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const u = userBySession(req.cookies[SID]);
  if (!u) return reply.code(401).send({ error: "Нужно войти" });
  req.user = u;
}

function setSession(reply: FastifyReply, userId: number) {
  reply.setCookie(SID, createSession(userId), {
    path: "/", httpOnly: true, sameSite: "lax", secure: SECURE, maxAge: 60 * 60 * 24 * 365,
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

app.post<{ Body: { email?: string } }>("/api/auth/request", async (req, reply) => {
  const email = normEmail(req.body?.email);
  if (!isEmail(email)) return reply.code(400).send({ error: "Проверь адрес почты" });
  const current = userBySession(req.cookies[SID]);
  const attachTo = current && !current.email ? current : null;
  try {
    ipLimit(req.ip);
    checkAllowed(email, attachTo);
    const code = issueCode(email);
    await sendCode(email, code);
  } catch (e: any) {
    if (e instanceof AuthError) return authFail(reply, e);
    req.log.error({ err: e?.message }, "send code failed");
    return reply.code(502).send({ error: "Не удалось отправить письмо. Попробуй ещё раз чуть позже." });
  }
  return { ok: true, resendIn: 60 };
});

app.post<{ Body: { email?: string; code?: string } }>("/api/auth/verify", async (req, reply) => {
  const email = normEmail(req.body?.email);
  const code = String(req.body?.code ?? "").replace(/\D/g, "");
  if (!isEmail(email) || code.length !== 6) return reply.code(400).send({ error: "Введи 6 цифр из письма" });
  const current = userBySession(req.cookies[SID]);
  const attachTo = current && !current.email ? current : null;
  try {
    checkCode(email, code);
    const user = completeSignIn(email, attachTo);
    if (!attachTo) setSession(reply, user.id);
    req.log.info({ user: user.id, attached: !!attachTo }, "email sign-in");
    return { ok: true };
  } catch (e) { return authFail(reply, e); }
});

/* ---------- API (everything below requires a session) ---------- */
app.register(async (api) => {
  api.addHook("preHandler", requireUser);

  api.get("/me", async (req) => ({
    name: req.user.name, email: req.user.email, isAdmin: !!req.user.is_admin, goal: req.user.goal, dailyLimit: DAILY_LIMIT,
    mailConfigured: mailConfigured(),
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
    const { date } = req.params;
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
    if (!takeUsage(req.user.id, date, DAILY_LIMIT)) {
      return reply.code(429).send({ error: `Лимит ${DAILY_LIMIT} распознаваний в день исчерпан` });
    }
    try {
      return await estimate(text, images);
    } catch (e: any) {
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
      inviteEmail(email, req.user.id);
      let sent = false;
      try { await sendInvite(email, BASE_URL, req.user.name); sent = mailConfigured(); }
      catch (e: any) { req.log.warn({ err: e?.message }, "invite mail failed"); }
      return { email, sent, url: BASE_URL };
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
    return { users, invites, me: req.user.id };
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

  api.delete<{ Params: { email: string } }>("/invites/:email", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Только для администраторов" });
    db.prepare(`DELETE FROM email_invites WHERE email = ?`).run(normEmail(req.params.email));
    return { ok: true };
  });

  /* ---- model settings (admins only). The key is write-only: only its last 4 chars come back. ---- */
  const settingsView = () => {
    const c = llmConfig();
    return {
      baseUrl: c.baseUrl, model: c.model, keySource: c.keySource,
      keyHint: c.apiKey ? "••••" + c.apiKey.slice(-4) : "",
      thinkingOff: (c.extra as any)?.thinking?.type === "disabled",
    };
  };
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Настройки доступны только администраторам" });
  };

  api.get("/settings", { preHandler: adminOnly }, async () => settingsView());

  api.put<{ Body: { baseUrl?: string; model?: string; apiKey?: string; clearKey?: boolean; thinkingOff?: boolean } }>(
    "/settings", { preHandler: adminOnly }, async (req, reply) => {
      const b = req.body || {};
      if (typeof b.baseUrl === "string") {
        const u = b.baseUrl.trim();
        if (u && !/^https?:\/\/[^\s]+$/.test(u)) return reply.code(400).send({ error: "Адрес API должен начинаться с https://" });
        setSetting("llm_base_url", u || null);
      }
      if (typeof b.model === "string") setSetting("llm_model", b.model.trim().slice(0, 120) || null);
      if (b.clearKey) setSetting("llm_api_key", null);
      else if (typeof b.apiKey === "string" && b.apiKey.trim()) {
        const k = b.apiKey.trim();
        if (k.length < 8 || k.length > 400 || /\s/.test(k)) return reply.code(400).send({ error: "Ключ выглядит неверно: без пробелов, от 8 символов" });
        setSetting("llm_api_key", k);
      }
      if (typeof b.thinkingOff === "boolean") {
        const extra: Record<string, unknown> = { ...(llmConfig().extra as any) };
        if (b.thinkingOff) extra.thinking = { type: "disabled" }; else delete extra.thinking;
        setSetting("llm_extra_body", Object.keys(extra).length ? JSON.stringify(extra) : null);
      }
      req.log.info({ by: req.user.id }, "model settings updated");
      return settingsView();
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

await app.listen({ port: PORT, host: "0.0.0.0" });
