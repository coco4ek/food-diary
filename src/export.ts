import { db } from "./db.js";
import { xlsx, type Sheet, type Cell } from "./xlsx.js";

/*
 * «Скачать данные»: the whole diary of one person as an Excel file with three sheets —
 * days (totals), food (one row per ingredient) and toilet marks. Times are shown in the
 * person's time zone (the browser sends its UTC offset).
 */
const BRISTOL = ["", "твёрдые комки", "комковатая колбаска", "колбаска с трещинами", "гладкая и мягкая", "мягкие кусочки", "кашица", "жидкий"];
const MEALS: Record<string, string> = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r1 = (v: number) => Math.round(v * 10) / 10;

export function buildExport(userId: number, tzOffsetMin: number, goal: number): Uint8Array {
  const rows = db.prepare(`SELECT date, data FROM days WHERE user_id = ? ORDER BY date`).all(userId) as { date: string; data: string }[];
  const local = (ts: number) => ts - tzOffsetMin * 60_000; // browser getTimezoneOffset(): UTC = local + offset
  const serial = (ms: number) => ms / 86_400_000 + 25569; // Excel day number
  const dateCell = (iso: string): Cell => ({ v: serial(Date.parse(iso + "T00:00:00Z")), f: "date" });
  const timeCell = (ts: number): Cell => ({ v: serial(Math.round(local(ts) / 60_000) * 60_000) % 1, f: "time" });
  const num1 = (v: number): Cell => ({ v: r1(v), f: "num1" });

  const days: Cell[][] = [], food: Cell[][] = [], wc: Cell[][] = [];
  let prevMeals: number[] = [], prevDate = "";
  const dayBefore = (iso: string) => new Date(Date.parse(iso + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  for (const { date, data } of rows) {
    let d: any; try { d = JSON.parse(data); } catch { continue; }
    const entries: any[] = Array.isArray(d.entries) ? d.entries : [];
    const marks: { at: number; t?: number }[] = (Array.isArray(d.toilet) ? d.toilet : []).map((x: any) => (typeof x === "number" ? { at: x } : x)).filter((x: any) => x && x.at > 0);
    const tot = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, grams: 0 };
    let hasFiber = false;
    const dayTags = new Set<string>();
    const mealAts: number[] = [];
    for (const e of entries) {
      if (n(e.at)) mealAts.push(n(e.at));
      const dishes: any[] = Array.isArray(e.dishes) ? e.dishes : Array.isArray(e.items) ? e.items.map((i: any) => ({ name: i.name, items: [i] })) : [];
      for (const dish of dishes) {
        const tags: string[] = Array.isArray(dish.tags) ? dish.tags : [];
        tags.forEach((t) => dayTags.add(t));
        for (const it of Array.isArray(dish.items) ? dish.items : []) {
          for (const k of ["kcal", "protein", "fat", "carbs", "fiber", "grams"] as const) tot[k] += n(it[k]);
          if (it.fiber !== undefined && it.fiber !== null) hasFiber = true;
          food.push([dateCell(date), n(e.at) ? timeCell(n(e.at)) : null, MEALS[e.meal] || e.meal || "", dish.name || "", it.name || "",
            Math.round(n(it.grams)), Math.round(n(it.kcal)), num1(n(it.protein)), num1(n(it.fat)), num1(n(it.carbs)),
            it.fiber === undefined ? null : num1(n(it.fiber)), tags.join(", "), e.text || ""]);
        }
      }
    }
    const typed = marks.filter((m) => m.t);
    // last meal before each visit: that day or the calendar day before, at most 24 h back
    const meals = [...(prevDate === dayBefore(date) ? prevMeals : []), ...mealAts];
    for (const m of marks) {
      const before = meals.filter((a) => a < m.at && m.at - a <= 86_400_000);
      wc.push([dateCell(date), timeCell(m.at), m.t || null, m.t ? BRISTOL[m.t] : "",
        before.length ? num1((m.at - Math.max(...before)) / 3_600_000) : null]);
    }
    prevMeals = mealAts; prevDate = date;
    if (!entries.length && !marks.length) continue;
    days.push([dateCell(date), WD[new Date(date + "T12:00:00Z").getUTCDay()], Math.round(tot.kcal), goal,
      num1(tot.protein), num1(tot.fat), num1(tot.carbs), hasFiber ? num1(tot.fiber) : null, Math.round(tot.grams), entries.length,
      marks.length, typed.length ? num1(typed.reduce((a, m) => a + (m.t || 0), 0) / typed.length) : null, [...dayTags].sort().join(", ")]);
  }

  const sheets: Sheet[] = [
    { name: "Дни", widths: [12, 5, 8, 8, 8, 8, 10, 11, 10, 9, 9, 12, 40],
      header: ["Дата", "День", "Ккал", "Цель", "Белки, г", "Жиры, г", "Углеводы, г", "Клетчатка, г", "Вес еды, г", "Приёмов", "Туалет, раз", "Тип стула (ср.)", "Ярлыки за день"], rows: days },
    { name: "Еда", widths: [12, 7, 10, 28, 28, 8, 7, 7, 7, 9, 10, 24, 30],
      header: ["Дата", "Время", "Приём", "Блюдо", "Ингредиент", "Граммы", "Ккал", "Белки", "Жиры", "Углеводы", "Клетчатка", "Ярлыки блюда", "Описание"], rows: food },
    { name: "Туалет", widths: [12, 7, 8, 22, 16],
      header: ["Дата", "Время", "Тип (1–7)", "Описание", "Часов после еды"], rows: wc },
  ];
  return xlsx(sheets);
}
