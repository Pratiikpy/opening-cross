// Sealed bids: the chain holds only a commitment, so the price, quantity and salt needed to reveal live on this device
// (AsyncStorage) and in a backup the bidder exports. They are never sent anywhere except inside the reveal transaction
// itself. Losing them means the bid cannot be revealed and is refunded in full at settlement.
import { bytesToHex } from './base64';

export type SealedBid = { cross: string; owner: string; nonce: string; side: 'buy' | 'sell'; price: string; quantity: string; salt: string; placedAt: string };

/** The slice of AsyncStorage this uses, so tests can supply a map. */
export type KeyValue = { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };

export const BACKUP_SCHEMA = 'opening-bell/sealed-bids/v1';
const key = (cross: string, owner: string) => `opening-bell:sealed:${cross}:${owner}`;
const placedKey = (cross: string, owner: string) => `opening-bell:placed:${cross}:${owner}`;

export async function loadBids(store: KeyValue, cross: string, owner: string): Promise<SealedBid[]> {
  try {
    return JSON.parse((await store.getItem(key(cross, owner))) ?? '[]') as SealedBid[];
  } catch {
    return [];
  }
}

/** Returns false when the bid could not be stored; the caller must then refuse to send the order. */
export async function saveBid(store: KeyValue, b: SealedBid): Promise<boolean> {
  try {
    const all = (await loadBids(store, b.cross, b.owner)).filter((x) => x.nonce !== b.nonce);
    await store.setItem(key(b.cross, b.owner), JSON.stringify([...all, b]));
    return true;
  } catch {
    return false;
  }
}

export function exportBackup(bids: SealedBid[]): string {
  return JSON.stringify({ schema: BACKUP_SCHEMA, bids }, null, 2);
}

export async function importBackup(store: KeyValue, text: string, cross: string, owner: string): Promise<number> {
  const parsed = JSON.parse(text) as { schema?: string; bids?: SealedBid[] };
  if (parsed.schema !== BACKUP_SCHEMA || !Array.isArray(parsed.bids)) throw new Error('This is not an Opening Bell sealed-bid backup.');
  const mine = parsed.bids.filter((b) => b.cross === cross && b.owner === owner);
  for (const b of mine) await saveBid(store, b);
  return mine.length;
}

/** 32 random bytes as hex, from a source the caller supplies (expo-crypto in the app, a stub in tests). */
export const saltFrom = (random: (n: number) => Uint8Array): string => bytesToHex(random(32));

/** A nonce no earlier order by this wallet in this cross uses: 48 random bits as a decimal string. */
export const nonceFrom = (random: (n: number) => Uint8Array): string => Array.from(random(6)).reduce((acc, x) => acc * 256n + BigInt(x), 0n).toString();

/** Orders placed from this device, so they show at once (the indexer follows finalized blocks). */
export async function rememberOrder(store: KeyValue, cross: string, owner: string, order: string): Promise<void> {
  try {
    const all = new Set(JSON.parse((await store.getItem(placedKey(cross, owner))) ?? '[]') as string[]);
    all.add(order);
    await store.setItem(placedKey(cross, owner), JSON.stringify([...all]));
  } catch {
    // The indexer will still list it once finalized.
  }
}

export async function rememberedOrders(store: KeyValue, cross: string, owner: string): Promise<string[]> {
  try {
    return JSON.parse((await store.getItem(placedKey(cross, owner))) ?? '[]') as string[];
  } catch {
    return [];
  }
}
