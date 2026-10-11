import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  db, User, createLink, consumeLink, createSession, userBySession, deleteSession,
  getDays, putDay, takeUsage,
} from "./db.js";
import { estimate } from "./llm.js";

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
  if (!u) return reply.code(401).send({ error: "Нужно войти по ссылке-приглашению" });
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

/* ---------- API (everything below requires a session) ---------- */
app.register(async (api) => {
  api.addHook("preHandler", requireUser);

  api.get("/me", async (req) => ({
    name: req.user.name, isAdmin: !!req.user.is_admin, goal: req.user.goal, dailyLimit: DAILY_LIMIT,
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

  // admins invite new people (7 days, one use)
  api.post<{ Body: { name?: string } }>("/invites", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "Приглашать могут только администраторы" });
    const name = (req.body?.name || "").trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: "Укажи имя" });
    return { url: linkUrl(createLink({ kind: "invite", name, createdBy: req.user.id })) };
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
  app.log.info(`\n\n  Пользователей ещё нет. Ссылка администратора (действует 7 дней):\n  ${url}\n`);
}

await app.listen({ port: PORT, host: "0.0.0.0" });
