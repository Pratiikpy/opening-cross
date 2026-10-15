// Storage for alert subscriptions and the record of what was delivered (ADR-0400). Tables are created on first use, like the
// gate allowlists. A subscription holds only what is needed to reach the person: a browser push endpoint, an email address or a
// Telegram chat, the public wallet address it watches (optional), and the topics and followed crosses. The management token is
// stored hashed. Deleting a subscription deletes its delivery record with it.
import type { CalendarFact, Channel, CrossFact, OrderFact, Scope, Topic, TreasuryOutflow, WalletMovement } from './holder-alerts-core.js';

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
  // Insider and team watching (ADR-0940): the balance last accepted as the baseline for each wallet tied to a token, and the falls that were seen.
  `CREATE TABLE IF NOT EXISTS alert_insider_balances (
     mint         text NOT NULL,
     owner        text NOT NULL,
     topic        text NOT NULL CHECK (topic IN ('insider', 'team')),
     basis        text NOT NULL,
     amount       numeric NOT NULL,
     observed_at  bigint NOT NULL,
     PRIMARY KEY (mint, owner)
   )`,
  `CREATE TABLE IF NOT EXISTS alert_movements (
     id           text PRIMARY KEY,
     mint         text NOT NULL,
     owner        text NOT NULL,
     topic        text NOT NULL CHECK (topic IN ('insider', 'team')),
     basis        text NOT NULL,
     before_ppm   integer NOT NULL,
     after_ppm    integer NOT NULL,
     moved_ppm    integer NOT NULL,
     detected_at  bigint NOT NULL,
     latest_tx    text,
     href         text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS alert_movements_mint ON alert_movements (mint, detected_at DESC)`,
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

  /** Whether a table exists in this database. The treasury and integrity tables belong to the indexer's migrations, which a deployment may not have run. */
  const hasTable = async (name: string): Promise<boolean> => Boolean((await q('SELECT to_regclass($1) IS NOT NULL AS ok', [name]))[0]?.ok);

  return {
    init,
    hasTable,

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

    // ---- movements (ADR-0940)

    /** For each followed address, the mints and treasuries it stands for: a cross its base token, a treasury its ownership coin, anything else itself as a possible token mint. */
    async scopes(watch: readonly string[]): Promise<Map<string, Scope>> {
      const out = new Map<string, Scope>();
      if (watch.length === 0) return out;
      const crosses = new Map((await q('SELECT address, base_mint FROM crosses WHERE address = ANY($1::text[])', [watch])).map((r) => [String(r.address), String(r.base_mint)]));
      const calendars = new Set((await q('SELECT address FROM calendars WHERE address = ANY($1::text[])', [watch])).map((r) => String(r.address)));
      const candidates = [...new Set([...watch, ...crosses.values()])];
      const trs = (await hasTable('treasuries')) ? await q('SELECT address, coin_mint FROM treasuries WHERE address = ANY($1::text[]) OR coin_mint = ANY($1::text[])', [candidates]) : [];
      const byAddress = new Map(trs.map((r) => [String(r.address), String(r.coin_mint)]));
      const byCoin = new Map<string, string[]>();
      for (const r of trs) byCoin.set(String(r.coin_mint), [...(byCoin.get(String(r.coin_mint)) ?? []), String(r.address)]);
      for (const w of watch) {
        if (calendars.has(w) && !crosses.has(w) && !byAddress.has(w)) {
          out.set(w, { mints: [], treasuries: [] });
          continue;
        }
        const mints = new Set<string>();
        const treasuries = new Set<string>();
        const base = crosses.get(w);
        if (base) mints.add(base);
        else if (byAddress.has(w)) {
          treasuries.add(w);
          mints.add(byAddress.get(w)!);
        } else mints.add(w);
        for (const m of [...mints]) for (const t of byCoin.get(m) ?? []) treasuries.add(t);
        out.set(w, { mints: [...mints], treasuries: [...treasuries] });
      }
      return out;
    },

    /** What the index knows an address to be. `other` covers an address the index has never seen (it may still be a token mint on chain). */
    async kindOf(address: string): Promise<'cross' | 'treasury' | 'market' | 'other'> {
      if ((await q('SELECT 1 FROM crosses WHERE address = $1', [address])).length > 0) return 'cross';
      if ((await hasTable('treasuries')) && (await q('SELECT 1 FROM treasuries WHERE address = $1', [address])).length > 0) return 'treasury';
      if ((await q('SELECT 1 FROM calendars WHERE address = $1', [address])).length > 0) return 'market';
      return 'other';
    },

    async balanceOf(mint: string, owner: string): Promise<{ amount: bigint; observedAt: number } | null> {
      const rows = await q('SELECT amount::text AS amount, observed_at FROM alert_insider_balances WHERE mint = $1 AND owner = $2', [mint, owner]);
      return rows[0] ? { amount: BigInt(String(rows[0].amount)), observedAt: num(rows[0].observed_at) } : null;
    },

    async setBalance(mint: string, owner: string, topic: 'insider' | 'team', basis: string, amount: bigint, now: number): Promise<void> {
      await q(
        `INSERT INTO alert_insider_balances (mint, owner, topic, basis, amount, observed_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (mint, owner) DO UPDATE SET topic = EXCLUDED.topic, basis = EXCLUDED.basis, amount = EXCLUDED.amount, observed_at = EXCLUDED.observed_at`,
        [mint, owner, topic, basis, amount.toString(), now],
      );
    },

    /** Marks a baseline as still current without changing it (no change, or a fall below the threshold). */
    async touchBalance(mint: string, owner: string, now: number): Promise<void> {
      await q('UPDATE alert_insider_balances SET observed_at = $3 WHERE mint = $1 AND owner = $2', [mint, owner, now]);
    },

    async pruneBalances(before: number): Promise<void> {
      await q('DELETE FROM alert_insider_balances WHERE observed_at < $1', [before]);
      await q('DELETE FROM alert_movements WHERE detected_at < $1', [before]);
    },

    /** Records a fall once: the id is derived from the wallet, the two balances and the time, so a repeat of the same scan adds nothing. */
    async recordMovement(m: WalletMovement): Promise<boolean> {
      const rows = await q(
        `INSERT INTO alert_movements (id, mint, owner, topic, basis, before_ppm, after_ppm, moved_ppm, detected_at, latest_tx, href)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [m.id, m.subject, m.wallet, m.topic, m.basis, m.beforePpm, m.afterPpm, m.movedPpm, m.at, m.latestTx, m.href],
      );
      return rows.length > 0;
    },

    async walletMovements(mints: readonly string[], since: number): Promise<WalletMovement[]> {
      if (mints.length === 0) return [];
      const rows = await q('SELECT * FROM alert_movements WHERE mint = ANY($1::text[]) AND detected_at >= $2 ORDER BY detected_at DESC LIMIT 200', [mints, since]);
      return rows.map((r) => ({
        topic: r.topic as 'insider' | 'team',
        id: String(r.id),
        subject: String(r.mint),
        at: num(r.detected_at),
        wallet: String(r.owner),
        basis: String(r.basis),
        beforePpm: num(r.before_ppm),
        afterPpm: num(r.after_ppm),
        movedPpm: num(r.moved_ppm),
        latestTx: (r.latest_tx as string | null) ?? null,
        href: String(r.href),
      }));
    },

    /** The latest cross selling a token, for the link an insider alert carries. */
    async latestCrossFor(mint: string): Promise<string | null> {
      const rows = await q('SELECT address FROM crosses WHERE base_mint = $1 ORDER BY created_slot DESC LIMIT 1', [mint]);
      return rows[0] ? String(rows[0].address) : null;
    },

    /** The crosses that sell a token, newest first, with their creators. */
    async crossesSelling(mint: string): Promise<{ address: string; creator: string }[]> {
      return (await q('SELECT address, creator FROM crosses WHERE base_mint = $1 ORDER BY created_slot DESC LIMIT 20', [mint])).map((r) => ({ address: String(r.address), creator: String(r.creator) }));
    },

    /** Treasuries of an ownership coin, with their authority. */
    async treasuriesOfCoin(mint: string): Promise<{ address: string; authority: string }[]> {
      if (!(await hasTable('treasuries'))) return [];
      return (await q('SELECT address, authority FROM treasuries WHERE coin_mint = $1', [mint])).map((r) => ({ address: String(r.address), authority: String(r.authority) }));
    },

    /** The issuer's latest signed document of a schema for a token, as stored, or null. */
    async signedDocument(mint: string, schema: string): Promise<unknown | null> {
      if (!(await hasTable('integrity_documents'))) return null;
      const rows = await q('SELECT doc FROM integrity_documents WHERE mint = $1 AND schema = $2 ORDER BY as_of DESC, received_at DESC LIMIT 1', [mint, schema]);
      const doc = rows[0]?.doc;
      return doc === undefined ? null : typeof doc === 'string' ? JSON.parse(doc) : doc;
    },

    /**
     * Value that left these treasuries since `since`, from the indexer's `treasury_movements`. Holders' own redemptions are not an alert. A counterparty is named when it is the
     * treasury's authority or a wallet already known as an insider or team wallet of the ownership coin.
     */
    async treasuryOutflows(treasuries: readonly string[], since: number): Promise<TreasuryOutflow[]> {
      if (treasuries.length === 0 || !(await hasTable('treasury_movements')) || !(await hasTable('treasuries'))) return [];
      const rows = await q(
        `SELECT m.id::text AS id, m.signature, m.seq, extract(epoch FROM m.block_time)::bigint AS at, m.treasury, m.kind, m.asset, m.amount::text AS amount, m.counterparty, m.team_outflow,
                (m.counterparty IS NOT NULL AND m.counterparty = t.authority) AS is_authority, b.topic AS known_topic, b.basis AS known_basis
           FROM treasury_movements m
           LEFT JOIN treasuries t ON t.address = m.treasury
           LEFT JOIN alert_insider_balances b ON b.mint = t.coin_mint AND b.owner = m.counterparty
          WHERE m.treasury = ANY($1::text[]) AND m.direction = 'out' AND m.kind NOT IN ('redemption', 'nav_redemption') AND m.block_time IS NOT NULL AND m.block_time >= to_timestamp($2)
          ORDER BY m.id DESC LIMIT 200`,
        [treasuries, since],
      );
      return rows.map((r) => ({
        topic: 'treasury' as const,
        id: `t:${String(r.signature)}:${num(r.seq)}`,
        subject: String(r.treasury),
        at: num(r.at),
        kind: String(r.kind),
        asset: r.asset as 'quote' | 'coin',
        amount: String(r.amount),
        counterparty: (r.counterparty as string | null) ?? null,
        counterpartyBasis: r.is_authority ? 'the authority of this treasury' : r.known_topic === 'team' ? 'a wallet the issuer declared as team' : r.known_topic === 'insider' ? `a wallet tied to the issuer: it ${String(r.known_basis)}` : null,
        teamOutflow: Boolean(r.team_outflow),
        signature: String(r.signature),
        href: `/treasury/${String(r.treasury)}`,
      }));
    },

    /** Unconfirmed subscriptions are dropped after a day, so an address nobody confirmed is not kept. */
    async pruneUnconfirmed(before: number): Promise<void> {
      await q('DELETE FROM alert_subscriptions WHERE NOT confirmed AND created_at < $1', [before]);
    },
  };
}
