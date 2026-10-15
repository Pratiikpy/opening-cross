// One pass of the organic-volume attester. For each configured governed cross: find the open round that names this key as its volume attester, read the cross and its orders, run
// the organic-volume analysis (funding clusters, Jito bundle evidence, conflicts), apply the guard, and post the lower bound in quote atoms, or withdraw it, or say nothing.
// Anything the pass cannot read (the order list, the cross, the clearing price) ends that cross's pass with a reason and posts nothing: the attester never states a figure
// from a partial read.
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, ROUND_DISCRIMINATOR, getRoundDecoder } from '@opening-cross/cross-graduate-client';
import { type AnalyzedOrder, type CrossAnalysis, type Flag, type FundingCache, type PlacementStore, analyzeCross, declaredTeamFrom, quoteVolume, type RpcLike } from '@opening-cross/integrity';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, GRADUATE_MAX_ROUNDS, buildPostVolume, getCrossDecoder, roundAddress } from '@opening-cross/sdk';
import type { VolumeConfig } from './config.js';
import { planVolume } from './volume.js';

export type VolumeDeps = {
  signer: TransactionSigner;
  config: VolumeConfig;
  rpc: RpcLike;
  cache: FundingCache & { fanout?: () => Map<string, number> };
  placements: PlacementStore;
  account: (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
  fetchJson: (url: string) => Promise<unknown>;
  send: (ixs: Instruction[]) => Promise<string>;
  dryRun?: boolean;
};

export type CrossOutcome =
  | { cross: Address; status: 'posted'; reason: string; volumeQuote: bigint; signature: string; summary: Summary }
  | { cross: Address; status: 'planned'; reason: string; volumeQuote: bigint; summary: Summary }
  | { cross: Address; status: 'skipped'; code: string; message: string; summary?: Summary }
  | { cross: Address; status: 'failed'; code: string; message: string };

type Summary = { decision: string; policy: string; lowerBps: number; upperBps: number; independentGroups: number; untraced: number; placementsUnknown: number | null; reasons: string[] };

const starts = (data: Uint8Array, d: ArrayLike<number>) => Array.from(d).every((b, i) => data[i] === b);
const big = (v: unknown): bigint | null => (typeof v === 'string' && /^[0-9]{1,40}$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

export async function volumeOnce(deps: VolumeDeps): Promise<CrossOutcome[]> {
  const out: CrossOutcome[] = [];
  for (const cross of deps.config.crosses) out.push(await volumeForCross(deps, cross));
  return out;
}

async function openRound(d: VolumeDeps, cross: Address) {
  for (let i = 0; i < GRADUATE_MAX_ROUNDS; i++) {
    const addr = await roundAddress(cross, i);
    const acct = await d.account(addr);
    if (!acct || acct.owner !== CROSS_GRADUATE_PROGRAM_ADDRESS || !starts(acct.data, ROUND_DISCRIMINATOR as Uint8Array)) continue;
    const round = getRoundDecoder().decode(acct.data);
    if (round.cross === cross && !round.finalized) return { address: addr, round };
  }
  return null;
}

async function volumeForCross(d: VolumeDeps, cross: Address): Promise<CrossOutcome> {
  const fail = (code: string, message: string): CrossOutcome => ({ cross, status: 'failed', code, message });
  const found = await openRound(d, cross);
  if (!found) return { cross, status: 'skipped', code: 'NO_OPEN_ROUND', message: 'the cross has no round that is still open (none started, or every round is finalized)' };
  const attesterIn = found.round.volumeAttester.__option === 'Some' ? found.round.volumeAttester.value : null;
  if (attesterIn !== d.signer.address) return { cross, status: 'failed', code: 'NOT_OUR_ROUND', message: `the round names ${attesterIn ?? 'nobody'} as its volume attester, not ${d.signer.address}; this key cannot attest it` };

  const crossAcct = await d.account(cross);
  if (!crossAcct || crossAcct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(crossAcct.data, CROSS_DISCRIMINATOR as Uint8Array)) return fail('NO_CROSS', 'the cross account was not found on chain');
  const c = getCrossDecoder().decode(crossAcct.data);
  if (c.clearing.__option !== 'Some') return { cross, status: 'skipped', code: 'NO_CLEARING', message: 'the cross has no clearing price, so it has no volume in quote atoms' };
  const { price } = c.clearing.value;

  // The order list is the indexer's; everything derived from it is checked against the chain by the analysis (funding, placement, bundles).
  let orders: AnalyzedOrder[];
  let declaredTeam: Map<string, string>;
  try {
    const rows = ((await d.fetchJson(`${d.config.apiBase}/v1/crosses/${cross}/orders`)) as { orders?: Record<string, unknown>[] }).orders;
    if (!Array.isArray(rows)) throw new Error('the order list has no "orders"');
    orders = rows
      .filter((r) => r.status !== 'cancelled')
      .map((r) => {
        const weight = r.fill != null ? big(r.fill) : r.quantity != null ? big(r.quantity) : null;
        if (typeof r.owner !== 'string' || typeof r.address !== 'string' || (r.side !== 'buy' && r.side !== 'sell') || (r.fill != null && weight === null) || (r.quantity != null && weight === null)) throw new Error(`an order row is not readable: ${JSON.stringify(r).slice(0, 120)}`);
        return { owner: r.owner, orderAddress: r.address, side: r.side, weight };
      });
    // The signed team declarations live with the API; its conflict report carries them. Without it a declared team would be counted as independent, so a failure here stops the pass.
    const conflicts = (await d.fetchJson(`${d.config.apiBase}/v1/integrity/cross/${cross}/conflicts`)) as { perOwner?: Record<string, Flag[]> };
    declaredTeam = declaredTeamFrom(conflicts.perOwner ?? {});
  } catch (e) {
    return fail('API_UNREADABLE', `${e instanceof Error ? e.message : String(e)}; nothing was posted`);
  }

  const parties = { address: cross, creator: c.creator, proceedsTo: c.proceedsTo, integrator: c.integrator, feeRecipient: c.feeRecipient, settler: c.settler.__option === 'Some' ? c.settler.value : null };
  let a: CrossAnalysis;
  try {
    a = await analyzeCross(
      { parties, orders, declaredTeam },
      { rpc: d.rpc, cache: d.cache, serviceFunders: d.config.serviceFunders, bundles: d.config.bundles ? { store: d.placements } : false, trace: { budgetMs: d.config.traceBudgetSecs * 1000 }, policy: d.config.policy },
    );
  } catch (e) {
    return fail('ANALYSIS_FAILED', `${e instanceof Error ? e.message.split('\n')[0] : String(e)}; nothing was posted`);
  }
  const summary: Summary = {
    decision: a.guard.decision,
    policy: a.guard.policy,
    lowerBps: a.organic.lowerBps,
    upperBps: a.organic.upperBps,
    independentGroups: a.organic.breadth.independentGroups,
    untraced: a.untracedOwners.length,
    placementsUnknown: a.coordination ? a.coordination.unknown.count : null,
    reasons: a.guard.reasons.map((r) => r.code),
  };
  // What the figure is: base atoms shown independent, at the single clearing price, in quote atoms, rounded down.
  const lowerQuote = quoteVolume(a.guard.attestableBase, price, c.priceScale);
  const r = found.round;
  const plan = planVolume({ signer: d.signer.address, round: { volumeAttester: attesterIn, finalized: r.finalized, volumeSet: r.volumeSet, volumeQuote: r.volumeQuote }, guard: a.guard, lowerQuote }, d.config);
  if (!plan.post) return { cross, status: 'skipped', code: plan.reason, message: plan.detail ?? plan.reason, summary };
  if (d.dryRun) return { cross, status: 'planned', reason: plan.reason, volumeQuote: plan.volume, summary };
  let signature: string;
  try {
    signature = await d.send([buildPostVolume({ attester: d.signer, round: found.address, volumeQuote: plan.volume })]);
  } catch (e) {
    return fail('SEND_FAILED', e instanceof Error ? e.message.split('\n')[0]! : String(e));
  }
  return { cross, status: 'posted', reason: plan.reason, volumeQuote: plan.volume, signature, summary };
}
