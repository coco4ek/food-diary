// Usage:
//   node dist/cli.js invite "Имя" [--admin]   — one-time invite link (7 days)
//   node dist/cli.js login <userId>           — sign-in link for an existing user (15 min)
//   node dist/cli.js users                    — list users
import { db, createLink } from "./db.js";

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "invite") {
  const name = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!name) { console.error('Укажи имя: invite "Маша" [--admin]'); process.exit(1); }
  const token = createLink({ kind: "invite", name, isAdmin: args.includes("--admin") });
  console.log(`${BASE_URL}/i/${token}`);
} else if (cmd === "login") {
  const id = Number(args[0]);
  const u = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
  if (!u) { console.error("Нет пользователя с таким id (см. команду users)"); process.exit(1); }
  console.log(`${BASE_URL}/i/${createLink({ kind: "login", userId: id })}`);
} else if (cmd === "users") {
  console.table(db.prepare(`SELECT id, name, is_admin AS admin, goal, datetime(created_at/1000,'unixepoch') AS created FROM users`).all());
} else {
  console.log('Команды: invite "Имя" [--admin] | login <userId> | users');
}
