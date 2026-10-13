// Fees, referrals and revenue accounting over the live protocol (PRODUCT_FEATURES W4, W6; ADR-0010).
//
// What the PROGRAM does: cross_core snapshots a protocol fee at creation (the schedule entry for the kind, capped at a quarter of
// the integrator fee), charges it to the sell side in escrow crosses and to the issuer at finalize in minting crosses, never on a
// bid, a cancel or a refund, and at finalize moves the vault into three places: the protocol fee recipient, the integrator and the
// proceeds recipient. That is all on chain and unchanged here.
// What it does NOT do, and what is therefore accounting and a transfer made by whoever holds the fee wallet: the optional 10%
// referrer share, the 25% reopen rebate pool for registered market makers, the issuer subscription and the listing fee. This module
// computes those exactly (packages/fees, integer arithmetic) from the finalized crosses the chain proves, and states them as
// figures, never as a payment that happened. A referral program-side (a referrer field in the cross) needs a program change.
//
//   GET  /v1/fees/schedule              the schedule read from the Protocol account and the rules around it
//   GET  /v1/fees/ledger?limit=         one line per finalized cross: counters, event and the finalize transaction's own token balances
//   GET  /v1/fees/allocation            where the matched protocol fees go: referrals, rebate pool, operating
//   POST /v1/referrals                  a referral document signed by the referred wallet
//   GET  /v1/referrals?owner=           the referral documents of a wallet
//   GET  /v1/fees/referrals/:referrer   the payouts owed to a referrer, per order
//   GET  /v1/fees/statement/:role/:party?from=&to=   a statement for one party, signed by the attestation key when one is configured
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder, getProtocolDecoder, protocolAddress } from '@opening-cross/sdk';
import {
  type CrossFeeFacts,
  type LedgerEntry,
  type ReferralBody,
  type ReferredOrder,
  type SignedReferral,
  type StatementRole,
  type TransactionBalances,
  KINDS,
  MAX_INTEGRATOR_FEE_BPS,
  MAX_PROTOCOL_FEE_BPS,
  REBATE_SHARE_BPS,
  REFERRAL_SHARE_BPS,
  allocateAll,
  ledgerEntry,
  referralLines,
  referrerStatement,
  signStatement,
  statementFromEntries,
  totalsByMint,
  verifyReferral,
} from '@opening-cross/fees';
import { RequestError } from '../tx.js';
import type { ApiDeps } from '../server.js';

export type FeesDeps = Pick<ApiDeps, 'db' | 'account' | 'clock' | 'network'>;
export type FeesOptions = {
  /** The finalize transaction's token balances, or null if it cannot be fetched. Default: JSON-RPC `getTransaction` at RPC_URL. */
  transaction?: (signature: string) => Promise<TransactionBalances | null>;
  /** Signs statements. Without it they are returned with the body only and `unsigned: true`. */
  signer?: { keyPair: CryptoKeyPair; address: string } | null;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const SUPPLY = ['escrow', 'mint', 'deferred-mint'] as const;
const LEDGER_MAX = 200;

async function rpcTransaction(url: string, signature: string): Promise<TransactionBalances | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429 || res.status >= 500) throw new Error(`HTTP error (${res.status}) from the RPC endpoint`);
  const j = (await res.json()) as { result?: { meta?: { err: unknown; preTokenBalances?: TransactionBalances['preTokenBalances']; postTokenBalances?: TransactionBalances['postTokenBalances'] } } | null; error?: { message: string } };
  if (j.error && /rate limit/i.test(j.error.message)) throw new Error(`HTTP error (429): ${j.error.message}`);
  const meta = j.result?.meta;
  return meta ? { err: meta.err, preTokenBalances: meta.preTokenBalances ?? [], postTokenBalances: meta.postTokenBalances ?? [] } : null;
}

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}

