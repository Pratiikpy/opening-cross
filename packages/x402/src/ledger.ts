// The payment ledger in Postgres. `x402_attempts` carries one payment through its states; the unique primary key is what
// makes "one payment buys exactly one response" true under concurrency: of two requests presenting the same payment, the
// database lets exactly one claim it. `x402_payments` records each payment that settled, once, for the billing service.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Protocol = 'x402' | 'mpp';
export type AttemptStatus = 'pending' | 'unconfirmed' | 'settled' | 'delivered' | 'failed' | 'aborted';

export type NewAttempt = {
  paymentKey: string;
  protocol: Protocol;
  payer: string;
  route: string;
  amount: bigint;
  mint: string;
  payTo: string;
  network: string;
  requestHash: string;
};

export type Attempt = NewAttempt & { status: AttemptStatus; reason: string | null; signature: string | null; redelivered: number; recovered: boolean; createdAt: Date; settledAt: Date | null; deliveredAt: Date | null };

export type Claim = { outcome: 'claimed' } | { outcome: 'exists'; attempt: Attempt };

export async function migrate(db: pg.Pool | pg.Client): Promise<string[]> {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  // The advisory lock belongs to one session, so a pool lends one connection for the whole run.
  const c = db instanceof pg.Pool ? await db.connect() : db;
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1))', ['x402_migrations']);
    try {
      await c.query('CREATE TABLE IF NOT EXISTS x402_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
        if ((await c.query('SELECT 1 FROM x402_migrations WHERE name = $1', [f])).rowCount) continue;
        await c.query('BEGIN');
        try {
          await c.query(readFileSync(dir + f, 'utf8'));
          await c.query('INSERT INTO x402_migrations (name) VALUES ($1)', [f]);
          await c.query('COMMIT');
          applied.push(f);
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', ['x402_migrations']);
    }
  } finally {
    if (c !== db) (c as pg.PoolClient).release();
  }
  return applied;
}

type Row = {
  payment_key: string; protocol: Protocol; payer: string; route: string; amount: string; mint: string; pay_to: string; network: string; request_hash: string;
  status: AttemptStatus; reason: string | null; signature: string | null; redelivered: number; recovered: boolean; created_at: Date; settled_at: Date | null; delivered_at: Date | null;
};

const attemptOf = (r: Row): Attempt => ({
  paymentKey: r.payment_key, protocol: r.protocol, payer: r.payer, route: r.route, amount: BigInt(r.amount), mint: r.mint, payTo: r.pay_to, network: r.network, requestHash: r.request_hash,
  status: r.status, reason: r.reason, signature: r.signature, redelivered: r.redelivered, recovered: r.recovered, createdAt: r.created_at, settledAt: r.settled_at, deliveredAt: r.delivered_at,
});

export class PaymentLedger {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Claims a payment for this request. `claimed` means the caller owns it and must finish it with one of settled, failed
   * or aborted. `exists` returns the row another request holds. An aborted payment (nothing was charged) is claimed again.
   */
  async claim(a: NewAttempt): Promise<Claim> {
    const ins = await this.db.query(
      `INSERT INTO x402_attempts (payment_key, protocol, payer, route, amount, mint, pay_to, network, request_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') ON CONFLICT (payment_key) DO NOTHING`,
      [a.paymentKey, a.protocol, a.payer, a.route, a.amount.toString(), a.mint, a.payTo, a.network, a.requestHash],
    );
    if (ins.rowCount === 1) return { outcome: 'claimed' };
    // Only the same request may take back an aborted payment: it paid for that request and no other.
    const re = await this.db.query(`UPDATE x402_attempts SET status = 'pending', reason = NULL WHERE payment_key = $1 AND status = 'aborted' AND request_hash = $2 AND route = $3`, [a.paymentKey, a.requestHash, a.route]);
    if (re.rowCount === 1) return { outcome: 'claimed' };
    const { rows } = await this.db.query('SELECT * FROM x402_attempts WHERE payment_key = $1', [a.paymentKey]);
    return { outcome: 'exists', attempt: attemptOf(rows[0] as Row) };
  }

