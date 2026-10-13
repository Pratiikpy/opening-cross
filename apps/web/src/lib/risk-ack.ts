// The risk acknowledgement a wallet gives before its first order on this device. Kept in this browser only: nothing is sent anywhere,
// and a different browser or a cleared profile simply asks again. Where storage is unavailable the step cannot be remembered, so it is
// asked every time rather than skipped.
export const RISK_ACK_VERSION = 1;

const key = (owner: string) => `ob:risk-ack:v${RISK_ACK_VERSION}:${owner}`;

export function hasAcknowledged(owner: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    const v = storage?.getItem(key(owner));
    return v !== null && v !== undefined;
  } catch {
    return false;
  }
}

/** Records the acknowledgement; returns false when this browser would not store it (the order may still go ahead this time). */
export function acknowledge(owner: string, now: Date = new Date(), storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key(owner), now.toISOString());
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The statements a person agrees to, in plain words. Shown in full on the first order and linked from the order ticket afterwards. */
export const RISK_POINTS: readonly string[] = [
  'This is a test network (Solana devnet). The tokens here have no real value, and nobody has audited the programs.',
  'You can lose everything you pay in. A filled order is final, and your escrow is locked until the cross settles or you cancel before the call closes.',
  'A sealed order must be revealed after the call closes. If you do not reveal in time it does not trade, and it is refunded in full at settlement.',
  'Nothing on this site is an offer or a sale of securities, or advice. You decide for yourself.',
];
