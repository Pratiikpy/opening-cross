'use client';

// Everything the holder actions of a treasury need, read through the API: the extension's terms and live state, the proposals and the
// wallet's votes, the revenue rounds, the grants, the wallet's position, and the decimals of the coin and the quote token. A part that
// cannot be read is null and the screen says so; it is never replaced with a zero.
import { readBalances } from './holder-chain';
import type { ExtRead, Grant, GrantsRead, Position, Proposal, ProposalsRead, Round, RoundsRead } from './holder-treasury';
import { getJson } from './holder-standing';

export type TreasuryHolderData = {
  ext: ExtRead | null;
  proposals: Proposal[] | null;
  rounds: Round[] | null;
  grants: Grant[] | null;
  position: Position | null;
  /** Decimals of the coin and of the quote token; null until a wallet is connected (the reads of balances need an owner) or when unreadable. */
  decimals: { coin: number; quote: number } | null;
  /** The quote token the wallet holds, for the deposit and revenue forms; null when unreadable. */
  quoteHeld: bigint | null;
};

const MAX_VOTE_READS = 10;

export async function loadTreasuryHolder(treasury: string, owner: string | null, coinMint: string, quoteMint: string): Promise<TreasuryHolderData> {
  const ext = await getJson<ExtRead>(`/v1/treasuries/${treasury}/ext`);
  const none: TreasuryHolderData = { ext, proposals: null, rounds: null, grants: null, position: null, decimals: null, quoteHeld: null };
  if (!ext || !ext.extended) return none;
  const [props, rounds, grants, position, balances] = await Promise.all([
    ext.terms.governance ? getJson<ProposalsRead>(`/v1/treasuries/${treasury}/proposals`) : Promise.resolve(null),
    ext.terms.revenue ? getJson<RoundsRead>(`/v1/treasuries/${treasury}/rounds`) : Promise.resolve(null),
    BigInt(ext.live.grants) > 0n ? getJson<GrantsRead>(`/v1/treasuries/${treasury}/grants`) : Promise.resolve({ treasury, count: '0', grants: [] } as GrantsRead),
    owner ? getJson<Position>(`/v1/treasuries/${treasury}/positions/${owner}`) : Promise.resolve(null),
    owner ? readBalances(owner, [coinMint, quoteMint]) : Promise.resolve(null),
  ]);
  let proposals: Proposal[] | null = props ? props.proposals : null;
  if (proposals && owner) {
    // The wallet's own vote on each recent proposal (the vote record is what lets it reclaim its locked coins).
    const withVotes = await Promise.all(
      proposals.slice(0, MAX_VOTE_READS).map(async (p) => {
        const one = await getJson<Proposal>(`/v1/treasuries/${treasury}/proposals/${p.id}?voter=${owner}`);
        return one ? { ...p, vote: one.vote ?? null } : p;
      }),
    );
    proposals = [...withVotes, ...proposals.slice(MAX_VOTE_READS)];
  }
  const coin = balances?.get(coinMint) ?? null;
  const quote = balances?.get(quoteMint) ?? null;
  return {
    ext,
    proposals,
    rounds: rounds ? rounds.rounds : null,
    grants: grants ? grants.grants : null,
    position,
    decimals: coin && quote ? { coin: coin.decimals, quote: quote.decimals } : null,
    quoteHeld: quote ? quote.amount : null,
  };
}
