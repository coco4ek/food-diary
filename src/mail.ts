import nodemailer from "nodemailer";

// SMTP from .env. Without SMTP_HOST, letters are printed to the server log
// (handy for local development and for the very first admin sign-in).
const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT || 465);
const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || "kkal@localhost";
const APP = process.env.APP_NAME || "Дневник калорий";

const transport = HOST
  ? nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : PORT === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
    })
  : null;

export const mailConfigured = () => !!transport;

async function send(to: string, subject: string, text: string, html: string) {
  if (!transport) {
    console.log(`\n[почта не настроена — письмо выведено в лог]\nКому: ${to}\nТема: ${subject}\n${text}\n`);
    return;
  }
  await transport.sendMail({ from: FROM.includes("<") ? FROM : `${APP} <${FROM}>`, to, subject, text, html });
}

const shell = (body: string) => `<!doctype html><html lang="ru"><body style="margin:0;padding:24px;background:#EEF1EC;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#18211A">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #D8DED3">${body}
<p style="margin:24px 0 0;font-size:12px;color:#66705F">${APP}</p></div></body></html>`;

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
    `${from} приглашает тебя в «${APP}»`,
    `${from} приглашает тебя вести дневник калорий по фото.\n\nОткрой ${url} и войди по этому адресу почты, код придёт письмом.`,
    shell(`<p style="margin:0 0 12px"><b>${from.replace(/</g, "&lt;")}</b> приглашает тебя вести дневник калорий: фотографируешь еду, а калории и БЖУ считаются сами.</p>
<p style="margin:0 0 16px"><a href="${url}" style="display:inline-block;background:#C8442F;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600">Открыть дневник</a></p>
<p style="margin:0;font-size:14px;color:#66705F">Войди по адресу ${to}, код придёт письмом.</p>`)
  );
}
