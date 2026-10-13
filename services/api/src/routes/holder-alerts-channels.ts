// The three ways an alert leaves the server: a browser push (VAPID, no vendor account), an email (any SMTP server) and a
// Telegram message (a bot made with @BotFather). Each is configured from the environment and is simply absent when it is not:
// the API then says so, instead of pretending to deliver.
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import type { AlertItem } from './holder-alerts-core.js';

export type AlertConfig = {
  push: { publicKey: string; privateKey: string; subject: string } | null;
  email: { url: string; from: string } | null;
  telegram: { token: string; username: string } | null;
  /** Public address of the web app: the base of every link in a mail or message. */
  webUrl: string | null;
  /** Signs the tokens carried in emails. ALERT_SECRET, or derived from the SMTP credentials when that is not set. */
  secret: string;
};

/**
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (`web-push generate-vapid-keys`) and VAPID_SUBJECT (a mailto: or https: contact),
 * SMTP_URL (`smtps://user:pass@host:465`) and MAIL_FROM, TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME, WEB_URL.
 */
export function loadAlertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const set = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : null);
  const pub = set('VAPID_PUBLIC_KEY');
  const priv = set('VAPID_PRIVATE_KEY');
  const smtp = set('SMTP_URL');
  const from = set('MAIL_FROM');
  const token = set('TELEGRAM_BOT_TOKEN');
  const username = set('TELEGRAM_BOT_USERNAME');
  const webUrl = set('WEB_URL')?.replace(/\/+$/, '') ?? null;
  return {
    push: pub && priv ? { publicKey: pub, privateKey: priv, subject: set('VAPID_SUBJECT') ?? (webUrl ? webUrl : 'mailto:alerts@invalid.example') } : null,
    email: smtp && from ? { url: smtp, from } : null,
    telegram: token && username ? { token, username: username.replace(/^@/, '') } : null,
    webUrl,
    secret: set('ALERT_SECRET') ?? createHash('sha256').update(`opening-bell-alerts:${smtp ?? ''}:${priv ?? ''}:${token ?? ''}`).digest('hex'),
  };
}

export type Sent = 'ok' | 'gone' | 'retry';

// ---------------------------------------------------------------- push

export type PushSend = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { TTL: number; vapidDetails: { subject: string; publicKey: string; privateKey: string } }) => Promise<{ statusCode: number }>;

export function pushSender(cfg: NonNullable<AlertConfig['push']>, send: PushSend = webpush.sendNotification as unknown as PushSend) {
  const vapidDetails = { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey };
  return async (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, item: AlertItem): Promise<Sent> => {
    try {
      await send(sub, JSON.stringify({ title: item.title, body: item.body, url: item.href, tag: item.key }), { TTL: 600, vapidDetails });
      return 'ok';
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // The push service says the browser no longer wants this subscription.
      if (code === 404 || code === 410) return 'gone';
      return 'retry';
    }
  };
}

// ---------------------------------------------------------------- email

export type Mail = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };
export type MailTransport = { sendMail(m: { from: string; to: string; subject: string; text: string; html?: string; headers?: Record<string, string> }): Promise<unknown> };

export function mailSender(cfg: NonNullable<AlertConfig['email']>, transport: MailTransport = nodemailer.createTransport(cfg.url)) {
  return async (m: Mail): Promise<Sent> => {
    try {
      await transport.sendMail({ from: cfg.from, ...m });
      return 'ok';
    } catch (e) {
      // A refused recipient is final; a connection problem is worth another try on the next pass.
      const code = (e as { responseCode?: number }).responseCode;
      return code !== undefined && code >= 500 && code < 600 ? 'gone' : 'retry';
    }
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function confirmationMail(to: string, confirmUrl: string, unsubscribeUrl: string): Mail {
  const text = `Someone asked for Opening Bell alerts to be sent to this address. If that was you, confirm here:\n\n${confirmUrl}\n\nIf it was not, ignore this message: nothing is sent until you confirm, and the request is deleted after a day.\n\nRemove this address at any time: ${unsubscribeUrl}\n`;
  return {
    to,
    subject: 'Confirm your Opening Bell alerts',
    text,
    html: `<p>Someone asked for Opening Bell alerts to be sent to this address. If that was you, confirm here:</p><p><a href="${esc(confirmUrl)}">${esc(confirmUrl)}</a></p><p>If it was not, ignore this message: nothing is sent until you confirm, and the request is deleted after a day.</p><p><a href="${esc(unsubscribeUrl)}">Remove this address</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
  };
}

export function alertMail(to: string, item: AlertItem, base: string | null, unsubscribeUrl: string): Mail {
  const link = base ? `${base}${item.href}` : item.href;
  return {
    to,
    subject: item.title,
    text: `${item.body}\n\n${link}\n\nStop these emails: ${unsubscribeUrl}\n`,
    html: `<p><strong>${esc(item.title)}</strong></p><p>${esc(item.body)}</p><p><a href="${esc(link)}">${esc(link)}</a></p><p style="color:#5a5a62;font-size:12px"><a href="${esc(unsubscribeUrl)}">Stop these emails</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
  };
}

// ---------------------------------------------------------------- telegram

type Fetch = typeof fetch;
export type TelegramUpdate = { update_id: number; message?: { chat: { id: number; type: string }; text?: string } };

export function telegramClient(cfg: NonNullable<AlertConfig['telegram']>, fetchImpl: Fetch = fetch) {
  const call = async (method: string, body: unknown): Promise<{ ok: boolean; result?: unknown; error_code?: number }> => {
    const r = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return (await r.json()) as { ok: boolean; result?: unknown; error_code?: number };
  };
  return {
    username: cfg.username,
    async send(chatId: string, text: string): Promise<Sent> {
      try {
        const r = await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
        if (r.ok) return 'ok';
        // 403: the person blocked the bot. 400 with a chat that does not exist is final too.
        return r.error_code === 403 || r.error_code === 400 ? 'gone' : 'retry';
      } catch {
        return 'retry';
      }
    },
    async updates(offset: number): Promise<TelegramUpdate[]> {
      const r = await call('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      return r.ok ? ((r.result as TelegramUpdate[]) ?? []) : [];
    },
  };
}

export const telegramText = (item: AlertItem, base: string | null) => `${item.title}\n${item.body}\n${base ? `${base}${item.href}` : item.href}`;