  /** Records the settlement signature before the transaction is broadcast, so a crash can be reconciled against chain. */
  async recordSignature(paymentKey: string, signature: string): Promise<void> {
    await this.db.query(`UPDATE x402_attempts SET signature = $2 WHERE payment_key = $1 AND status = 'pending'`, [paymentKey, signature]);
  }

  /**
   * The transfer is on chain: closes the attempt as settled and appends the payment. Idempotent. `recovered` says the
   * chain was consulted because the request that sent the transfer never reported back.
   */
  async settled(paymentKey: string, signature: string, recovered = false): Promise<void> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const up = await c.query(`UPDATE x402_attempts SET status = 'settled', signature = $2, settled_at = now(), recovered = $3 WHERE payment_key = $1 AND status IN ('pending', 'unconfirmed', 'failed') RETURNING *`, [paymentKey, signature, recovered]);
      if (up.rowCount === 1) {
        const r = up.rows[0] as Row;
        await c.query(
          `INSERT INTO x402_payments (signature, payment_key, protocol, payer, route, amount, mint, pay_to, network, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [signature, paymentKey, r.protocol, r.payer, r.route, r.amount, r.mint, r.pay_to, r.network, r.request_hash],
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async failed(paymentKey: string, reason: string): Promise<void> {
    await this.db.query(`UPDATE x402_attempts SET status = 'failed', reason = $2 WHERE payment_key = $1 AND status IN ('pending', 'unconfirmed')`, [paymentKey, reason.slice(0, 500)]);
  }

  /** The owner sent the transfer and stopped waiting. From here any request may settle the question against the chain. */
  async unconfirmed(paymentKey: string): Promise<void> {
    await this.db.query(`UPDATE x402_attempts SET status = 'unconfirmed' WHERE payment_key = $1 AND status = 'pending'`, [paymentKey]);
  }

  /** The request failed before anything was charged. The same payment may be presented again for the same request. */
  async aborted(paymentKey: string, reason: string): Promise<void> {
    await this.db.query(`UPDATE x402_attempts SET status = 'aborted', reason = $2 WHERE payment_key = $1 AND status = 'pending'`, [paymentKey, reason.slice(0, 500)]);
  }

  async delivered(paymentKey: string): Promise<void> {
    await this.db.query(`UPDATE x402_attempts SET status = 'delivered', delivered_at = now() WHERE payment_key = $1 AND status = 'settled'`, [paymentKey]);
  }

  /**
   * Takes the one redelivery a paid response is owed when the first write to the buyer did not complete: the payment
   * settled and, after a grace period long enough for the original response to have been written, it is still not marked
   * delivered (or settlement was recovered from the chain, so no response was ever attempted). The grace keeps a retry that races the original response from being served twice. Returns false when no
   * redelivery is owed or it was already used.
   */
  async takeRedelivery(paymentKey: string, requestHash: string, graceSeconds = 10): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE x402_attempts SET redelivered = redelivered + 1
       WHERE payment_key = $1 AND status = 'settled' AND redelivered = 0 AND request_hash = $2 AND (recovered OR settled_at < now() - make_interval(secs => $3))`,
      [paymentKey, requestHash, graceSeconds],
    );
    return r.rowCount === 1;
  }

  async get(paymentKey: string): Promise<Attempt | null> {
    const { rows } = await this.db.query('SELECT * FROM x402_attempts WHERE payment_key = $1', [paymentKey]);
    return rows[0] ? attemptOf(rows[0] as Row) : null;
  }

  /** Attempts whose owner is gone: pending for longer than `olderThanSeconds` (a process died), or unconfirmed. */
  async stale(olderThanSeconds: number): Promise<Attempt[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM x402_attempts WHERE (status = 'pending' AND created_at < now() - make_interval(secs => $1)) OR status = 'unconfirmed' ORDER BY created_at LIMIT 200`,
      [olderThanSeconds],
    );
    return rows.map((r) => attemptOf(r as Row));
  }
}
