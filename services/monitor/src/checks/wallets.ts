// Alerts on insider, team and treasury movements (PRODUCT_FEATURES F5).
//
// A watch list names wallets with a role (team, insider, treasury, protocol) and, optionally, the tokens that matter. On every
// pass the new transactions of each wallet are read and any token it SENT is reported, with the amount, the token, the other
// party where the transaction shows one, and the signature. It reports what happened; it does not say it was wrong. The first
// pass only records where each wallet's history ends, so an old transfer is not announced as new.
import type { Check, Finding } from '../types.js';

export type WatchedWallet = { readonly address: string; readonly label: string; readonly role: 'team' | 'insider' | 'treasury' | 'protocol'; /** Report only these mints; empty means all. */ readonly mints?: readonly string[]; /** Report only outflows of at least this many atoms. */ readonly minAtoms?: string };

export function watchedWallets(wallets: readonly WatchedWallet[], o: { perPass?: number } = {}): Check {
  const cursor = new Map<string, string | null>();
  return {
    name: 'watched-wallets',
    async run({ rpc }) {
      const out: Finding[] = [];
      for (const w of wallets) {
        const seen = cursor.get(w.address);
        if (seen === undefined) {
          // First pass: remember the newest signature and report nothing.
          const first = await rpc.getSignatures(w.address, { limit: 1 });
          cursor.set(w.address, first[0]?.signature ?? null);
          continue;
        }
        const fresh = await rpc.getSignatures(w.address, { ...(seen ? { until: seen } : {}), limit: o.perPass ?? 50 });
        if (fresh.length === 0) continue;
        cursor.set(w.address, fresh[0]!.signature);
        for (const s of [...fresh].reverse()) {
          if (s.err) continue;
          const changes = await rpc.getTokenChanges(s.signature);
          if (!changes) continue;
          for (const c of changes) {
            if (c.owner !== w.address || c.delta >= 0n) continue;
            if (w.mints?.length && !w.mints.includes(c.mint)) continue;
            const sent = -c.delta;
            if (w.minAtoms !== undefined && sent < BigInt(w.minAtoms)) continue;
            const to = changes.filter((x) => x.mint === c.mint && x.owner !== w.address && x.delta > 0n).map((x) => x.owner);
            out.push({
              check: 'watched-wallets',
              subject: `${w.address}:${s.signature}:${c.mint}`,
              severity: w.role === 'treasury' || w.role === 'protocol' ? 'warning' : 'info',
              message: `${w.label} (${w.role}) sent ${sent} atoms of ${c.mint}${to.length ? ` to ${to.join(', ')}` : ''}`,
              evidence: { wallet: w.address, role: w.role, mint: c.mint, atoms: sent.toString(), to: to.join(',') || null, signature: s.signature, blockTime: s.blockTime },
            });
          }
        }
      }
      return out;
    },
  };
}
