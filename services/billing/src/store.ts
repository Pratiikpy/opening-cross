// Payments and invoices in Postgres. A payment is keyed by its transaction signature, so reporting the same payment twice (a retry, a
// second tab) records it once and extends nothing. The tables are created by services/indexer/migrations/013_billing.sql.
import type pg from 'pg';
import type { PaymentFacts } from './chain.js';

export async function recordPayment(db: pg.Pool, p: PaymentFacts, mint: string): Promise<{ fresh: boolean }> {
  const r = await db.query('INSERT INTO billing_payments (signature, issuer, plan, amount, paid_at, slot, mint) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (signature) DO NOTHING', [p.signature, p.issuer, p.plan, p.amountUnits.toString(), p.paidAt, p.slot, mint]);
  return { fresh: (r.rowCount ?? 0) > 0 };
}

export async function paymentsOf(db: pg.Pool, issuer: string): Promise<{ signature: string; plan: string; paidAt: number; amountUnits: bigint }[]> {
  const { rows } = await db.query<{ signature: string; plan: string; paid_at: string; amount: string }>('SELECT signature, plan, paid_at::text, amount::text FROM billing_payments WHERE issuer = $1 ORDER BY billing_payments.paid_at, signature', [issuer]);
  return rows.map((r) => ({ signature: r.signature, plan: r.plan, paidAt: Number(r.paid_at), amountUnits: BigInt(r.amount) }));
}

/** Recurring crosses (kind 3) the issuer created whose call opens inside [start, end). */
export async function recurringCrossesIn(db: pg.Pool, issuer: string, start: number, end: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM crosses WHERE creator = $1 AND kind = 3 AND open_ts >= $2 AND open_ts < $3', [issuer, start, end]);
  return rows[0]!.n;
}

export async function saveInvoice(db: pg.Pool, id: string, party: string, kind: string, periodStart: number, periodEnd: number, doc: unknown): Promise<void> {
  await db.query('INSERT INTO billing_invoices (id, party, kind, period_start, period_end, doc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [id, party, kind, periodStart, periodEnd, JSON.stringify(doc)]);
}

export async function invoicesOf(db: pg.Pool, party: string): Promise<unknown[]> {
  const { rows } = await db.query<{ doc: unknown }>('SELECT doc FROM billing_invoices WHERE party = $1 ORDER BY billing_invoices.period_start DESC, id LIMIT 100', [party]);
  return rows.map((r) => r.doc);
}
