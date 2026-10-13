// The billing routes.
//
//   GET  /v1/billing/plans                       the rate card's plans, the mint and wallet a payment goes to, the signer of invoices
//   POST /v1/billing/subscribe { plan, issuer }  an unsigned transaction paying the plan price to the revenue wallet, with a plan memo
//   POST /v1/billing/payments { signature }      report a payment: the chain is read back, and the period it buys is recorded
//   GET  /v1/billing/entitlements/:issuer[?at=]  the periods an issuer has paid for, the plan in force, and the crosses used in it
//   POST /v1/billing/invoices { issuer[, at] }   a signed invoice for the period in force at `at`
//   GET  /v1/billing/invoices/:issuer            invoices already issued
//
// A subscription buys the managed service around the program (scheduling, keeper, hosted API, signed bands, support). It never gates
// the program: anyone can create a cross on chain, and the protocol fee is charged either way. Entitlement is a fact other services
// (the scheduler) read; this module does not stop a transaction.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { isAddress } from '@solana/kit';
import { type Signed, documentId, signDocument } from '@opening-cross/attest';
import { type RateCard, PROPOSED_RATE_CARD, entitledAt, entitlementPeriods, formatUnits, subscriptionInvoice } from '@opening-cross/fees';
import { type BillingChain, BillingError, buildSubscriptionTx, readPayment } from './chain.js';
import { invoicesOf, paymentsOf, recordPayment, recurringCrossesIn, saveInvoice } from './store.js';

export const INVOICE_SCHEMA = 'opening-cross/invoice/v1';

export interface BillingOptions {
  /** The token subscriptions are paid in (USDC on mainnet). */
  mint: string;
  /** The wallet that receives them. */
  revenueWallet: string;
  chain: BillingChain;
  rateCard?: RateCard;
  /** Signs invoices. Without it invoices are refused: an unsigned invoice would be a claim nobody can check. */
  signer?: { keyPair: CryptoKeyPair; address: string } | null;
  clock?: () => number;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const addr = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !isAddress(v)) throw new BillingError(`${field} must be a base58 Solana address`);
  return v;
};