export function registerFees(app: FastifyInstance, d: FeesDeps, opts: FeesOptions = {}): void {
  const cluster = d.network ?? 'unknown';
  const fetchTx = opts.transaction ?? (process.env.RPC_URL ? (s: string) => rpcTransaction(process.env.RPC_URL!, s) : async () => null);
  /** A finalized cross never changes, so its line is computed once. */
  const lines = new Map<string, LedgerEntry>();

  async function ledger(limit: number): Promise<LedgerEntry[]> {
    const { rows } = await d.db.query<{ address: string; signature: string; slot: string; block_time: string | null; protocol_fee: string; integrator_fee: string; proceeds_quote: string }>(
      `SELECT c.address, e.signature, e.slot::text, extract(epoch FROM e.block_time)::bigint::text AS block_time,
              e.payload->>'protocolFee' AS protocol_fee, e.payload->>'integratorFee' AS integrator_fee, e.payload->>'proceedsQuote' AS proceeds_quote
         FROM crosses c JOIN events e ON e.cross_address = c.address AND e.name = 'CrossFinalized'
        WHERE c.state = 'Finalized' ORDER BY e.slot DESC LIMIT $1`,
      [limit],
    );
    const out: LedgerEntry[] = [];
    for (const r of rows) {
      const hit = lines.get(r.signature);
      if (hit) {
        out.push(hit);
        continue;
      }
      const acct = await d.account(r.address as Address);
      if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !CROSS_DISCRIMINATOR.every((b, i) => acct.data[i] === b)) continue;
      const c = getCrossDecoder().decode(acct.data);
      const facts: CrossFeeFacts = {
        cross: r.address, creator: c.creator, kind: KINDS[c.kind]!, supplyMode: SUPPLY[c.supplyMode]!, quoteMint: c.quoteMint, protocolBps: c.protocolFeeBps, integratorBps: c.integratorFeeBps,
        integrator: c.integrator, feeRecipient: c.feeRecipient, proceedsTo: c.proceedsTo, buyerPaid: c.buyerPaid, feesAccrued: c.feesAccrued,
      };
      let tx: TransactionBalances | null = null;
      let transient = false;
      try {
        tx = await fetchTx(r.signature);
      } catch {
        transient = true;
      }
      const entry = ledgerEntry(facts, { signature: r.signature, slot: Number(r.slot), blockTime: r.block_time === null ? null : Number(r.block_time), protocolFee: BigInt(r.protocol_fee), integratorFee: BigInt(r.integrator_fee), proceedsQuote: BigInt(r.proceeds_quote) }, tx);
      // An UNVERIFIED line (the transaction could not be fetched) is not kept: the next request tries again.
      if (!transient && entry.verdict !== 'UNVERIFIED') lines.set(r.signature, entry);
      out.push(entry);
    }
    return out;
  }

  const entryOut = (e: LedgerEntry) => ({
    cross: e.facts.cross, kind: e.facts.kind, supplyMode: e.facts.supplyMode, quoteMint: e.facts.quoteMint, protocolBps: e.facts.protocolBps, integratorBps: e.facts.integratorBps,
    signature: e.recorded.signature, blockTime: e.recorded.blockTime, protocolFee: e.recorded.protocolFee, integratorFee: e.recorded.integratorFee, proceedsQuote: e.recorded.proceedsQuote,
    expected: e.expected, verdict: e.verdict, reasons: e.reasons,
  });

  app.get('/v1/fees/schedule', async (_req, reply) => {
    const acct = await d.account(await protocolAddress());
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS) throw new RequestError(404, 'the protocol account was not found on chain');
    const p = getProtocolDecoder().decode(acct.data);
    return send(reply, {
      schema: 'opening-cross/fee-schedule/v1',
      network: cluster,
      status: 'proposed',
      note: 'The schedule is what the protocol account holds today. The figures are proposals (docs/economics/FEE_MODEL.md); nothing here measures what anyone will pay.',
      feeRecipient: p.feeRecipient,
      paused: p.paused,
      protocolBps: Object.fromEntries(KINDS.map((k, i) => [k, p.feeBps[i]])),
      bounds: { maxProtocolBps: MAX_PROTOCOL_FEE_BPS, maxIntegratorBps: MAX_INTEGRATOR_FEE_BPS },
      rules: [
        'The protocol fee of a cross is snapshotted at creation: the schedule entry for its kind, capped at floor(integrator bps / 4). A later change of the schedule does not touch a cross that exists.',
        'Escrow crosses charge it to the seller, on what is filled. Minting crosses charge it to the issuer at finalize. A bid, a cancel and a refund never pay a fee.',
        'At finalize the vault is paid out to the protocol fee recipient, the integrator and the proceeds recipient.',
      ],
      inProgram: ['the schedule and its snapshot per cross', 'who pays and when', 'the split of the vault at finalize'],
      offChainOnly: {
        referrerShareBps: { value: REFERRAL_SHARE_BPS, kind: 'accounting and a transfer from the fee wallet; cross_core has no referrer field' },
        rebateShareBps: { value: REBATE_SHARE_BPS, kind: 'accounting and a transfer; reopen crosses only; registered market makers other than the company\'s own' },
        subscriptionsAndListing: 'a rate card (packages/fees): the managed service around the program, never a condition of using it',
      },
    });
  });

  app.get('/v1/fees/ledger', async (req, reply) => {
    const raw = (req.query as { limit?: string }).limit;
    const limit = raw === undefined ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX) throw new RequestError(400, `limit must be an integer from 1 to ${LEDGER_MAX}`);
    const entries = await ledger(limit);
    const t = totalsByMint(entries);
    return send(reply, {
      network: cluster,
      method: 'Each line compares three sources: the cross account\'s counters run through the program\'s fee rules, the CrossFinalized event, and the token balance changes of the finalize transaction. MATCH needs all three to agree to the atom; UNVERIFIED means the transaction could not be read, and is never counted.',
      entries: entries.map(entryOut),
      totals: { verified: Object.fromEntries(Object.entries(t.verified).map(([m, v]) => [m, { protocolFee: v.protocolFee, integratorFee: v.integratorFee, crosses: v.crosses }])), unverified: t.unverified, mismatched: t.mismatched },
    });
  });

  // ---------------------------------------------------------------- referrals
  app.post('/v1/referrals', async (req, reply) => {
    const doc = req.body as SignedReferral | null;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.body !== 'object') throw new RequestError(400, 'request body must be a signed referral');
    if (!(await verifyReferral(doc))) throw new RequestError(400, 'the referral is malformed or its signature does not match the referred wallet');
    const b = doc.body;
    const res = await d.db.query(`INSERT INTO referrals (id, owner, referrer, effective_from, nonce, doc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [doc.id, b.owner, b.referrer, b.effectiveFrom, b.nonce, JSON.stringify(doc)]);
    return send(reply, { id: doc.id, stored: res.rowCount === 1, note: 'The referrer is credited 10% of the protocol fee your orders generate from the effective time on. It comes out of the protocol\'s take, never out of the integrator\'s fee or yours, and it is paid by transfer, not by the program.' }, 201);
  });

  app.get('/v1/referrals', async (req, reply) => {
    const owner = addr((req.query as { owner?: string }).owner, 'owner');
    const { rows } = await d.db.query<{ doc: SignedReferral }>('SELECT doc FROM referrals WHERE owner = $1 ORDER BY effective_from, nonce LIMIT 200', [owner]);
    return send(reply, { referrals: rows.map((r) => r.doc) });
  });

  async function payouts(entries: readonly LedgerEntry[]) {
    const bodies = (await d.db.query<{ doc: SignedReferral }>('SELECT doc FROM referrals ORDER BY effective_from, nonce')).rows.map((r) => r.doc.body as ReferralBody);
    const out: ReturnType<typeof referralLines> = [];
    const meta = new Map<string, { quoteMint: string; at: number | null }>();
    for (const e of entries) {
      if (e.verdict !== 'MATCH') continue;
      const { rows } = await d.db.query<{ address: string; owner: string; side: number; escrow: string; fee: string | null; quote_out: string | null; fill: string | null; price: string | null; placed: string | null }>(
        `SELECT o.address, o.owner, o.side, o.escrow::text, o.fee::text, o.quote_out::text, o.fill::text, o.price::text,
                (SELECT extract(epoch FROM ev.block_time)::bigint::text FROM events ev WHERE ev.cross_address = o.cross_address AND ev.name = 'OrderCommitted' AND ev.payload->>'order' = o.address LIMIT 1) AS placed
           FROM orders o WHERE o.cross_address = $1 AND o.status = 'claimed'`,
        [e.facts.cross],
      );
      const orders: ReferredOrder[] = rows
        .filter((r) => r.placed !== null)
        .map((r) => {
          const buy = r.side === 0;
          // A buyer paid its escrow less the refund; a seller earned its payout plus the fee the program took.
          const notional = buy ? BigInt(r.escrow) - BigInt(r.quote_out ?? '0') : BigInt(r.quote_out ?? '0') + BigInt(r.fee ?? '0');
          return { cross: e.facts.cross, order: r.address, owner: r.owner, side: buy ? ('buy' as const) : ('sell' as const), placedAt: Number(r.placed), notional, escrowFee: BigInt(r.fee ?? '0') };
        });
      const ls = referralLines({ cross: e.facts.cross, supplyMode: e.facts.supplyMode, protocolBps: e.facts.protocolBps, integratorBps: e.facts.integratorBps, protocolFee: e.recorded.protocolFee }, orders, bodies);
      for (const l of ls) {
        out.push(l);
        meta.set(l.order, { quoteMint: e.facts.quoteMint, at: e.recorded.blockTime });
      }
    }
    return { lines: out, meta };
  }

  app.get('/v1/fees/referrals/:referrer', async (req, reply) => {
    const referrer = addr((req.params as { referrer: string }).referrer, 'referrer');
    const { lines: ls, meta } = await payouts(await ledger(LEDGER_MAX));
    const mine = ls.filter((l) => l.referrer === referrer);
    const byMint: Record<string, bigint> = {};
    for (const l of mine) byMint[meta.get(l.order)!.quoteMint] = (byMint[meta.get(l.order)!.quoteMint] ?? 0n) + l.payout;
    return send(reply, {
      referrer,
      shareBps: REFERRAL_SHARE_BPS,
      status: 'owed',
      note: 'These are amounts owed from matched finalize transactions. Payment is a transfer from the protocol fee wallet; this route does not record that one was made.',
      payouts: mine.map((l) => ({ ...l, quoteMint: meta.get(l.order)!.quoteMint, at: meta.get(l.order)!.at })),
      totals: byMint,
    });
  });

  app.get('/v1/fees/allocation', async (_req, reply) => {
    const entries = await ledger(LEDGER_MAX);
    const { lines: ls } = await payouts(entries);
    const refByCross = new Map<string, bigint>();
    for (const l of ls) refByCross.set(l.cross, (refByCross.get(l.cross) ?? 0n) + l.payout);
    return send(reply, { network: cluster, basis: 'MATCH ledger lines only', allocation: allocateAll(entries, refByCross), referralShareBps: REFERRAL_SHARE_BPS, rebateShareBps: REBATE_SHARE_BPS });
  });

  app.get('/v1/fees/statement/:role/:party', async (req, reply) => {
    const { role, party } = req.params as { role: string; party: string };
    if (!['integrator', 'issuer', 'protocol', 'referrer'].includes(role)) throw new RequestError(400, 'role must be integrator, issuer, protocol or referrer');
    const who = addr(party, 'party');
    const q = req.query as { from?: string; to?: string };
    const now = d.clock?.() ?? Math.floor(Date.now() / 1000);
    const from = q.from === undefined ? 0 : Number(q.from);
    const to = q.to === undefined ? now + 1 : Number(q.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) throw new RequestError(400, 'from and to must be unix seconds with from < to');
    const entries = await ledger(LEDGER_MAX);
    const body =
      role === 'referrer'
        ? referrerStatement(cluster, who, (await payouts(entries)).lines.map((l) => ({ ...l, quoteMint: entries.find((e) => e.facts.cross === l.cross)!.facts.quoteMint, at: entries.find((e) => e.facts.cross === l.cross)!.recorded.blockTime, paidBy: null })), from, to)
        : statementFromEntries(cluster, role as Exclude<StatementRole, 'referrer'>, who, entries, from, to);
    const signed = opts.signer ? await signStatement(body, opts.signer.keyPair, opts.signer.address) : null;
    return send(reply, signed ?? { body, unsigned: true, reason: 'no attestation key is configured on this deployment' });
  });
}
