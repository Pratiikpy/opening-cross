// Issuer-side builders for the treasury (ADR-0014) and the fee schedule the issuer's simulator needs. The API never holds a key: every
// transaction comes back unsigned with the issuer as fee payer, and every check that a program would make is made here first, so
// the issuer reads a reason before signing instead of a program error after.
//
//   GET  /v1/issuer/protocol                          the protocol fee schedule per cross kind, read from the cross_core Protocol account
//   POST /v1/tx/create-treasury                       unsigned transaction: create the treasury for a coin whose supply is fixed
//   POST /v1/treasuries/:address/updates/prepare      the next disclosure update's body, id and signing message, for the owner's wallet to sign
//   POST /v1/tx/treasury-memo                         unsigned Memo transaction that anchors a signed update's id on chain
//
// A disclosure update is posted in four steps: prepare (this file), sign the message in the wallet, anchor with the Memo
// transaction, then POST the signed update to /v1/treasuries/:address/updates (routes/treasury.ts), which verifies all of it.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, AccountRole, type Instruction, createNoopSigner, isAddress } from '@solana/kit';
import { getMintDecoder, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import { PROTOCOL_DISCRIMINATOR, findProtocolPda, getProtocolDecoder } from '@opening-cross/cross-core-client';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { TREASURY_DISCRIMINATOR, TREASURY_PROGRAM_ADDRESS, findTreasuryPda, findVaultPda, getCreateTreasuryInstructionAsync, getTreasuryDecoder } from '@opening-cross/treasury-client';
import { type Lifetime, RequestError, compile } from '../tx.js';
import { type UpdateBody, MEMO_PROGRAM, UPDATE_SCHEMA, UPDATE_SIGNING_DOMAIN, SUMMARY_MAX, TITLE_MAX, memoTextOf, updateId, UpdateError } from './treasury-updates.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type IssuerTxDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** The updates table lives in the API's database (routes/treasury.ts); only the last update's id and sequence are read. */
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  network?: string;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

export const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
const KINDS = ['launch', 'reopen', 'tender', 'recurring'] as const;
/** A period or grace beyond this is almost certainly a unit mistake (the program takes seconds). */
const MAX_SECS = 10 * 365 * 86_400;
const U64_MAX = (1n << 64n) - 1n;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'request body must be a JSON object');
  return v as Record<string, unknown>;
}
function u64(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s) || BigInt(s) > U64_MAX) throw new RequestError(400, `${field} must be an unsigned 64-bit integer (decimal string)`);
  return BigInt(s);
}
function secs(v: unknown, field: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > MAX_SECS) throw new RequestError(400, `${field} must be a whole number of seconds from ${min} to ${MAX_SECS}`);
  return v;
}

const isTokenProgram = (a: Address) => a === TOKEN_2022_PROGRAM_ADDRESS || a === SPL_TOKEN_PROGRAM_ADDRESS;

/** The mint's authority state, or the reason the account is not a mint of a token program. */
function readMint(acct: ChainAccount | null): { ok: true; program: Address; mintAuthority: string | null; supply: bigint; decimals: number } | { ok: false; reason: 'NOT_FOUND' | 'NOT_A_MINT' } {
  if (!acct) return { ok: false, reason: 'NOT_FOUND' };
  if (!isTokenProgram(acct.owner) || acct.data.length < 82) return { ok: false, reason: 'NOT_A_MINT' };
  const m = getMintDecoder().decode(acct.data.subarray(0, 82));
  return { ok: true, program: acct.owner, mintAuthority: m.mintAuthority.__option === 'Some' ? m.mintAuthority.value : null, supply: m.supply, decimals: m.decimals };
}

/** An account owned by the Solana Attestation Service, which is all this API can say about a credential or schema address. */
async function expectSas(d: IssuerTxDeps, a: Address, what: 'credential' | 'schema'): Promise<void> {
  const acct = await d.account(a);
  if (!acct) throw new RequestError(422, `The ${what} account ${a} does not exist on this cluster. Create it with the Solana Attestation Service first.`, { reason: `${what.toUpperCase()}_NOT_FOUND`, [what]: a });
  if (acct.owner !== SAS_PROGRAM_ADDRESS) throw new RequestError(422, `The ${what} account ${a} is not owned by the Solana Attestation Service.`, { reason: `${what.toUpperCase()}_NOT_SAS`, [what]: a });
}

