// The keeper's claim of the protocol's partner fees (row P2, ADR-0480, ADR-0481, ADR-0961).
//
// A cross settled through a Meteora DBC continuation makes its settler PDA the pool's partner, so the partner's share of trading fees accrues in the pool account until
// someone claims it. `claim_partner_fee` is permissionless and pays only the cross's fee recipient (the program refuses any other destination), so the keeper may
// send it. It does so on a schedule, not on every pass: reading a pool is an RPC call per cross, fees change slowly, and a claim costs a transaction fee. A pool is
// read at most once per `everySecs`; a claim is sent only when the accrued partner fee reaches the operator's minimum, so dust is not chased.
//
// What this duty does NOT claim: the partner's migration fee, the partner surplus and the pool-creation fee (each is a one-off, with state the keeper cannot read
// from the pool alone), and the creator's share of trading fees (the issuer claims its own with DBC's instruction).
import type { Address, Instruction } from '@solana/kit';
import { type Cross, CrossState, getCrossDecoder, readCrossExt } from '@opening-cross/cross-core-client';
import { ata, createAtaIdempotent } from '@opening-cross/sdk';
import type { Action, Skip } from './plan.js';
import type { KeeperDeps, PassResult } from './keeper.js';
import type { Perform } from './program-passes.js';

/** Seconds between two looks at one cross's pool (default one hour). */
export const DEFAULT_PARTNER_FEE_EVERY_SECS = 3_600;

export type PartnerFeeConfig = {
  /** A pool is read at most this often. */
  everySecs: number;
  /** A claim is sent when the partner's accrued quote fee reaches this many atoms, or its accrued base fee reaches `minBase`. Both default to 1: any accrued fee. */
  minQuote: bigint;
  minBase: bigint;
};

export const DEFAULT_PARTNER_FEE_CONFIG: PartnerFeeConfig = { everySecs: DEFAULT_PARTNER_FEE_EVERY_SECS, minQuote: 1n, minBase: 1n };

// ------------------------------------------------------------------ reading the pool

// The layout of Meteora's `PoolState` (zero-copy, repr C) after the 8-byte account discriminator, taken from the program's IDL (idls/dynamic_bonding_curve.json, v0.2.1):
// volatility_tracker (64 bytes), then config, creator, base_mint, base_vault and quote_vault (32 each), base_reserve, quote_reserve, protocol_base_fee, protocol_quote_fee,
// partner_base_fee, partner_quote_fee (8 each). The offsets and both discriminators are checked against the IDL file in test/partner-fees.test.ts.
export const POOL_PARTNER_BASE_FEE_OFFSET = 264;
export const POOL_PARTNER_QUOTE_FEE_OFFSET = 272;
/** 8-byte discriminator + `PoolState::INIT_SPACE` (416, asserted by the program). */
export const POOL_ACCOUNT_LEN = 8 + 416;
/** `VirtualPool` and `TransferHookPool`: a continuation whose base mint carries the transfer hook is the second. */
export const POOL_DISCRIMINATORS: readonly (readonly number[])[] = [
  [213, 224, 5, 209, 98, 69, 119, 92],
  [237, 219, 184, 23, 42, 189, 169, 35],
];

export type PartnerFees = { base: bigint; quote: bigint };

/** The partner's accrued, unclaimed trading fees in a DBC pool account; null when the bytes are not a pool of either kind. */
export function readPartnerFees(data: Uint8Array): PartnerFees | null {
  if (data.length < POOL_ACCOUNT_LEN || !POOL_DISCRIMINATORS.some((d) => d.every((b, i) => data[i] === b))) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { base: v.getBigUint64(POOL_PARTNER_BASE_FEE_OFFSET, true), quote: v.getBigUint64(POOL_PARTNER_QUOTE_FEE_OFFSET, true) };
}

// ------------------------------------------------------------------ planning

export type PartnerFeeFacts = { cross: Address; fees: PartnerFees | null };

