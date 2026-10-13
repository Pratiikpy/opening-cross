// Ownership-coin treasuries (programs/treasury, ADR-0014): the read side and the disclosure feed.
//
//   GET  /v1/treasuries                         indexed treasuries with their live chain state
//   GET  /v1/treasuries/:address                one treasury: terms, balances and attestation read from chain, recent events, rights cards, disclosure
//   GET  /v1/treasuries/:address/updates        the owner's signed updates, each with its anchor and the check against the program's Spent events
//   POST /v1/treasuries/:address/updates        submit a signed update and the Memo transaction that anchors it
//
// Chain beats the database: a treasury's state, balances and attestation are read from chain in the request. The indexer's tables
// supply history (events, creation time) and the stored updates. A treasury the indexer has not seen yet is still served from chain
// with `indexed: false`, so the page never shows a stale state as current.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isAddress } from '@solana/kit';
import { getMintDecoder, getTokenDecoder } from '@solana-program/token-2022';
import { TREASURY_DISCRIMINATOR, TREASURY_PROGRAM_ADDRESS, TreasuryState, findVaultPda, getTreasuryDecoder, type Treasury } from '@opening-cross/treasury-client';
import { type TreasuryFacts, rightsCards } from '@opening-cross/rights-card';
import { createIndexerRpc } from '@opening-cross/indexer';
import { RequestError } from '../tx.js';
import { type MemoTx, type SignedUpdate, type UpdateBody, checkAnchor, CLOCK_SKEW_SECONDS, disclosureState, memoTextOf, parseMemo, verifyUpdate } from './treasury-updates.js';

export type TreasuryDeps = {
  db: pg.Pool;
  account: (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
  network?: string;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
  /** Fetches a confirmed transaction in `jsonParsed` form. Defaults to RPC_URL; tests inject one. */
  memoTx?: (signature: string) => Promise<MemoTx | null>;
  /** How many times to look for the memo transaction, a second apart, before refusing the update (default 6). */
  memoAttempts?: number;
  /** Reads the treasury program's upgrade authority; defaults to reading the program accounts through `account`. Tests inject one. */
  upgradeAuthority?: () => Promise<string | null | 'unknown'>;
};

const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

const addressDecoder = getAddressDecoder();
const startsWith = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);

// ---- chain reads

export type Attestation = { address: string; exists: boolean; live: boolean | null; expiry: string | null };

/** Parses a Solana Attestation Service attestation the way crates/sas-attestation does: discriminator 2, nonce, credential, schema, data, signer, expiry. */
export function parseAttestation(d: Uint8Array): { nonce: string; credential: string; schema: string; expiry: bigint } | null {
  if (d[0] !== 2 || d.length < 101) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const key = (at: number) => {
    if (at + 32 > d.length) throw new RangeError('short');
    return d.subarray(at, at + 32);
  };
  try {
    const len = view.getUint32(97, true);
    const expiryAt = 101 + len + 32;
    if (expiryAt + 8 > d.length) return null;
    return { nonce: addressDecoder.decode(key(1)), credential: addressDecoder.decode(key(33)), schema: addressDecoder.decode(key(65)), expiry: view.getBigInt64(expiryAt, true) };
  } catch {
    return null;
  }
}
async function attestationOf(d: TreasuryDeps, treasury: Address, t: Treasury, now: number): Promise<Attestation> {
  const [address] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode('attestation'), getAddressEncoder().encode(t.credential), getAddressEncoder().encode(t.schema), getAddressEncoder().encode(treasury)],
  });
  const acct = await d.account(address);
  if (!acct || acct.owner !== SAS_PROGRAM_ADDRESS || acct.data.length === 0) return { address, exists: false, live: false, expiry: null };
  const a = parseAttestation(acct.data);
  if (!a || a.nonce !== treasury || a.credential !== t.credential || a.schema !== t.schema) return { address, exists: true, live: false, expiry: null };
  return { address, exists: true, live: a.expiry === 0n || a.expiry > BigInt(now), expiry: a.expiry.toString() };
}

