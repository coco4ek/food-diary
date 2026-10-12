import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * «Обновить из GitHub». The container has no access to Docker or git on purpose: it only writes
 * data/updater/request. A systemd path unit on the host (deploy/install-updater.sh) sees the file and
 * runs deploy/update.sh, which writes status.json and log back into the same folder.
 */
const DIR = join(dirname(process.env.DB_PATH || "./data/kkal.sqlite"), "updater");
const f = (n: string) => join(DIR, n);
const STALE = 20 * 60_000;

type Status = { state: "running" | "done" | "failed"; message: string; at: number; from?: string; to?: string };

function readStatus(): Status | null {
  try { return JSON.parse(readFileSync(f("status.json"), "utf8")); } catch { return null; }
}

export function updaterState() {
  const installed = existsSync(f("installed"));
  let status = readStatus();
  const pending = existsSync(f("request"));
  if (status?.state === "running" && Date.now() - status.at > STALE) status = { ...status, state: "failed", message: "Обновление зависло. Смотри журнал на сервере." };
  let log = "";
  try { log = readFileSync(f("log"), "utf8"); if (log.length > 6000) log = "…\n" + log.slice(-6000); } catch {}
  let requestedAt: number | null = null;
  try { if (pending) requestedAt = statSync(f("request")).mtimeMs; } catch {}
  return { installed, pending, requestedAt, status, log };
}

export function requestUpdate(): { ok: true } | { error: string; code: number } {
  if (!existsSync(f("installed")))
    return { code: 400, error: "Обновление с кнопки не настроено. Один раз выполни на сервере: sudo ./deploy/install-updater.sh" };
  const s = readStatus();
  if (s?.state === "running" && Date.now() - s.at < STALE) return { code: 409, error: "Обновление уже идёт" };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(f("request"), String(Date.now()));
  return { ok: true };
}