/** Claims when the accrued partner fee reaches the minimum on either leg; otherwise nothing, and nothing is said (an unremarkable pool is not a skip). */
export function planPartnerClaim(f: PartnerFeeFacts, cfg: PartnerFeeConfig = DEFAULT_PARTNER_FEE_CONFIG): { actions: Action[]; skipped: Skip[] } {
  if (!f.fees) return { actions: [], skipped: [] };
  const { base, quote } = f.fees;
  const due = (quote > 0n && quote >= cfg.minQuote) || (base > 0n && base >= cfg.minBase);
  return due ? { actions: [{ kind: 'claim-partner-fee', cross: f.cross, baseFee: base, quoteFee: quote }], skipped: [] } : { actions: [], skipped: [] };
}

// ------------------------------------------------------------------ the pass

type Adapters = typeof import('@opening-cross/adapters');
let adapters: Promise<Adapters> | null = null;
/** The Meteora adapters are large; they are loaded when this duty first has a cross to look at, not when the keeper starts. */
const loadAdapters = (): Promise<Adapters> => (adapters ??= import('@opening-cross/adapters'));

/** The memory key under which the time of a cross's last look is kept (the keeper's `memory` map is shared with the lifecycle's, whose keys begin with a cross address). */
const lookedAt = (cross: Address) => `partner-fees|${cross}`;
const CHECKED = 'PARTNER_FEES_CHECKED';

export async function partnerFeesPass(d: KeeperDeps, now: bigint, result: PassResult, perform: Perform): Promise<void> {
  const cfg = d.partnerFees ?? DEFAULT_PARTNER_FEE_CONFIG;
  const candidates = await (d.partnerCrosses ?? d.bountyCrosses ?? d.crosses)();
  for (const address of candidates) {
    const last = d.memory?.get(lookedAt(address));
    if (last && now - last.at < BigInt(cfg.everySecs)) continue;
    const raw = await d.fetch(address);
    if (!raw) continue;
    let cross: Cross;
    try {
      cross = getCrossDecoder().decode(raw);
    } catch {
      continue;
    }
    // Only a cross that has cleared can have a pool, and only one whose base mint is bound has opened it.
    if ((cross.state !== CrossState.Cleared && cross.state !== CrossState.Finalized) || !cross.baseBound) continue;
    if (d.accept && !d.accept(cross)) continue;
    const { continuationAddresses } = await loadAdapters();
    const a = await continuationAddresses(address, cross.quoteMint);
    const poolRaw = await d.fetch(a.pool);
    // Looked at, whether or not there was a pool or a fee: the next look is `everySecs` away. A failed claim is retried then too, not on the next pass.
    d.memory?.set(lookedAt(address), { sig: CHECKED, at: now });
    const p = planPartnerClaim({ cross: address, fees: poolRaw ? readPartnerFees(poolRaw) : null }, cfg);
    result.skipped.push(...p.skipped);
    for (const action of p.actions) {
      if (action.kind !== 'claim-partner-fee') continue;
      await perform(d, result, action, async () => [await claimInstructions(d, address, raw)]);
    }
  }
}

/** The fee recipient's two destination accounts are opened first (idempotent, paid by the keeper), then the claim: one transaction. */
async function claimInstructions(d: KeeperDeps, address: Address, raw: Uint8Array): Promise<Instruction[]> {
  const fresh = (await d.fetch(address)) ?? raw;
  const data = getCrossDecoder().decode(fresh);
  const view = { address, data, ext: readCrossExt(fresh) };
  const { buildClaimPartnerFee, TOKEN_2022 } = await loadAdapters();
  const recipient = data.feeRecipient;
  const quoteAta = await ata(recipient, data.quoteMint, data.quoteTokenProgram);
  const baseAta = await ata(recipient, data.baseMint, TOKEN_2022);
  return [
    createAtaIdempotent(d.payer, recipient, data.quoteMint, data.quoteTokenProgram, quoteAta),
    createAtaIdempotent(d.payer, recipient, data.baseMint, TOKEN_2022, baseAta),
    await buildClaimPartnerFee({ cross: view }),
  ];
}