async function upgradeAuthorityOf(account: TreasuryDeps['account']): Promise<string | null | 'unknown'> {
  const program = await account(TREASURY_PROGRAM_ADDRESS);
  if (!program || program.owner !== BPF_UPGRADEABLE_LOADER || program.data.length < 36 || new DataView(program.data.buffer, program.data.byteOffset).getUint32(0, true) !== 2) return 'unknown';
  const programData = await account(addressDecoder.decode(program.data.subarray(4, 36)));
  if (!programData || programData.data.length < 45 || new DataView(programData.data.buffer, programData.data.byteOffset).getUint32(0, true) !== 3) return 'unknown';
  // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> } follows the u32 tag.
  return programData.data[12] === 0 ? null : addressDecoder.decode(programData.data.subarray(13, 45));
}

type ChainView = {
  address: Address;
  treasury: Treasury;
  vault: { address: string; balance: bigint | null };
  coin: { supply: bigint | null; mintAuthority: string | null | 'unknown' };
};

/** The treasury account, its vault and its coin mint, or null if `address` is not a treasury of this program. */
async function readChain(d: TreasuryDeps, address: Address, withCoin = true): Promise<ChainView | null> {
  const acct = await d.account(address);
  if (!acct || acct.owner !== TREASURY_PROGRAM_ADDRESS || !startsWith(acct.data, TREASURY_DISCRIMINATOR)) return null;
  const treasury = getTreasuryDecoder().decode(acct.data);
  const [vaultAddress] = await findVaultPda({ treasury: address });
  const [vault, coin] = await Promise.all([d.account(vaultAddress), withCoin ? d.account(treasury.coinMint) : Promise.resolve(null)]);
  const vaultBalance = vault && vault.data.length >= 165 ? getTokenDecoder().decode(vault.data.subarray(0, 165)).amount : null;
  let supply: bigint | null = null;
  let mintAuthority: string | null | 'unknown' = 'unknown';
  if (coin && coin.data.length >= 82) {
    const m = getMintDecoder().decode(coin.data.subarray(0, 82));
    supply = m.supply;
    mintAuthority = m.mintAuthority.__option === 'Some' ? m.mintAuthority.value : null;
  }
  return { address, treasury, vault: { address: vaultAddress, balance: vaultBalance }, coin: { supply, mintAuthority } };
}

const terms = (t: Treasury) => ({
  authority: t.authority,
  coinMint: t.coinMint,
  quoteMint: t.quoteMint,
  quoteDecimals: t.quoteDecimals,
  allowance: t.allowance,
  periodSecs: t.periodSecs,
  graceSecs: t.graceSecs,
  credential: t.credential,
  schema: t.schema,
});

const stateName = (t: Treasury) => (t.state === TreasuryState.Active ? 'Active' : 'Liquidating');

function spendWindow(t: Treasury, now: number) {
  const end = t.periodStart + t.periodSecs;
  const rolled = BigInt(now) >= end;
  return {
    periodStart: t.periodStart,
    periodEnd: end,
    spentInPeriod: rolled ? 0n : t.spentInPeriod,
    allowanceRemaining: rolled ? t.allowance : t.allowance - t.spentInPeriod,
    // Whether the stored window has already ended; the program rolls it forward on the next spend.
    periodElapsed: rolled,
  };
}

// ---- rows

type TreasuryRow = {
  address: string;
  coin_mint: string;
  authority: string;
  allowance: string;
  period_secs: string;
  created_signature: string;
  created_slot: string;
  created_at: string | null;
  state: string;
  spent_total: string;
  spend_count: number;
  lapse_count: number;
  last_lapse_at: string | null;
  liquidation_vault: string | null;
  liquidation_supply: string | null;
  liquidated_at: string | null;
  redeemed_burned: string;
  redeemed_paid: string;
  redemption_count: number;
  last_anchored?: string | null;
  update_count?: string | number;
};