export function registerBilling(app: FastifyInstance, d: { db: pg.Pool }, o: BillingOptions): void {
  const card = o.rateCard ?? PROPOSED_RATE_CARD;
  const now = () => o.clock?.() ?? Math.floor(Date.now() / 1000);
  const fmt = (u: bigint) => formatUnits(u, card.currency.decimals, card.currency.symbol);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BillingError) return send(reply, { error: err.message }, err.status);
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return send(reply, { error: e.message ?? 'bad request' }, e.statusCode);
    console.error(JSON.stringify({ at: new Date().toISOString(), billing: String(err) }));
    return send(reply, { error: 'internal error' }, 500);
  });

  app.get('/v1/billing/plans', async (_req, reply) =>
    send(reply, {
      schema: 'opening-cross/billing-plans/v1',
      rateCard: { version: card.version, status: card.status, currency: card.currency },
      status: card.status === 'proposed' ? 'The prices are proposals: nothing measures what issuers will pay, and the founder has not published them (HD1).' : 'published',
      pay: { mint: o.mint, to: o.revenueWallet },
      plans: card.plans.map((p) => ({ ...p, price: fmt(p.priceUnits), overagePerCross: fmt(p.overagePerCrossUnits) })),
      invoiceSigner: o.signer?.address ?? null,
      note: 'A subscription buys the managed service around the program. It never gates the program: anyone can create a cross on chain.',
    }),
  );

  app.post('/v1/billing/subscribe', async (req, reply) => {
    const b = req.body as { plan?: unknown; issuer?: unknown } | null;
    const issuer = addr(b?.issuer, 'issuer');
    const plan = card.plans.find((p) => p.plan === b?.plan);
    if (!plan) throw new BillingError(`plan must be one of ${card.plans.map((p) => p.plan).join(', ')}`);
    const tx = await buildSubscriptionTx(o.chain, { plan: plan.plan, priceUnits: plan.priceUnits, issuer, mint: o.mint, revenueWallet: o.revenueWallet });
    return send(reply, {
      plan: plan.plan,
      price: fmt(plan.priceUnits),
      priceUnits: plan.priceUnits,
      transaction: tx.transaction,
      encoding: 'base64 wire transaction, unsigned; the issuer is the only signer and the fee payer',
      memo: tx.memo,
      from: tx.from,
      to: tx.to,
      lastValidBlockHeight: tx.lastValidBlockHeight,
      next: 'Sign and send it, then POST /v1/billing/payments { signature }.',
    });
  });

  /** "Now", but never earlier than the issuer's latest payment: block times can run ahead of this machine's clock. */
  async function defaultAt(issuer: string): Promise<number> {
    const p = await paymentsOf(d.db, issuer);
    return Math.max(now(), p.at(-1)?.paidAt ?? 0);
  }

  async function entitlementFor(issuer: string, at: number) {
    const payments = await paymentsOf(d.db, issuer);
    const { periods, rejected } = entitlementPeriods(card, payments);
    const current = entitledAt(periods, at);
    const crossesUsed = current ? await recurringCrossesIn(d.db, issuer, current.start, current.end) : 0;
    const plan = current ? card.plans.find((p) => p.plan === current.plan)! : null;
    return {
      issuer,
      at,
      entitled: current !== null,
      current,
      crossesIncluded: plan?.includedCrosses ?? 0,
      crossesUsed,
      crossesOverIncluded: plan ? Math.max(0, crossesUsed - plan.includedCrosses) : 0,
      periods,
      rejectedPayments: rejected.map((r) => ({ ...r, reason: card.plans.some((p) => p.plan === r.plan) ? 'below the plan price' : 'no such plan' })),
    };
  }

  app.post('/v1/billing/payments', async (req, reply) => {
    const sig = (req.body as { signature?: unknown } | null)?.signature;
    if (typeof sig !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new BillingError('signature must be a transaction signature');
    const tx = await o.chain.transaction(sig);
    const facts = await readPayment(tx, sig, { mint: o.mint, revenueWallet: o.revenueWallet });
    const { fresh } = await recordPayment(d.db, facts, o.mint);
    // This machine's clock can be a second or two behind the chain's: a payment is never "in the future" of the answer it just earned.
    const entitlement = await entitlementFor(facts.issuer, Math.max(now(), facts.paidAt));
    const plan = card.plans.find((p) => p.plan === facts.plan);
    return send(
      reply,
      {
        recorded: true,
        fresh,
        payment: { ...facts, amount: fmt(facts.amountUnits) },
        buys: !plan ? 'nothing: no such plan' : facts.amountUnits < plan.priceUnits ? `nothing: ${fmt(facts.amountUnits)} is below the ${fmt(plan.priceUnits)} price of ${plan.plan}` : `one ${plan.periodDays}-day period of ${plan.plan}`,
        entitlement,
      },
      fresh ? 201 : 200,
    );
  });

  app.get('/v1/billing/entitlements/:issuer', async (req, reply) => {
    const issuer = addr((req.params as { issuer: string }).issuer, 'issuer');
    const raw = (req.query as { at?: string }).at;
    const at = raw === undefined ? await defaultAt(issuer) : Number(raw);
    if (!Number.isInteger(at) || at < 0) throw new BillingError('at must be a unix time in seconds');
    return send(reply, { schema: 'opening-cross/entitlement/v1', ...(await entitlementFor(issuer, at)) });
  });

  app.post('/v1/billing/invoices', async (req, reply) => {
    if (!o.signer) throw new BillingError('this deployment has no BILLING_KEYPAIR, so it cannot issue invoices; an unsigned invoice is a claim nobody can check', 409);
    const b = req.body as { issuer?: unknown; at?: unknown } | null;
    const issuer = addr(b?.issuer, 'issuer');
    const at = b?.at === undefined ? await defaultAt(issuer) : Number(b.at);
    if (!Number.isInteger(at) || at < 0) throw new BillingError('at must be a unix time in seconds');
    const e = await entitlementFor(issuer, at);
    if (!e.current) throw new BillingError('the issuer has no paid period covering that time, so there is nothing to invoice', 404);
    const plan = card.plans.find((p) => p.plan === e.current!.plan)!;
    const inv = subscriptionInvoice(card, plan.plan, issuer, e.current.start, e.crossesUsed);
    const paid = (await paymentsOf(d.db, issuer)).find((p) => p.paidAt === e.current!.paymentAt && p.plan === plan.plan)?.amountUnits ?? 0n;
    const final = at >= e.current.end || now() >= e.current.end;
    const body = {
      schema: INVOICE_SCHEMA,
      card: inv.card,
      cardStatus: card.status,
      party: issuer,
      plan: plan.plan,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      final,
      crossesUsed: e.crossesUsed,
      lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitUnits: l.unitUnits.toString(), totalUnits: l.totalUnits.toString() })),
      currency: card.currency.symbol,
      decimals: card.currency.decimals,
      totalUnits: inv.totalUnits.toString(),
      paidUnits: paid.toString(),
      dueUnits: (inv.totalUnits > paid ? inv.totalUnits - paid : 0n).toString(),
      // A final invoice is dated the end of its period, so issuing it twice yields the same signed document and it is kept once.
      issuedAt: final ? inv.periodEnd : now(),
    };
    const signed = await signDocument(body, o.signer.keyPair);
    // Only a finished period is kept: the open one can still change as crosses are created.
    if (final) await saveInvoice(d.db, signed.id, issuer, 'subscription', inv.periodStart, inv.periodEnd, signed);
    return send(reply, { ...signed, kept: final, note: final ? undefined : 'The period is still open; this invoice is a preview and is not kept. It is issued again, final, once the period ends.' }, 200);
  });

  app.get('/v1/billing/invoices/:issuer', async (req, reply) => {
    const issuer = addr((req.params as { issuer: string }).issuer, 'issuer');
    return send(reply, { issuer, invoices: await invoicesOf(d.db, issuer) });
  });
}

export type { Signed };
export { documentId };
