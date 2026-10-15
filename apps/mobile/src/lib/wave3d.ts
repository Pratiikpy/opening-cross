// What a phone says about a cross that the Wave 3D programs touch: a listing against a bond, a backing policy that is failing, and a governed graduation. The pure
// core of the web app's notes (apps/web/src/components/cross/w4-notes.tsx, apps/web/src/lib/listing.ts, backing.ts, graduation.ts); the phone app is a separate
// project and cannot import them, so the two are kept equal by the same cases in test/wave3d.test.ts. The phone only reads and tells: voting, listing and the check
// are done on the web. These programs are proved on LiteSVM and a local validator and are not on devnet until the operations key is funded (H27, H43); a network
// without them answers with nothing to show, and nothing is shown. Nothing here reads the network.
import { shortAddress } from './units';

export type ListingRow = { listing: string; venue: string; lister: string; cross: string; amount: string; status: 'open' | 'released' | 'slashed' };
export type ListingsRead = { listings: ListingRow[] };
export type BackingRead = {
  optedIn: boolean;
  policy: { minCoverageBps: number; maxAgeSecs: string } | null;
  verdict?: 'Backed' | 'Missing' | 'Stale' | 'Short' | null;
  halt: { halted: boolean } | null;
};
export type GraduationRead = {
  governed: boolean;
  release: { deployed: boolean | null };
  outcome?: { venue: string } | null;
  rounds?: { index: number; status: 'voting' | 'awaiting-finalize' | 'passed' | 'failed'; winner: string | null }[];
};

const VENUE: Record<string, string> = { damm_v2: 'Meteora DAMM v2', dlmm: 'Meteora DLMM', raydium_cpmm: 'Raydium CPMM', metadao_futarchy: 'MetaDAO futarchy DAO' };

/** One sentence per listing of the cross: which venue, and what the bond is doing. */
export function listingNote(l: ListingRow): string {
  const head = l.status === 'open' ? 'Listed with a bond at stake' : l.status === 'released' ? 'Listed: the bond was released' : 'Listed: the bond was slashed';
  const tail =
    l.status === 'open'
      ? 'The bond comes back when the cross ends well; it goes to the venue only if the cross fails because its settlement never happened.'
      : l.status === 'released'
        ? 'The cross ended without the fault the bond covers.'
        : 'The cross failed because its settlement never happened.';
  return `${head} on venue ${shortAddress(l.venue)} by ${shortAddress(l.lister)}. ${tail}`;
}

/** The banner of a cross whose token carries a failing backing policy, or null when there is no policy or the backing is fine. */
export function backingBanner(b: BackingRead | null): string | null {
  if (!b || !b.optedIn || !b.verdict || b.verdict === 'Backed') return null;
  const head = { Missing: 'The backing is unverified: no statement has been posted.', Stale: 'The backing statement is stale: it is older than the policy allows.', Short: 'The backing is short: the latest statement covers less of the live supply than the issuer committed to.' }[b.verdict];
  const tail = b.halt?.halted ? 'Trading in this token is halted; a fresh statement does not lift it, only a printing resume cross does.' : 'The next check, which anyone can run, halts the token.';
  return `${head} ${tail}`;
}

/** What a governed cross says about its vote, or null for a cross without the rule or on a network without the program. */
export function governedNote(g: GraduationRead | null): string | null {
  if (!g || !g.governed || g.release.deployed === false) return null;
  if (g.outcome) return `This cross's market opens only on the venue its holders voted for: ${VENUE[g.outcome.venue] ?? g.outcome.venue}. Votes are cast on the web.`;
  const open = g.rounds?.find((r) => r.status === 'voting' || r.status === 'awaiting-finalize');
  if (open) return `Holders are choosing this cross's market venue${open.status === 'voting' ? ': voting is open' : ': the vote is waiting to be finalized'}. Its market opens only on the venue they choose. Votes are cast on the web.`;
  return "This cross's market opens only on a venue its holders vote for, and no vote has passed yet.";
}
