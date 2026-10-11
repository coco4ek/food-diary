// Food recognition through any OpenAI-compatible Chat Completions API
// (OpenRouter, OpenAI, Gemini's OpenAI endpoint, local gateways, etc.)

import { getSetting } from "./db.js";

const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 6000);

function parseExtra(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

/** Settings saved in the app (admin → «Настройки модели») win over .env. */
export function llmConfig() {
  const dbKey = getSetting("llm_api_key");
  return {
    baseUrl: (getSetting("llm_base_url") || process.env.LLM_BASE_URL || "https://api.z.ai/api/paas/v4").replace(/\/+$/, ""),
    model: getSetting("llm_model") || process.env.LLM_MODEL || "glm-4.6v",
    apiKey: dbKey || process.env.LLM_API_KEY || "",
    keySource: dbKey ? "app" : process.env.LLM_API_KEY ? "env" : "none",
    // Provider-specific request fields, e.g. GLM {"thinking":{"type":"disabled"}}
    extra: parseExtra(getSetting("llm_extra_body") ?? process.env.LLM_EXTRA_BODY),
  } as const;
}
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 300_000); // GLM with thinking can take minutes

export type Ingredient = { name: string; grams: number; kcal: number; protein: number; fat: number; carbs: number };
export type Dish = { name: string; items: Ingredient[] };
export type Estimate = { dishes: Dish[]; note: string };

function prompt(text: string, hasPhotos: boolean) {
  return `Ты — нутрициолог. Оцени пищевую ценность того, что съел человек${hasPhotos ? " (на фото" + (text ? " и в описании" : "") + ")" : ""}.
Описание: ${text || "(нет, только фото)"}
Правила:
- Сгруппируй еду по блюдам, как они поданы (тарелка борща, салат, бутерброд, напиток). Названия по-русски, коротко.
- Для каждого блюда перечисли основные ингредиенты (до 8) с весом и пищевой ценностью; масло, соусы и заправки — отдельными ингредиентами.
- Простой продукт (банан, яблоко) — блюдо с одним ингредиентом с тем же названием.
- Если вес не указан, возьми типичную порцию для России и укажи её вес в граммах.
- Для штучных продуктов (яйцо, банан, кусок хлеба) переведи в граммы.
- По фото оцени вес порции по размеру тарелки, приборов и рук. Если на фото упаковка с этикеткой — бери данные с этикетки.
- Если на фото нет еды, верни пустой dishes и объясни в note.
- Используй справочные значения (как в таблицах калорийности), учитывай способ приготовления.
Ответь только JSON без пояснений вокруг, вида:
{"dishes":[{"name":"Яичница с беконом","items":[{"name":"Яйцо куриное","grams":110,"kcal":157,"protein":13.9,"fat":11.4,"carbs":0.8},{"name":"Бекон","grams":30,"kcal":140,"protein":4.5,"fat":13.5,"carbs":0},{"name":"Масло подсолнечное","grams":5,"kcal":45,"protein":0,"fat":5,"carbs":0}]}],"note":"короткое пояснение допущений, до 140 символов, или пустая строка"}`;
}

/** Tolerant JSON extraction: whole reply, a ```fence```, or first { … last }. */
function parseJson(s: string): any {
  try { return JSON.parse(s); } catch {}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  throw new Error("Модель ответила не в формате JSON");
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0; };
const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : d);

function normalize(raw: any): Estimate {
  const list: any[] = Array.isArray(raw?.dishes) ? raw.dishes
    : Array.isArray(raw?.items) ? raw.items.map((i: any) => ({ name: i?.name, items: [i] })) : [];
  const dishes = list.slice(0, 20).map((d) => {
    const items = (Array.isArray(d?.items) && d.items.length ? d.items : [d]).slice(0, 15).map((i: any) => ({
      name: str(i?.name, "Ингредиент"), grams: num(i?.grams), kcal: num(i?.kcal),
      protein: num(i?.protein), fat: num(i?.fat), carbs: num(i?.carbs),
    }));
    return { name: str(d?.name, items[0]?.name || "Блюдо"), items };
  }).filter((d) => d.items.length);
  return { dishes, note: typeof raw?.note === "string" ? raw.note.slice(0, 300) : "" };
}

async function chat(content: any[], maxTokens: number): Promise<string> {
  const cfg = llmConfig();
  if (!cfg.apiKey) throw Object.assign(new Error("API-ключ модели не задан. Администратор может указать его в «Настройках модели»."), { statusCode: 503 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, "x-title": "kkal-dnevnik" },
      body: JSON.stringify({ model: cfg.model, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: "user", content }], ...cfg.extra }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Ошибка модели: ${msg}`), { statusCode: 502 });
    }
    const reply = body?.choices?.[0]?.message?.content;
    return Array.isArray(reply) ? reply.map((p: any) => p?.text ?? "").join("") : String(reply ?? "");
  } catch (e: any) {
    if (e?.name === "AbortError") throw Object.assign(new Error(`Модель не ответила за ${Math.round(TIMEOUT_MS / 1000)} с. Попробуй ещё раз или отключи «размышления» в настройках.`), { statusCode: 504 });
    if (e?.cause?.code) e = Object.assign(new Error(`Не удалось связаться с API (${e.cause.code}). Проверь адрес.`), { statusCode: 502 });
    if (!e.statusCode) e.statusCode = 502;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function estimate(text: string, images: string[]): Promise<Estimate> {
  const content: any[] = [{ type: "text", text: prompt(text, images.length > 0) }];
  for (const url of images) content.push({ type: "image_url", image_url: { url } });
  return normalize(parseJson(await chat(content, MAX_TOKENS)));
}

/** Cheap round-trip to check address, key and model from the settings screen. */
export async function testConnection(): Promise<string> {
  const t0 = Date.now();
  const reply = await chat([{ type: "text", text: "Ответь одним словом: готово" }], 1500);
  return `Модель ответила за ${((Date.now() - t0) / 1000).toFixed(1)} с: «${reply.trim().slice(0, 40) || "(пусто)"}»`;
}
