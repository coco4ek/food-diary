// Food recognition through any OpenAI-compatible Chat Completions API
// (OpenRouter, OpenAI, Gemini's OpenAI endpoint, local gateways, etc.)

const BASE = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const KEY = process.env.LLM_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4.5";
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90_000);

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

export async function estimate(text: string, images: string[]): Promise<Estimate> {
  if (!KEY) throw Object.assign(new Error("LLM_API_KEY не задан на сервере"), { statusCode: 500 });
  const content: any[] = [{ type: "text", text: prompt(text, images.length > 0) }];
  for (const url of images) content.push({ type: "image_url", image_url: { url } });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY}`,
        // harmless for other providers; OpenRouter shows these in its dashboard
        "x-title": "kkal-dnevnik",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 3000,
        messages: [{ role: "user", content }],
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Ошибка модели: ${msg}`), { statusCode: 502 });
    }
    const reply = body?.choices?.[0]?.message?.content;
    const textReply = Array.isArray(reply) ? reply.map((p: any) => p?.text ?? "").join("") : String(reply ?? "");
    return normalize(parseJson(textReply));
  } catch (e: any) {
    if (e?.name === "AbortError") throw Object.assign(new Error("Модель не ответила вовремя, попробуй ещё раз"), { statusCode: 504 });
    if (!e.statusCode) e.statusCode = 502;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