export function registerIssuerTx(app: FastifyInstance, d: IssuerTxDeps): void {
  const network = d.network ?? 'devnet';
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);

  app.get('/v1/issuer/protocol', async (_req, reply) => {
    const [pda] = await findProtocolPda();
    const acct = await d.account(pda);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !PROTOCOL_DISCRIMINATOR.every((b, i) => acct.data[i] === b)) throw new RequestError(404, 'the cross_core protocol account was not found on this cluster');
    const p = getProtocolDecoder().decode(acct.data);
    return send(reply, {
      network,
      program: CROSS_CORE_PROGRAM_ADDRESS,
      protocol: pda,
      paused: p.paused,
      feeRecipient: p.feeRecipient,
      guardian: p.guardian,
      admin: p.admin,
      feeBps: Object.fromEntries(KINDS.map((k, i) => [k, p.feeBps[i]])),
      maxIntegratorFeeBps: 300,
    });
  });

  app.post('/v1/tx/create-treasury', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    const coinMint = addr(b.coinMint, 'coinMint');
    const quoteMint = addr(b.quoteMint, 'quoteMint');
    const credential = addr(b.credential, 'credential');
    const schema = addr(b.schema, 'schema');
    const allowance = u64(b.allowance, 'allowance');
    const periodSecs = secs(b.periodSecs, 'periodSecs', 1);
    const graceSecs = secs(b.graceSecs, 'graceSecs', 0);
    if (allowance === 0n) throw new RequestError(400, 'allowance must be above zero');
    if (coinMint === quoteMint) throw new RequestError(400, 'the coin and the quote token must be different tokens');

    const [coinAcct, quoteAcct] = await Promise.all([d.account(coinMint), d.account(quoteMint)]);
    const coin = readMint(coinAcct);
    if (!coin.ok) throw new RequestError(coin.reason === 'NOT_FOUND' ? 404 : 422, coin.reason === 'NOT_FOUND' ? `no account exists at the coin mint ${coinMint}` : `${coinMint} is not a token mint`, { reason: `COIN_${coin.reason}` });
    const quote = readMint(quoteAcct);
    if (!quote.ok) throw new RequestError(quote.reason === 'NOT_FOUND' ? 404 : 422, quote.reason === 'NOT_FOUND' ? `no account exists at the quote mint ${quoteMint}` : `${quoteMint} is not a token mint`, { reason: `QUOTE_${quote.reason}` });
    // The program refuses a coin whose mint authority is still set (SupplyNotFixed). A minting cross revokes it when it finalizes.
    if (coin.mintAuthority !== null)
      throw new RequestError(422, `The coin's supply is not fixed: its mint authority is still ${coin.mintAuthority}. A treasury can only be created after the supply is fixed. If the coin is minted by a cross, wait for the cross to finalize.`, { reason: 'SUPPLY_NOT_FIXED', mintAuthority: coin.mintAuthority });
    if (coin.supply === 0n) throw new RequestError(422, 'The coin has no supply, so there is nobody to hold a claim on the treasury.', { reason: 'NO_SUPPLY' });

    const [treasury] = await findTreasuryPda({ coinMint });
    const existing = await d.account(treasury);
    if (existing) throw new RequestError(409, `a treasury already exists for this coin: ${treasury}`, { reason: 'TREASURY_EXISTS', treasury });
    await expectSas(d, credential, 'credential');
    await expectSas(d, schema, 'schema');

    const ix = await getCreateTreasuryInstructionAsync({
      authority: createNoopSigner(authority),
      coinMint,
      quoteMint,
      quoteTokenProgram: quote.program,
      allowance,
      periodSecs,
      graceSecs,
      credential,
      schema,
    });
    const [vault] = await findVaultPda({ treasury });
    const tx = compile(authority, [ix as unknown as Instruction], await d.lifetime());
    return send(reply, { ...tx, treasury, vault, program: TREASURY_PROGRAM_ADDRESS, coinSupply: coin.supply, quoteDecimals: quote.decimals });
  });

  /** The treasury's authority as the chain holds it. */
  async function authorityOf(treasury: Address): Promise<{ authority: Address }> {
    const acct = await d.account(treasury);
    if (!acct || acct.owner !== TREASURY_PROGRAM_ADDRESS || !TREASURY_DISCRIMINATOR.every((x, i) => acct.data[i] === x)) throw new RequestError(404, 'no treasury of this program at that address');
    return { authority: getTreasuryDecoder().decode(acct.data).authority };
  }

  app.post('/v1/treasuries/:address/updates/prepare', async (req, reply) => {
    const treasury = addr((req.params as { address: string }).address, 'address');
    const b = obj(req.body);
    const { authority } = await authorityOf(treasury);
    if (b.authority !== undefined && b.authority !== authority) throw new RequestError(422, `Only the treasury's authority, ${authority}, can post updates. Connect that wallet.`, { reason: 'NOT_THE_AUTHORITY', authority });
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
    if (title === '' || title.length > TITLE_MAX) throw new RequestError(400, `title must be 1 to ${TITLE_MAX} characters`);
    if (summary === '' || summary.length > SUMMARY_MAX) throw new RequestError(400, `summary must be 1 to ${SUMMARY_MAX} characters`);
    const coveredFrom = typeof b.coveredFrom === 'number' ? b.coveredFrom : Number.NaN;
    const coveredTo = typeof b.coveredTo === 'number' ? b.coveredTo : Number.NaN;
    if (!Number.isSafeInteger(coveredFrom) || !Number.isSafeInteger(coveredTo) || coveredFrom < 0) throw new RequestError(400, 'coveredFrom and coveredTo must be unix seconds');
    if (coveredFrom > coveredTo) throw new RequestError(400, 'coveredFrom must not be after coveredTo');
    const issuedAt = now();
    if (coveredTo > issuedAt) throw new RequestError(400, 'an update cannot cover time that has not happened yet');
    let declared: string | null = null;
    if (b.declaredSpentAtoms !== undefined && b.declaredSpentAtoms !== null && b.declaredSpentAtoms !== '') {
      if (typeof b.declaredSpentAtoms !== 'string' || !/^\d{1,20}$/.test(b.declaredSpentAtoms)) throw new RequestError(400, 'declaredSpentAtoms must be a decimal string of quote atoms');
      declared = b.declaredSpentAtoms;
    }
    const last = (await d.db.query('SELECT id, sequence FROM treasury_updates WHERE treasury = $1 ORDER BY sequence DESC LIMIT 1', [treasury])).rows[0] as { id: string; sequence: number } | undefined;
    const body: UpdateBody = {
      schema: UPDATE_SCHEMA,
      cluster: network,
      treasury,
      authority,
      sequence: (last?.sequence ?? 0) + 1,
      previousId: last?.id ?? null,
      issuedAt,
      coveredFrom,
      coveredTo,
      title,
      summary,
      declaredSpentAtoms: declared,
    };
    let id: string;
    try {
      id = updateId(body);
    } catch (e) {
      if (e instanceof UpdateError) throw new RequestError(400, e.message);
      throw e;
    }
    return send(reply, { body, id, message: UPDATE_SIGNING_DOMAIN + id, memoText: memoTextOf(treasury, body.sequence, id), memoProgram: MEMO_PROGRAM });
  });

  app.post('/v1/tx/treasury-memo', async (req, reply) => {
    const b = obj(req.body);
    const treasury = addr(b.treasury, 'treasury');
    const payer = addr(b.payer, 'payer');
    const { authority } = await authorityOf(treasury);
    if (payer !== authority) throw new RequestError(422, `The anchoring transaction must be signed by the treasury's authority, ${authority}.`, { reason: 'NOT_THE_AUTHORITY', authority });
    const sequence = b.sequence;
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) throw new RequestError(400, 'sequence must be a positive integer');
    if (typeof b.id !== 'string' || !/^[0-9a-f]{64}$/.test(b.id)) throw new RequestError(400, 'id must be 64 lowercase hex characters');
    const memo = { programAddress: MEMO_PROGRAM as Address, accounts: [{ address: authority, role: AccountRole.READONLY_SIGNER }], data: new TextEncoder().encode(memoTextOf(treasury, sequence, b.id)) } as unknown as Instruction;
    return send(reply, { ...compile(authority, [memo], await d.lifetime()), memoText: memoTextOf(treasury, sequence, b.id) });
  });
}
