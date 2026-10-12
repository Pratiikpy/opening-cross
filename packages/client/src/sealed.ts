// Sealed bids: the chain holds only a commitment, so the price, quantity and salt needed to reveal live with the
// bidder, and in a backup file the bidder keeps. They are never sent anywhere except inside the reveal transaction
// itself. Losing them means the bid cannot be revealed and is refunded in full at settlement.
//
// The vault is an interface so the same flow works in a browser (localStorage), a terminal (a file) and a test (memory).
// The browser vault uses the same keys and backup schema as the Opening Bell web app, so a bid placed in one is visible
// to the other when they share an origin, and a backup file made by either can be loaded by either.
import { ActionError } from './errors.js';
import type { Side } from './types.js';

export type SealedBid = { cross: string; owner: string; nonce: string; side: Side; price: string; quantity: string; salt: string; placedAt: string };

export const SEALED_BACKUP_SCHEMA = 'opening-bell/sealed-bids/v1';

export interface SealedVault {
  list(cross: string, owner: string): Promise<SealedBid[]>;
  /** Persists the bid. Throws an ActionError if it cannot, so the caller can stop before anything is signed. */
  save(bid: SealedBid): Promise<void>;
}

/** Orders this client placed, so they show at once (the indexer follows finalized blocks). */
export interface OrderLog {
  remember(cross: string, owner: string, order: string): Promise<void>;
  remembered(cross: string, owner: string): Promise<string[]>;
}

export type ClientStore = SealedVault & OrderLog;

/** The part of the Web Storage API the store needs. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const hexOfBytes = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function bytesOfHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new ActionError('Expected hexadecimal text.', 'INVALID_INPUT');
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** 32 random bytes as hex: the salt that hides a sealed order's price and quantity until the reveal. */
export function randomSalt(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return hexOfBytes(random(32));
}

/** A nonce no earlier order by this wallet in this cross uses: 48 random bits as a decimal string. */
export function randomNonce(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return random(6).reduce((acc, x) => acc * 256n + BigInt(x), 0n).toString();
}

export function serializeBackup(bids: readonly SealedBid[]): string {
  return JSON.stringify({ schema: SEALED_BACKUP_SCHEMA, bids }, null, 2);
}

const isBid = (b: unknown): b is SealedBid => {
  if (typeof b !== 'object' || b === null) return false;
  const x = b as Record<string, unknown>;
  return (
    ['cross', 'owner', 'nonce', 'price', 'quantity', 'salt', 'placedAt'].every((k) => typeof x[k] === 'string') &&
    (x.side === 'buy' || x.side === 'sell') &&
    /^[0-9a-fA-F]{64}$/.test(x.salt as string) &&
    /^\d{1,20}$/.test(x.nonce as string) &&
    /^\d{1,20}$/.test(x.price as string) &&
    /^\d{1,20}$/.test(x.quantity as string)
  );
};

/** Parses a backup made by `serializeBackup` (or the web app). Throws an ActionError naming what is wrong. */
export function parseBackup(text: string): SealedBid[] {
  let parsed: { schema?: unknown; bids?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new ActionError('This is not a sealed-bid backup: it is not valid JSON.', 'INVALID_INPUT');
  }
  if (parsed.schema !== SEALED_BACKUP_SCHEMA || !Array.isArray(parsed.bids)) throw new ActionError('This is not an Opening Cross sealed-bid backup.', 'INVALID_INPUT');
  const bad = parsed.bids.findIndex((b) => !isBid(b));
  if (bad >= 0) throw new ActionError(`Entry ${bad + 1} of the backup is malformed (a bid needs cross, owner, nonce, side, price, quantity, a 32-byte hex salt and placedAt).`, 'INVALID_INPUT');
  return parsed.bids as SealedBid[];
}

/** Loads the backup's bids that belong to this cross and owner into the vault; returns how many. */
export async function importBackup(vault: SealedVault, text: string, cross: string, owner: string): Promise<number> {
  const mine = parseBackup(text).filter((b) => b.cross === cross && b.owner === owner);
  for (const b of mine) await vault.save(b);
  return mine.length;
}

const mergeBid = (all: SealedBid[], bid: SealedBid): SealedBid[] => [...all.filter((x) => x.nonce !== bid.nonce), bid];

/** Bids and orders kept in memory: for tests, and for a session that must leave nothing behind. */
export function memoryStore(): ClientStore {
  const bids = new Map<string, SealedBid[]>();
  const orders = new Map<string, Set<string>>();
  const k = (cross: string, owner: string) => `${cross}:${owner}`;
  return {
    list: async (cross, owner) => [...(bids.get(k(cross, owner)) ?? [])],
    save: async (bid) => void bids.set(k(bid.cross, bid.owner), mergeBid(bids.get(k(bid.cross, bid.owner)) ?? [], bid)),
    remember: async (cross, owner, order) => void orders.set(k(cross, owner), (orders.get(k(cross, owner)) ?? new Set()).add(order)),
    remembered: async (cross, owner) => [...(orders.get(k(cross, owner)) ?? [])],
  };
}

/** Bids and orders kept in Web Storage under the web app's keys (`opening-bell:sealed:<cross>:<owner>`). */
export function storageStore(storage: StorageLike, prefix = 'opening-bell'): ClientStore {
  const sealedKey = (cross: string, owner: string) => `${prefix}:sealed:${cross}:${owner}`;
  const placedKey = (cross: string, owner: string) => `${prefix}:placed:${cross}:${owner}`;
  const readBids = (cross: string, owner: string): SealedBid[] => {
    try {
      const v = JSON.parse(storage.getItem(sealedKey(cross, owner)) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter(isBid) : [];
    } catch {
      return [];
    }
  };
  return {
    list: async (cross, owner) => readBids(cross, owner),
    save: async (bid) => {
      try {
        storage.setItem(sealedKey(bid.cross, bid.owner), JSON.stringify(mergeBid(readBids(bid.cross, bid.owner), bid)));
      } catch {
        throw new ActionError('This browser could not store your sealed bid, so it could not be revealed later. Nothing was sent.', 'INVALID_INPUT');
      }
    },
    remember: async (cross, owner, order) => {
      try {
        const all = new Set(JSON.parse(storage.getItem(placedKey(cross, owner)) ?? '[]') as string[]);
        all.add(order);
        storage.setItem(placedKey(cross, owner), JSON.stringify([...all]));
      } catch {
        // The indexer still lists the order once it is finalized.
      }
    },
    remembered: async (cross, owner) => {
      try {
        const v = JSON.parse(storage.getItem(placedKey(cross, owner)) ?? '[]') as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    },
  };
}
