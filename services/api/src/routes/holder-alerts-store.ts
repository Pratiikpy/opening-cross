// Storage for alert subscriptions and the record of what was delivered (ADR-0400). Tables are created on first use, like the
// gate allowlists. A subscription holds only what is needed to reach the person: a browser push endpoint, an email address or a
// Telegram chat, the public wallet address it watches (optional), and the topics and followed crosses. The management token is
// stored hashed. Deleting a subscription deletes its delivery record with it.
import type { CalendarFact, Channel, CrossFact, OrderFact, Topic } from './holder-alerts-core.js';

export type Db = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

export type Subscription = {
  id: string;
  channel: Channel;
  destination: string;
  /** Push only: the keys of the browser's subscription. */
  keys: { p256dh: string; auth: string } | null;
  wallet: string | null;
  topics: Topic[];
  watch: string[];
  confirmed: boolean;
  tokenHash: string;
  createdAt: number;
  lastConfirmMailAt: number | null;
};

export type NewSubscription = Omit<Subscription, 'createdAt' | 'lastConfirmMailAt'> & { lastConfirmMailAt?: number | null };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alert_subscriptions (
     id            text PRIMARY KEY,
     channel       text NOT NULL CHECK (channel IN ('push', 'email', 'telegram')),
     destination   text NOT NULL,
     keys          jsonb,
     wallet        text,
     topics        text[] NOT NULL,
     watch         text[] NOT NULL DEFAULT '{}',
     confirmed     boolean NOT NULL DEFAULT false,
     token_hash    text NOT NULL,
     created_at    bigint NOT NULL,
     last_mail_at  bigint,
     UNIQUE (channel, destination)
   )`,
  `CREATE INDEX IF NOT EXISTS alert_subscriptions_wallet ON alert_subscriptions (wallet) WHERE wallet IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS alert_deliveries (
     sub_id    text NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
     key       text NOT NULL,
     sent_at   bigint NOT NULL,
     status    text NOT NULL,
     PRIMARY KEY (sub_id, key)
   )`,
  // Telegram: a one-time code the person sends to the bot; the bot's reply links the chat to the pending subscription.
  `CREATE TABLE IF NOT EXISTS alert_telegram_codes (
     code    text PRIMARY KEY,
     sub_id  text NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
     expires bigint NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS alert_telegram_cursor (id smallint PRIMARY KEY CHECK (id = 1), next_update bigint NOT NULL)`,
];

const num = (v: unknown): number => Number(v);

function rowToSub(r: Record<string, unknown>): Subscription {
  return {
    id: String(r.id),
    channel: r.channel as Channel,
    destination: String(r.destination),
    keys: (r.keys as Subscription['keys']) ?? null,
    wallet: (r.wallet as string | null) ?? null,
    topics: r.topics as Topic[],
    watch: r.watch as string[],
    confirmed: Boolean(r.confirmed),
    tokenHash: String(r.token_hash),
    createdAt: num(r.created_at),
    lastConfirmMailAt: r.last_mail_at === null || r.last_mail_at === undefined ? null : num(r.last_mail_at),
  };
}

export type AlertStore = ReturnType<typeof alertStore>;

export function alertStore(db: Db) {
  let ready: Promise<unknown> | null = null;
  const init = () =>
    (ready ??= (async () => {
      for (const sql of SCHEMA) await db.query(sql);
    })().catch((e) => {
      ready = null;
      throw e;
    }));
  const q = async (text: string, params: unknown[] = []) => {
    await init();
    return (await db.query(text, params)).rows;
  };

  return {
    init,

    async get(id: string): Promise<Subscription | null> {
      const rows = await q('SELECT * FROM alert_subscriptions WHERE id = $1', [id]);
      return rows[0] ? rowToSub(rows[0]) : null;
    },

    async byDestination(channel: Channel, destination: string): Promise<Subscription | null> {
      const rows = await q('SELECT * FROM alert_subscriptions WHERE channel = $1 AND destination = $2', [channel, destination]);
      return rows[0] ? rowToSub(rows[0]) : null;
    },

    async countForWallet(wallet: string): Promise<number> {
      const rows = await q('SELECT count(*)::int AS n FROM alert_subscriptions WHERE wallet = $1', [wallet]);
      return num(rows[0]?.n ?? 0);
    },

    async create(s: NewSubscription, now: number): Promise<void> {
      await q(
        `INSERT INTO alert_subscriptions (id, channel, destination, keys, wallet, topics, watch, confirmed, token_hash, created_at, last_mail_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
        [s.id, s.channel, s.destination, s.keys ? JSON.stringify(s.keys) : null, s.wallet, s.topics, s.watch, s.confirmed, s.tokenHash, now, s.lastConfirmMailAt ?? null],
      );
    },

    /** Replaces a subscription of the same channel and destination (a browser re-subscribing, an address asking again). Returns the id kept. */
    async replace(existing: Subscription, s: NewSubscription): Promise<void> {
      await q(
        `UPDATE alert_subscriptions SET keys = $2::jsonb, wallet = $3, topics = $4, watch = $5, token_hash = $6, confirmed = $7, last_mail_at = COALESCE($8, last_mail_at) WHERE id = $1`,
        [existing.id, s.keys ? JSON.stringify(s.keys) : null, s.wallet, s.topics, s.watch, s.tokenHash, s.confirmed, s.lastConfirmMailAt ?? null],
      );
    },

    async setInterest(id: string, wallet: string | null, topics: Topic[], watch: string[]): Promise<void> {
      await q('UPDATE alert_subscriptions SET wallet = $2, topics = $3, watch = $4 WHERE id = $1', [id, wallet, topics, watch]);
    },

    async confirm(id: string): Promise<void> {
      await q('UPDATE alert_subscriptions SET confirmed = true WHERE id = $1', [id]);
    },

    async setConfirmMailAt(id: string, at: number): Promise<void> {
      await q('UPDATE alert_subscriptions SET last_mail_at = $2 WHERE id = $1', [id, at]);
    },

    async remove(id: string): Promise<boolean> {
      const rows = await q('DELETE FROM alert_subscriptions WHERE id = $1 RETURNING id', [id]);
      return rows.length > 0;
    },

    async removeByDestination(channel: Channel, destination: string): Promise<void> {
      await q('DELETE FROM alert_subscriptions WHERE channel = $1 AND destination = $2', [channel, destination]);
    },

    async listConfirmed(): Promise<Subscription[]> {
      return (await q('SELECT * FROM alert_subscriptions WHERE confirmed ORDER BY created_at')).map(rowToSub);
    },

    /** Records a delivery under its key; false when it was already sent (or is being sent), so the caller must not send it again. A failed one may be claimed again. */
    async claimDelivery(subId: string, key: string, now: number): Promise<boolean> {
      const rows = await q(`INSERT INTO alert_deliveries (sub_id, key, sent_at, status) VALUES ($1, $2, $3, 'sending')
         ON CONFLICT (sub_id, key) DO UPDATE SET status = 'sending', sent_at = EXCLUDED.sent_at WHERE alert_deliveries.status = 'failed' RETURNING key`, [subId, key, now]);
      return rows.length > 0;
    },

    async finishDelivery(subId: string, key: string, status: 'sent' | 'failed'): Promise<void> {
      await q('UPDATE alert_deliveries SET status = $3 WHERE sub_id = $1 AND key = $2', [subId, key, status]);
    },

    /** Deletions older than a day are not needed: an event's window has passed. */
    async pruneDeliveries(before: number): Promise<void> {
      await q('DELETE FROM alert_deliveries WHERE sent_at < $1', [before]);
    },

    // ---- facts the rules read: the indexer's own tables.
    async crosses(addresses: readonly string[]): Promise<CrossFact[]> {
      if (addresses.length === 0) return [];
      const rows = await q('SELECT address, state, open_ts, close_ts FROM crosses WHERE address = ANY($1::text[])', [addresses]);
      return rows.map((r) => ({ address: String(r.address), state: String(r.state), openTs: num(r.open_ts), closeTs: num(r.close_ts) }));
    },

    /** Orders of these wallets that are neither cancelled nor paid out. */
    async openOrders(wallets: readonly string[]): Promise<OrderFact[]> {
      if (wallets.length === 0) return [];
      const rows = await q(`SELECT owner, cross_address, status FROM orders WHERE owner = ANY($1::text[]) AND status IN ('committed', 'revealed')`, [wallets]);
      return rows.map((r) => ({ owner: String(r.owner), cross: String(r.cross_address), status: String(r.status) }));
    },

    async calendars(addresses: readonly string[]): Promise<CalendarFact[]> {
      if (addresses.length === 0) return [];
      const rows = await q('SELECT address, sessions FROM calendars WHERE address = ANY($1::text[])', [addresses]);
      return rows.map((r) => {
        const s = (typeof r.sessions === 'string' ? JSON.parse(r.sessions) : r.sessions) as { startTs: string | number; endTs: string | number }[];
        return { address: String(r.address), sessions: s.map((x) => ({ startTs: num(x.startTs), endTs: num(x.endTs) })) };
      });
    },

    // ---- Telegram linking
    async newTelegramCode(subId: string, code: string, expires: number): Promise<void> {
      await q('INSERT INTO alert_telegram_codes (code, sub_id, expires) VALUES ($1, $2, $3)', [code, subId, expires]);
    },

    /** Consumes a code: returns the pending subscription it belongs to, or null if unknown or expired. */
    async takeTelegramCode(code: string, now: number): Promise<string | null> {
      const rows = await q('DELETE FROM alert_telegram_codes WHERE code = $1 AND expires > $2 RETURNING sub_id', [code, now]);
      return rows[0] ? String(rows[0].sub_id) : null;
    },

    async setDestination(id: string, destination: string): Promise<void> {
      await q('UPDATE alert_subscriptions SET destination = $2, confirmed = true WHERE id = $1', [id, destination]);
    },

    async telegramCursor(): Promise<number> {
      const rows = await q('SELECT next_update FROM alert_telegram_cursor WHERE id = 1');
      return rows[0] ? num(rows[0].next_update) : 0;
    },

    async setTelegramCursor(next: number): Promise<void> {
      await q('INSERT INTO alert_telegram_cursor (id, next_update) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET next_update = EXCLUDED.next_update', [next]);
    },

    /** Unconfirmed subscriptions are dropped after a day, so an address nobody confirmed is not kept. */
    async pruneUnconfirmed(before: number): Promise<void> {
      await q('DELETE FROM alert_subscriptions WHERE NOT confirmed AND created_at < $1', [before]);
    },
  };
}
