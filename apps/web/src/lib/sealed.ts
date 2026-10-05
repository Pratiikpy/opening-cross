'use client';

// Sealed bids: the chain holds only a commitment, so the price, quantity and salt needed to reveal
// live in this browser and in a backup file the bidder downloads. They are never sent anywhere
// except inside the reveal transaction itself. Losing them means the bid cannot be revealed and is
// refunded in full at settlement.

export type SealedBid = { cross: string; owner: string; nonce: string; side: 'buy' | 'sell'; price: string; quantity: string; salt: string; placedAt: string };

const key = (cross: string, owner: string) => `opening-bell:sealed:${cross}:${owner}`;

export function loadBids(cross: string, owner: string): SealedBid[] {
  try {
    return JSON.parse(localStorage.getItem(key(cross, owner)) ?? '[]') as SealedBid[];
  } catch {
    return [];
  }
}

export function saveBid(b: SealedBid): boolean {
  try {
    const all = loadBids(b.cross, b.owner).filter((x) => x.nonce !== b.nonce);
    localStorage.setItem(key(b.cross, b.owner), JSON.stringify([...all, b]));
    return true;
  } catch {
    return false;
  }
}

export function importBids(text: string, cross: string, owner: string): number {
  const parsed = JSON.parse(text) as { schema?: string; bids?: SealedBid[] };
  if (parsed.schema !== 'opening-bell/sealed-bids/v1' || !Array.isArray(parsed.bids)) throw new Error('This is not an Opening Bell sealed-bid backup.');
  const mine = parsed.bids.filter((b) => b.cross === cross && b.owner === owner);
  for (const b of mine) saveBid(b);
  return mine.length;
}

export function downloadBackup(bids: SealedBid[]): void {
  const blob = new Blob([JSON.stringify({ schema: 'opening-bell/sealed-bids/v1', bids }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sealed-bids-${bids[0]?.cross.slice(0, 8) ?? 'empty'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function randomSalt(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A nonce no earlier order by this wallet in this cross uses: 48 random bits as a decimal string. */
export function randomNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return b.reduce((acc, x) => acc * 256n + BigInt(x), 0n).toString();
}

/** Every order this browser placed, so it shows at once (the indexer follows finalized blocks). */
const placedKey = (cross: string, owner: string) => `opening-bell:placed:${cross}:${owner}`;

export function rememberOrder(cross: string, owner: string, order: string): void {
  try {
    const all = new Set(JSON.parse(localStorage.getItem(placedKey(cross, owner)) ?? '[]') as string[]);
    all.add(order);
    localStorage.setItem(placedKey(cross, owner), JSON.stringify([...all]));
  } catch {
    // The indexer will still list it once finalized.
  }
}

export function rememberedOrders(cross: string, owner: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(placedKey(cross, owner)) ?? '[]') as string[];
  } catch {
    return [];
  }
}
