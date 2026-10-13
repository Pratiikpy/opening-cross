// What the growth page computes: the issuer's contacts from public activity, the referral link and how the wizard reads it back, and
// the playbooks. A contact is a wallet, because that is all the chain and the board hold: no email, no name, no location, and nothing
// here infers any. Notes an issuer keeps about a wallet stay in their own browser.
import { isAddress } from '@solana/kit';
import type { StoredRecord } from './issuer-board';
import type { OrderRow } from './issuer-dashboard';

export type Contact = { wallet: string; crosses: number; bids: number; filledCrosses: number; softCommitQuote: bigint; commits: number };

/** Wallets that bid in the issuer's crosses or soft-committed to its drafts, with what each did. Sellers are not contacts: they are the issuer's own side. */
export function buildContacts(crosses: readonly { cross: string; orders: readonly OrderRow[] }[], commits: readonly { draft: string; record: StoredRecord }[], quoteDecimalsOf: (draft: string) => number | null): Contact[] {
  const by = new Map<string, Contact & { seen: Set<string>; filled: Set<string> }>();
  const get = (w: string) => {
    let c = by.get(w);
    if (!c) {
      c = { wallet: w, crosses: 0, bids: 0, filledCrosses: 0, softCommitQuote: 0n, commits: 0, seen: new Set(), filled: new Set() };
      by.set(w, c);
    }
    return c;
  };
  for (const { cross, orders } of crosses)
    for (const o of orders) {
      if (o.side !== 'buy') continue;
      const c = get(o.owner);
      c.bids += 1;
      c.seen.add(cross);
      if (o.fill !== null && BigInt(o.fill) > 0n) c.filled.add(cross);
    }
  for (const { draft, record } of commits) {
    const d = quoteDecimalsOf(draft);
    const c = get(record.signer);
    c.commits += 1;
    const amount = String(record.body.amount ?? '');
    if (d !== null && /^\d+(\.\d+)?$/.test(amount)) {
      const [w, f = ''] = amount.split('.');
      if (f.length <= d) c.softCommitQuote += BigInt(w!) * 10n ** BigInt(d) + BigInt(f.padEnd(d, '0') || '0');
    }
  }
  return [...by.values()]
    .map(({ seen, filled, ...c }) => ({ ...c, crosses: seen.size, filledCrosses: filled.size }))
    .sort((a, b) => b.filledCrosses - a.filledCrosses || b.crosses - a.crosses || b.commits - a.commits || (a.wallet < b.wallet ? -1 : 1));
}

const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function contactsCsv(contacts: readonly Contact[], notes: Record<string, string>): string {
  const head = 'wallet,crosses_bid_in,bids,crosses_filled,soft_commits,note';
  return [head, ...contacts.map((c) => [c.wallet, c.crosses, c.bids, c.filledCrosses, c.commits, notes[c.wallet] ?? ''].map((x) => csv(String(x))).join(','))].join('\n') + '\n';
}

// ---- referral links

export const MAX_INTEGRATOR_BPS = 300;

/** The link an affiliate shares. The wizard pre-fills the integrator wallet and its fee from it; the issuer can change both before signing. */
export function referralLink(origin: string, wallet: string, feeBps: number): { ok: true; url: string } | { ok: false; error: string } {
  if (!isAddress(wallet.trim())) return { ok: false, error: 'Enter the wallet that should earn the fee.' };
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_INTEGRATOR_BPS) return { ok: false, error: `The fee is 0 to ${MAX_INTEGRATOR_BPS} basis points.` };
  return { ok: true, url: `${origin}/issue?ref=${wallet.trim()}&fee=${feeBps}` };
}

/** The integrator a link names, read back; anything that is not a valid address and fee is ignored, never half-applied. */
export function parseReferral(search: string): { wallet: string; feeBps: number } | null {
  const q = new URLSearchParams(search);
  const ref = q.get('ref');
  if (!ref || !isAddress(ref)) return null;
  const raw = q.get('fee');
  const fee = raw === null ? 0 : Number(raw);
  return { wallet: ref, feeBps: Number.isInteger(fee) && fee >= 0 && fee <= MAX_INTEGRATOR_BPS ? fee : 0 };
}

// ---- playbooks

export type Playbook = { id: string; title: string; when: string; steps: { text: string; href?: string }[] };

/** Short, concrete sequences built only from what the product does. They make no claim about what will work for a given raise. */
export const PLAYBOOKS: Playbook[] = [
  {
    id: 'before',
    title: 'Before you fix a date',
    when: 'You have a token and an idea of the raise.',
    steps: [
      { text: 'Publish a draft listing and share it. Read the demand by price against your offer before you choose a price grid.', href: '/issuer/demand' },
      { text: 'Run the simulator with that demand, then with half and double. See where a minimum volume or an imbalance limit would stop the cross.', href: '/issuer/simulator' },
      { text: 'Decide your own limits on float and value. They become parameters the program enforces.', href: '/issue#guards' },
      { text: 'Decide whether you want a treasury, and who the attester will be. Agree it with them before the cross, not after.', href: '/issuer/treasury/new' },
    ],
  },
  {
    id: 'during',
    title: 'While the call is open',
    when: 'Orders are being placed.',
    steps: [
      { text: 'Watch the book on the cross page. You cannot change the price or end the call early, and neither can anyone else.', href: '/issuer' },
      { text: 'For a sealed cross, remind bidders that a bid not revealed in time is excluded and refunded in full.' },
      { text: 'Answer questions as they come. A question not answered within seven days shows as overdue.', href: '/issuer/disclosures' },
    ],
  },
  {
    id: 'after',
    title: 'After it prints',
    when: 'The cross has cleared and finalized.',
    steps: [
      { text: 'Read the register of who received tokens. Keep your own notes in your browser.', href: '/issuer/growth#contacts' },
      { text: 'If you launched a coin and want a treasury, create it now: the supply is fixed.', href: '/issuer/treasury/new' },
      { text: 'Post your first disclosure update before the clock on the holder page runs out.', href: '/issuer/disclosures' },
    ],
  },
  {
    id: 'noprint',
    title: 'If it does not print',
    when: 'The cross closed without a price.',
    steps: [
      { text: 'Every bidder is refunded in full and, in a minting cross, nothing was created. Read the reason on the cross page.' },
      { text: 'Check which guard stopped it: no overlap between supply and demand, a minimum volume, an imbalance limit or an oracle guard.' },
      { text: 'Rerun the simulator with the book that actually arrived, then open a new cross with what you learned.', href: '/issuer/simulator' },
    ],
  },
];
