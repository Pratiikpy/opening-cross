// Where the monitor speaks: standard output as JSON lines, a file, a webhook. A destination that fails is reported to the others
// and never stops the monitor or the pause.
import { appendFileSync } from 'node:fs';
import type { Notifier } from './types.js';

type Event = Parameters<Notifier['notify']>[0];
const line = (e: Event) => JSON.stringify({ ...e, at: new Date(e.at * 1000).toISOString() }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export const consoleNotifier = (write: (s: string) => void = (s) => console.log(s)): Notifier => ({ notify: async (e) => write(line(e)) });

export const fileNotifier = (path: string): Notifier => ({
  notify: async (e) => {
    appendFileSync(path, line(e) + '\n');
  },
});

/** POSTs each event as JSON. Works with any endpoint that takes a JSON body (a chat webhook, an incident tool, a bridge to a messaging app). */
export const webhookNotifier = (url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Notifier => ({
  notify: async (e) => {
    const res = await (o.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line(e), signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) });
    if (!res.ok) throw new Error(`the webhook answered HTTP ${res.status}`);
  },
});

export function combine(notifiers: readonly Notifier[], onError: (e: unknown) => void = (e) => console.error(`notifier failed: ${String(e)}`)): Notifier {
  return {
    notify: async (e) => {
      await Promise.all(notifiers.map((n) => n.notify(e).catch(onError)));
    },
  };
}