const history = (r: TreasuryRow) => ({
  createdSignature: r.created_signature,
  createdSlot: r.created_slot,
  createdAt: r.created_at === null ? null : Number(r.created_at),
  spentTotal: r.spent_total,
  spendCount: r.spend_count,
  lapseCount: r.lapse_count,
  lastLapseAt: r.last_lapse_at === null ? null : Number(r.last_lapse_at),
  liquidatedAt: r.liquidated_at === null ? null : Number(r.liquidated_at),
  redeemedBurned: r.redeemed_burned,
  redeemedPaid: r.redeemed_paid,
  redemptionCount: r.redemption_count,
});

type UpdateRow = { id: string; treasury: string; sequence: number; previous_id: string | null; signer: string; signature: string; body: UpdateBody; memo_signature: string; memo_slot: string; memo_block_time: string };

async function spentOnChainBetween(db: pg.Pool, treasury: string, from: number, to: number): Promise<string> {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS total FROM treasury_events
     WHERE treasury = $1 AND name = 'Spent' AND block_time >= to_timestamp($2) AND block_time <= to_timestamp($3)`,
    [treasury, from, to],
  );
  return rows[0].total as string;
}

async function updateView(db: pg.Pool, r: UpdateRow) {
  const b = r.body;
  const declared = b.declaredSpentAtoms;
  // The one figure the chain can check: the quote atoms the program's Spent events moved in the span the update says it covers.
  const onChain = declared === null ? null : await spentOnChainBetween(db, r.treasury, b.coveredFrom, b.coveredTo);
  return {
    id: r.id,
    sequence: r.sequence,
    previousId: r.previous_id,
    signer: r.signer,
    signature: r.signature,
    body: b,
    anchor: { signature: r.memo_signature, slot: r.memo_slot, blockTime: Number(r.memo_block_time), memo: memoTextOf(r.treasury, r.sequence, r.id) },
    spendCheck: declared === null ? null : { declaredSpentAtoms: declared, spentOnChainAtoms: onChain, matches: declared === onChain },
  };
}

export function registerTreasury(app: FastifyInstance, d: TreasuryDeps): void {
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);
  const network = d.network ?? 'devnet';
  const memoTx =
    d.memoTx ??
    (async (signature: string) => {
      const url = process.env.RPC_URL;
      if (!url) throw new Error('RPC_URL is not set: cannot verify the memo transaction');
      const rpc = createIndexerRpc(url);
      return (await rpc.getTransaction(signature as never, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }).send()) as unknown as MemoTx | null;
    });
  // The program data account holds the whole program binary; the upgrade authority changes rarely, so read it at most every ten minutes.
  let upgradeCache: { at: number; value: string | null | 'unknown' } | null = null;
  const upgradeAuthority = async (): Promise<string | null | 'unknown'> => {
    if (d.upgradeAuthority) return d.upgradeAuthority();
    if (upgradeCache && now() - upgradeCache.at < 600) return upgradeCache.value;
    const value = await upgradeAuthorityOf(d.account).catch(() => 'unknown' as const);
    if (value !== 'unknown') upgradeCache = { at: now(), value };
    return value;
  };

  const addr = (v: unknown): Address => {
    if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, 'address must be a base58 Solana address');
    return v;
  };

  const lastAnchor = async (treasury: string) => {
    const { rows } = await d.db.query('SELECT max(memo_block_time)::text AS at, count(*)::int AS n FROM treasury_updates WHERE treasury = $1', [treasury]);
    return { at: rows[0].at === null ? null : Number(rows[0].at), n: rows[0].n as number };
  };

  // The list reads two accounts per row from a rate-limited public endpoint. A read is reused for ten seconds, shared between
  // simultaneous requests, and given up on after three: the row is then served from the index with `chain: 'unavailable'`,
  // or from the last good read when there is one.
  const listReads = new Map<string, { at: number; value: Promise<Awaited<ReturnType<typeof readChain>> | 'error'>; good?: Awaited<ReturnType<typeof readChain>> }>();
  const listChain = (address: Address): Promise<Awaited<ReturnType<typeof readChain>> | 'error'> => {
    const hit = listReads.get(address);
    if (hit && Date.now() - hit.at < 10_000) return hit.value;
    const read = readChain(d, address, false);
    const bounded = Promise.race([read, new Promise<'error'>((r) => setTimeout(() => r('error'), 3_000).unref())])
      .catch(() => 'error' as const)
      .then((v) => (v === 'error' && hit?.good ? hit.good : v));
    const entry: { at: number; value: typeof bounded; good?: Awaited<ReturnType<typeof readChain>> } = { at: Date.now(), value: bounded, ...(hit?.good && { good: hit.good }) };
    listReads.set(address, entry);
    void read.then((v) => { if (v) entry.good = v; }, () => undefined);
    return bounded;
  };

  app.get('/v1/treasuries', async (req, reply) => {
    const q = req.query as { state?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    if (q.state !== undefined && q.state !== 'Active' && q.state !== 'Liquidating') throw new RequestError(400, 'state must be Active or Liquidating');
    const { rows } = await d.db.query(
      `SELECT t.*, (SELECT max(memo_block_time)::text FROM treasury_updates u WHERE u.treasury = t.address) AS last_anchored,
              (SELECT count(*) FROM treasury_updates u WHERE u.treasury = t.address)::int AS update_count
       FROM treasuries t ${q.state ? 'WHERE t.state = $2' : ''} ORDER BY t.created_slot DESC LIMIT $1`,
      q.state ? [limit, q.state] : [limit],
    );
    const t = now();
    const treasuries = [];
    for (let i = 0; i < rows.length; i += 4) {
      treasuries.push(
        ...(await Promise.all(
          (rows as TreasuryRow[]).slice(i, i + 4).map(async (r) => {
            // The list needs the state and the vault, not the coin mint: two public-RPC reads per row instead of three.
            const chain = await listChain(r.address as Address);
            const live = chain !== 'error' && chain !== null ? chain : null;
            const periodSecs = Number(r.period_secs);
            return {
              address: r.address,
              coinMint: r.coin_mint,
              authority: r.authority,
              indexedState: r.state,
              chain: chain === 'error' ? 'unavailable' : live ? 'read' : 'not-a-treasury',
              ...(live && {
                state: stateName(live.treasury),
                quoteMint: live.treasury.quoteMint,
                quoteDecimals: live.treasury.quoteDecimals,
                allowance: live.treasury.allowance,
                periodSecs: live.treasury.periodSecs,
                graceSecs: live.treasury.graceSecs,
                spend: spendWindow(live.treasury, t),
                lapsedSince: live.treasury.lapsedSince.__option === 'Some' ? live.treasury.lapsedSince.value : null,
                vaultBalance: live.vault.balance,
              }),
              ...history(r),
              disclosure: disclosureState({
                now: t,
                createdAt: r.created_at === null ? null : Number(r.created_at),
                periodSecs,
                graceSecs: live ? Number(live.treasury.graceSecs) : 0,
                liquidating: (live ? stateName(live.treasury) : r.state) === 'Liquidating',
                lastAnchoredAt: r.last_anchored == null ? null : Number(r.last_anchored),
                updateCount: Number(r.update_count ?? 0),
              }),
            };
          }),
        )),
      );
    }
    return send(reply, { network, program: TREASURY_PROGRAM_ADDRESS, asOf: t, treasuries });
  });

  app.get('/v1/treasuries/:address', async (req, reply) => {
    const address = addr((req.params as { address: string }).address);
    const chain = await readChain(d, address);
    if (!chain) throw new RequestError(404, 'no treasury of this program at that address');
    const t = chain.treasury;
    const at = now();
    const [attestation, upgrade, rowRes, evRes, anchor] = await Promise.all([
      attestationOf(d, address, t, at).catch(() => null),
      upgradeAuthority(),
      d.db.query('SELECT * FROM treasuries WHERE address = $1', [address]),
      d.db.query(`SELECT signature, slot::text, extract(epoch FROM block_time)::bigint::text AS time, name, payload FROM treasury_events WHERE treasury = $1 ORDER BY slot DESC, seq DESC LIMIT 50`, [address]),
      lastAnchor(address),
    ]);
    const row = rowRes.rows[0] as TreasuryRow | undefined;
    const lapsedSince = t.lapsedSince.__option === 'Some' ? t.lapsedSince.value : null;
    const facts: TreasuryFacts = {
      state: stateName(t),
      authority: t.authority,
      quoteDecimals: t.quoteDecimals,
      allowance: t.allowance,
      periodSecs: t.periodSecs,
      periodStart: t.periodStart,
      spentInPeriod: t.spentInPeriod,
      graceSecs: t.graceSecs,
      lapsedSince,
      snapshotVault: t.snapshotVault,
      snapshotSupply: t.snapshotSupply,
      vaultBalance: chain.vault.balance ?? 0n,
      coinSupply: chain.coin.supply ?? 0n,
      coinMintAuthority: chain.coin.mintAuthority === 'unknown' ? null : chain.coin.mintAuthority,
      attestation: attestation === null ? 'unknown' : attestation.live ? 'live' : 'not-live',
      programUpgradeAuthority: upgrade,
      now: BigInt(at),
    };
    // A coin whose mint authority could not be read is not reported as revoked.
    const cards = rightsCards(facts).map((c) => (c.id === 'fixed-supply' && chain.coin.mintAuthority === 'unknown' ? { ...c, now: 'The coin mint could not be read just now.' } : c));
    return send(reply, {
      network,
      program: TREASURY_PROGRAM_ADDRESS,
      asOf: at,
      address,
      indexed: row !== undefined,
      state: stateName(t),
      terms: terms(t),
      spend: spendWindow(t, at),
      lapse: { lapsedSince, graceEndsAt: lapsedSince === null ? null : lapsedSince + t.graceSecs },
      snapshot: t.state === TreasuryState.Liquidating ? { vault: t.snapshotVault, supply: t.snapshotSupply } : null,
      balances: { vaultAddress: chain.vault.address, vault: chain.vault.balance, coinSupply: chain.coin.supply, coinMintAuthority: chain.coin.mintAuthority },
      attestation,
      programUpgradeAuthority: upgrade,
      history: row ? history(row) : null,
      events: evRes.rows.map((e) => ({ signature: e.signature, slot: e.slot, time: e.time === null ? null : Number(e.time), name: e.name, details: e.payload })),
      rights: cards,
      disclosure: disclosureState({
        now: at,
        createdAt: row?.created_at == null ? null : Number(row.created_at),
        periodSecs: Number(t.periodSecs),
        graceSecs: Number(t.graceSecs),
        liquidating: t.state === TreasuryState.Liquidating,
        lastAnchoredAt: anchor.at,
        updateCount: anchor.n,
      }),
    });
  });

  app.get('/v1/treasuries/:address/updates', async (req, reply) => {
    const address = addr((req.params as { address: string }).address);
    const { rows } = await d.db.query('SELECT * FROM treasury_updates WHERE treasury = $1 ORDER BY sequence DESC LIMIT 200', [address]);
    return send(reply, { treasury: address, network, updates: await Promise.all((rows as UpdateRow[]).map((r) => updateView(d.db, r))) });
  });

  app.post('/v1/treasuries/:address/updates', async (req, reply) => {
    const address = addr((req.params as { address: string }).address);
    const raw = req.body as { update?: SignedUpdate; memoSignature?: unknown } | null;
    if (!raw || typeof raw !== 'object' || !raw.update || typeof raw.update !== 'object' || typeof raw.memoSignature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(raw.memoSignature))
      throw new RequestError(400, 'body must be { update: { id, body, signer, signature }, memoSignature }');
    const u = raw.update;
    const chain = await readChain(d, address);
    if (!chain) throw new RequestError(404, 'no treasury of this program at that address');
    if (!u.body || typeof u.body !== 'object') throw new RequestError(400, 'update.body is required');
    if (u.body.treasury !== address) throw new RequestError(400, 'the update names a different treasury');
    if (u.body.authority !== chain.treasury.authority) throw new RequestError(422, 'the update names an authority that is not this treasury\'s authority on chain');
    if (u.body.cluster !== network) throw new RequestError(400, `the update is for cluster ${String(u.body.cluster)}, this API serves ${network}`);
    const v = await verifyUpdate(u).catch(() => ({ ok: false as const, reason: 'MALFORMED' as const }));
    if (!v.ok) throw new RequestError(400, `the update does not verify: ${v.reason}`);

    const dup = await d.db.query('SELECT * FROM treasury_updates WHERE id = $1', [u.id]);
    if (dup.rows[0]) return send(reply, { duplicate: true, update: await updateView(d.db, dup.rows[0] as UpdateRow) }, 200);

    const last = (await d.db.query('SELECT id, sequence, memo_block_time FROM treasury_updates WHERE treasury = $1 ORDER BY sequence DESC LIMIT 1', [address])).rows[0] as { id: string; sequence: number; memo_block_time: string } | undefined;
    const expectSeq = (last?.sequence ?? 0) + 1;
    if (u.body.sequence !== expectSeq || u.body.previousId !== (last?.id ?? null)) throw new RequestError(409, `the next update for this treasury is sequence ${expectSeq} with previousId ${last?.id ?? 'null'}`);

    // The anchor: the Memo must say exactly this update and be signed by the authority. The tx may not be visible to our node yet, so retry briefly.
    const expected = memoTextOf(address, u.body.sequence, u.id);
    if (parseMemo(expected)?.id !== u.id) throw new RequestError(400, 'internal: memo text does not round-trip');
    let tx: MemoTx | null = null;
    const attempts = d.memoAttempts ?? 6;
    for (let i = 0; i < attempts && !tx; i++) {
      tx = await memoTx(raw.memoSignature);
      if (!tx && i + 1 < attempts) await new Promise((r) => setTimeout(r, 1_000));
    }
    let anchor: { slot: number; blockTime: number };
    try {
      anchor = checkAnchor(tx, expected, chain.treasury.authority);
    } catch (e) {
      throw new RequestError((e as { status?: number }).status === 400 ? 400 : 422, (e as Error).message);
    }
    if (u.body.issuedAt > anchor.blockTime + CLOCK_SKEW_SECONDS) throw new RequestError(422, 'the update claims to be signed after the transaction that anchors it');
    if (last && anchor.blockTime < Number(last.memo_block_time)) throw new RequestError(422, 'the anchor is older than the previous update\'s anchor');

    try {
      await d.db.query(
        `INSERT INTO treasury_updates (id, treasury, sequence, previous_id, signer, signature, body, memo_signature, memo_slot, memo_block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [u.id, address, u.body.sequence, u.body.previousId, u.signer, u.signature, JSON.stringify(u.body), raw.memoSignature, anchor.slot, anchor.blockTime],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new RequestError(409, 'an update with that sequence or anchor already exists');
      throw e;
    }
    const stored = (await d.db.query('SELECT * FROM treasury_updates WHERE id = $1', [u.id])).rows[0] as UpdateRow;
    return send(reply, { duplicate: false, update: await updateView(d.db, stored) }, 201);
  });
}
