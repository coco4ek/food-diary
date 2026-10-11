// Every runtime setting in one place. Value order: saved in the app (settings table) → .env → default.
// Only things needed before the app can start stay env-only: PORT, DB_PATH, ADMIN_EMAIL, LOG_LEVEL.
import { getSetting, setSetting } from "./db.js";

export type FieldType = "text" | "url" | "email" | "number" | "bool" | "secret" | "textarea";
export type Field = {
  key: string;
  group: "model" | "limits" | "mail" | "site" | "login";
  label: string;
  type: FieldType;
  env?: string;
  def?: string;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  validate?: (v: string) => string | null; // error message or null
};

const PORT = Number(process.env.PORT || 3000);

const jsonObject = (v: string) => {
  try { const o = JSON.parse(v); return o && typeof o === "object" && !Array.isArray(o) ? null : "Нужен JSON-объект, например {\"top_p\":0.9}"; }
  catch { return "Это не JSON. Пример: {\"top_p\":0.9}"; }
};

export const FIELDS: Field[] = [
  // ---- model ----
  { key: "llm_api_key", group: "model", label: "API-ключ", type: "secret", env: "LLM_API_KEY",
    validate: (v) => (v.length < 8 || v.length > 400 || /\s/.test(v) ? "Ключ выглядит неверно: без пробелов, от 8 символов" : null) },
  { key: "llm_model", group: "model", label: "Модель", type: "text", env: "LLM_MODEL", def: "glm-4.6v",
    help: "Модель должна понимать фото.",
    options: [
      { value: "glm-4.6v", label: "основная" }, { value: "glm-4.6v-flashx", label: "дешевле и быстрее" },
      { value: "glm-4.6v-flash", label: "бесплатная" }, { value: "glm-5v-turbo", label: "новейшая" },
    ] },
  { key: "llm_base_url", group: "model", label: "Адрес API", type: "url", env: "LLM_BASE_URL", def: "https://api.z.ai/api/paas/v4",
    help: "z.ai: https://api.z.ai/api/paas/v4 · OpenRouter: https://openrouter.ai/api/v1" },
  { key: "llm_thinking_off", group: "model", label: "Отключить «размышления» модели", type: "bool", def: "0",
    help: "Быстрее и дешевле, но иногда менее точно. Для GLM." },
  { key: "llm_timeout_sec", group: "model", label: "Ждать ответа, секунд", type: "number", env: "LLM_TIMEOUT_SEC", def: process.env.LLM_TIMEOUT_MS ? String(Math.round(Number(process.env.LLM_TIMEOUT_MS) / 1000)) : "300", min: 30, max: 900,
    help: "Если стоит nginx, его proxy_read_timeout должен быть не меньше." },
  { key: "llm_max_tokens", group: "model", label: "Предел длины ответа, токенов", type: "number", env: "LLM_MAX_TOKENS", def: "6000", min: 500, max: 32000,
    help: "С запасом на «размышления», иначе ответ обрежется." },
  { key: "llm_temperature", group: "model", label: "Температура", type: "number", env: "LLM_TEMPERATURE", def: "0.2", min: 0, max: 1.5, step: 0.1,
    help: "Чем ниже, тем стабильнее оценки. 0,1–0,3 — хороший диапазон." },
  { key: "llm_prompt_extra", group: "model", label: "Дополнительные указания модели", type: "textarea",
    placeholder: "Например: порции в столовой обычно 250 г; хлеб считай ржаным", help: "Добавляется к основному заданию для модели." },
  { key: "llm_extra_body", group: "model", label: "Доп. параметры запроса (JSON)", type: "textarea", env: "LLM_EXTRA_BODY",
    placeholder: "{\"top_p\":0.9}", help: "Для опытных: поля, которые уйдут в запрос к API как есть.", validate: jsonObject },

  // ---- limits ----
  { key: "daily_limit", group: "limits", label: "Распознаваний на человека в день", type: "number", env: "DAILY_LIMIT", def: "40", min: 1, max: 1000,
    help: "Защищает бюджет на API." },
  { key: "default_goal", group: "limits", label: "Цель по умолчанию для новых участников, ккал", type: "number", def: "2000", min: 800, max: 6000 },

  // ---- mail ----
  { key: "smtp_host", group: "mail", label: "SMTP-сервер", type: "text", env: "SMTP_HOST", placeholder: "smtp.mail.ru",
    help: "Пусто — письма печатаются в лог сервера. Яндекс: smtp.yandex.ru · Mail.ru: smtp.mail.ru · Gmail: smtp.gmail.com" },
  { key: "smtp_port", group: "mail", label: "Порт", type: "number", env: "SMTP_PORT", def: "465", min: 1, max: 65535,
    help: "465 — SSL (обычно), 587 — STARTTLS." },
  { key: "smtp_user", group: "mail", label: "Логин", type: "text", env: "SMTP_USER", placeholder: "robot@example.com" },
  { key: "smtp_pass", group: "mail", label: "Пароль", type: "secret", env: "SMTP_PASS",
    help: "Для Яндекса, Mail.ru и Gmail — пароль приложения, а не от почты." },
  { key: "smtp_from", group: "mail", label: "Отправитель", type: "text", env: "SMTP_FROM", placeholder: "Дневник калорий <robot@example.com>",
    help: "Пусто — используется логин." },

  // ---- site ----
  { key: "base_url", group: "site", label: "Адрес сайта", type: "url", env: "BASE_URL", def: `http://localhost:${PORT}`,
    help: "Ровно так, как его открывают люди. Из него собираются ссылки в письмах." },
  { key: "app_name", group: "site", label: "Название", type: "text", env: "APP_NAME", def: "Дневник калорий", help: "В письмах." },

  // ---- login ----
  { key: "static_login_code", group: "login", label: "Постоянный код для администратора", type: "secret", env: "STATIC_LOGIN_CODE",
    help: "6 цифр для входа по ADMIN_EMAIL без письма, пока не работает почта. После 10 ошибок за час вход блокируется. Удалите, когда настроите почту.",
    validate: (v) => (/^\d{6}$/.test(v) ? null : "Нужно ровно 6 цифр") },
];

