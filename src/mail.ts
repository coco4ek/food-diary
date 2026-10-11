import nodemailer, { type Transporter } from "nodemailer";

import { conf, confNum } from "./config.js";

// SMTP from the settings screen (or .env). Without a host, letters are printed to the server log
// (handy for local development and for the very first admin sign-in).
let cached: { sig: string; t: Transporter } | null = null;
function transport() {
  const host = conf("smtp_host").trim();
  if (!host) return null;
  const port = confNum("smtp_port"), user = conf("smtp_user").trim(), pass = conf("smtp_pass");
  const sig = JSON.stringify([host, port, user, pass]);
  if (cached?.sig !== sig) {
    cached = { sig, t: nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    }) };
  }
  return cached.t;
}
const appName = () => conf("app_name") || "Дневник калорий";

export const mailConfigured = () => !!conf("smtp_host").trim();

async function send(to: string, subject: string, text: string, html: string) {
  const t = transport();
  if (!t) {
    console.log(`\n[почта не настроена — письмо выведено в лог]\nКому: ${to}\nТема: ${subject}\n${text}\n`);
    return;
  }
  const from = conf("smtp_from").trim() || conf("smtp_user").trim() || "kkal@localhost";
  await t.sendMail({ from: from.includes("<") ? from : `${appName()} <${from}>`, to, subject, text, html });
}

const shell = (body: string) => `<!doctype html><html lang="ru"><body style="margin:0;padding:24px;background:#EEF1EC;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#18211A">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #D8DED3">${body}
<p style="margin:24px 0 0;font-size:12px;color:#66705F">${appName()}</p></div></body></html>`;

export function sendCode(to: string, code: string) {
  return send(
    to,
    `${code} — код входа`,
    `Твой код для входа: ${code}\n\nОн действует 10 минут. Если ты не запрашивал код, просто проигнорируй это письмо.`,
    shell(`<p style="margin:0 0 12px">Код для входа:</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:.18em">${code}</p>
<p style="margin:0;font-size:14px;color:#66705F">Код действует 10 минут. Если ты не запрашивал вход, просто проигнорируй это письмо.</p>`)
  );
}

export function sendInvite(to: string, url: string, from: string) {
  return send(
    to,
    `${from} приглашает тебя в «${appName()}»`,
    `${from} приглашает тебя вести дневник калорий по фото.\n\nОткрой ссылку: ${url}\nСразу после этого на эту почту придёт код для входа.`,
    shell(`<p style="margin:0 0 12px"><b>${from.replace(/</g, "&lt;")}</b> приглашает тебя вести дневник калорий: фотографируешь еду, а калории и БЖУ считаются сами.</p>
<p style="margin:0 0 16px"><a href="${url}" style="display:inline-block;background:#C8442F;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600">Открыть дневник</a></p>
<p style="margin:0;font-size:14px;color:#66705F">После нажатия на ${to} придёт код из 6 цифр — введи его, и дневник откроется.</p>`)
  );
}

export function sendTest(to: string) {
  return send(to, `Проверка почты — ${appName()}`, "Почта настроена правильно: это письмо пришло из настроек приложения.",
    shell(`<p style="margin:0">Почта настроена правильно: это письмо пришло из настроек приложения.</p>`));
}
