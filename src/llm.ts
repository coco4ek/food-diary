// Food recognition through any OpenAI-compatible Chat Completions API
// (OpenRouter, OpenAI, Gemini's OpenAI endpoint, local gateways, etc.)

import { conf, confNum, confBool, source } from "./config.js";
import { Agent, fetch as uFetch } from "undici";

// Node's built-in fetch gives up after 300 s without response headers; the model may think longer.
// Our own AbortController (llm_timeout_sec) is the only limit.
const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });

function parseExtra(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

/** Read on every call, so changes in the settings screen apply without a restart. */
export function llmConfig() {
  const apiKey = conf("llm_api_key");
  const extra = parseExtra(conf("llm_extra_body"));
  if (confBool("llm_thinking_off")) extra.thinking = { type: "disabled" };
  return {
    baseUrl: conf("llm_base_url").replace(/\/+$/, ""),
    model: conf("llm_model"),
    apiKey,
    keySource: apiKey ? (source("llm_api_key") === "app" ? "app" : "env") : "none",
    extra,
    timeoutMs: confNum("llm_timeout_sec") * 1000,
    maxTokens: confNum("llm_max_tokens"),
    temperature: confNum("llm_temperature"),
    promptExtra: conf("llm_prompt_extra").trim(),
  };
}

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
${llmConfig().promptExtra ? "- Дополнительно: " + llmConfig().promptExtra + "\n" : ""}Ответь только JSON без пояснений вокруг, вида:
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

export type Stats = { sec: number; model: string; thinking: boolean; promptTokens?: number; outTokens?: number; reasoningTokens?: number; imageKb: number };

async function chat(content: any[], maxTokens?: number, cancel?: AbortSignal, stats?: Partial<Stats>): Promise<string> {
  const cfg = llmConfig();
  const t0 = Date.now();
  if (!cfg.apiKey) throw Object.assign(new Error("API-ключ модели не задан. Администратор может указать его в «Настройках модели»."), { statusCode: 503 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  if (cancel) { if (cancel.aborted) ctrl.abort(); else cancel.addEventListener("abort", () => ctrl.abort(), { once: true }); }
  try {
    const res = await uFetch(`${cfg.baseUrl}/chat/completions`, {
      dispatcher: agent,
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, "x-title": "kkal-dnevnik" },
      body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, max_tokens: maxTokens ?? cfg.maxTokens, messages: [{ role: "user", content }], ...cfg.extra }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Ошибка модели: ${msg}`), { statusCode: 502 });
    }
    if (stats) {
      const u = body?.usage || {};
      Object.assign(stats, {
        sec: Math.round((Date.now() - t0) / 100) / 10, model: cfg.model, thinking: (cfg.extra as any)?.thinking?.type !== "disabled",
        promptTokens: u.prompt_tokens, outTokens: u.completion_tokens,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? (body?.choices?.[0]?.message?.reasoning_content ? Math.round(String(body.choices[0].message.reasoning_content).length / 3) : undefined),
      });
    }
    const reply = body?.choices?.[0]?.message?.content;
    return Array.isArray(reply) ? reply.map((p: any) => p?.text ?? "").join("") : String(reply ?? "");
  } catch (e: any) {
    if (e?.name === "AbortError" && cancel?.aborted) throw Object.assign(new Error("Отменено"), { statusCode: 499 });
    if (e?.name === "AbortError") throw Object.assign(new Error(`Модель не ответила за ${Math.round(cfg.timeoutMs / 1000)} с. Попробуй ещё раз или отключи «размышления» в настройках.`), { statusCode: 504 });
    const code = e?.cause?.code || e?.code;
    if (["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code))
      e = Object.assign(new Error(`Не удалось связаться с API модели (${code}). Проверь адрес в настройках.`), { statusCode: 502 });
    else if (code) e = Object.assign(new Error("Связь с моделью оборвалась. Попробуй ещё раз."), { statusCode: 502 });
    if (!e.statusCode) e.statusCode = 502;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function estimate(text: string, images: string[], cancel?: AbortSignal): Promise<Estimate & { stats: Partial<Stats> }> {
  const content: any[] = [{ type: "text", text: prompt(text, images.length > 0) }];
  for (const url of images) content.push({ type: "image_url", image_url: { url } });
  const stats: Partial<Stats> = { imageKb: Math.round(images.reduce((n, u) => n + u.length * 0.75, 0) / 1024) };
  const result = normalize(parseJson(await chat(content, undefined, cancel, stats)));
  return { ...result, stats };
}

/** Cheap round-trip to check address, key and model from the settings screen. */
export async function testConnection(): Promise<string> {
  const t0 = Date.now();
  const reply = await chat([{ type: "text", text: "Ответь одним словом: готово" }], 1500);
  return `Модель ответила за ${((Date.now() - t0) / 1000).toFixed(1)} с: «${reply.trim().slice(0, 40) || "(пусто)"}»`;
}