const byKey = new Map(FIELDS.map((f) => [f.key, f]));

export function conf(key: string): string {
  const f = byKey.get(key);
  const saved = getSetting(key);
  if (saved !== undefined) return saved;
  if (f?.env && process.env[f.env] !== undefined && process.env[f.env] !== "") return process.env[f.env]!;
  return f?.def ?? "";
}
export const confNum = (key: string) => {
  const f = byKey.get(key), n = Number(conf(key));
  const v = Number.isFinite(n) ? n : Number(f?.def ?? 0);
  return Math.min(f?.max ?? Infinity, Math.max(f?.min ?? -Infinity, v));
};
export const confBool = (key: string) => ["1", "true", "yes", "on"].includes(conf(key).toLowerCase());
export const source = (key: string): "app" | "env" | "default" => {
  if (getSetting(key) !== undefined) return "app";
  const f = byKey.get(key);
  return f?.env && process.env[f.env] ? "env" : "default";
};

/** What the settings screen sees. Secrets never leave the server: only whether they are set and a hint. */
export function view() {
  return FIELDS.map(({ validate, ...f }) => {
    const v = conf(f.key);
    const base = { ...f, source: source(f.key) };
    if (f.type === "secret") {
      return { ...base, value: "", isSet: !!v, hint: v ? (f.key === "static_login_code" ? "задан" : "••••" + v.slice(-4)) : "" };
    }
    return { ...base, value: v };
  });
}

/**
 * Apply edits. `null` = forget the saved value (fall back to .env / default).
 * For secrets an empty string means "keep as is".
 */
export function update(values: Record<string, unknown>): string | null {
  const pending: [string, string | null][] = [];
  for (const [key, raw] of Object.entries(values || {})) {
    const f = byKey.get(key);
    if (!f) return `Неизвестная настройка: ${key}`;
    if (raw === null) { pending.push([key, null]); continue; }
    let v = typeof raw === "boolean" ? (raw ? "1" : "0") : String(raw ?? "").trim();
    if (f.type === "secret" && v === "") continue;
    if (v === "" && f.type !== "textarea") { pending.push([key, null]); continue; }
    if (f.type === "number") {
      const n = Number(v.replace(",", "."));
      if (!Number.isFinite(n)) return `«${f.label}»: нужно число`;
      if (f.min !== undefined && n < f.min) return `«${f.label}»: не меньше ${f.min}`;
      if (f.max !== undefined && n > f.max) return `«${f.label}»: не больше ${f.max}`;
      v = String(n);
    }
    if (f.type === "url" && !/^https?:\/\/[^\s]+$/.test(v)) return `«${f.label}»: адрес должен начинаться с https://`;
    if (f.type === "url") v = v.replace(/\/+$/, "");
    if (f.type === "bool") v = ["1", "true", "on", "yes"].includes(v.toLowerCase()) ? "1" : "0";
    if (v.length > 4000) return `«${f.label}»: слишком длинно`;
    const err = v && f.validate ? f.validate(v) : null;
    if (err) return `«${f.label}»: ${err}`;
    pending.push([key, f.type === "textarea" && v === "" ? null : v]);
  }
  for (const [k, v] of pending) setSetting(k, v);
  return null;
}

/* One-time move from the previous version, which stored thinking inside llm_extra_body. */
{
  const raw = getSetting("llm_extra_body");
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o?.thinking?.type === "disabled") {
        if (getSetting("llm_thinking_off") === undefined) setSetting("llm_thinking_off", "1");
        delete o.thinking;
        setSetting("llm_extra_body", Object.keys(o).length ? JSON.stringify(o) : null);
      }
    } catch { /* leave as is */ }
  }
}
