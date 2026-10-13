'use client';

// The holder-side transaction path. It is `tx.ts` with two additions the new routes need:
//  - the API's stable `reason` and its details survive (`NOT_EXTENDED`, `VOTING_CLOSED`, `CLASS_UNAVAILABLE`, ...), so a screen can branch on
//    them and say what to do, where `build` in tx.ts keeps only the sentence;
//  - a build can be held until a moment (the next ending window), because a transaction for an order in an ending period names the shard
//    of the window it will land in and is wrong a second after that window ends.
// Signing, sending and confirming are `signSendConfirm` from tx.ts, unchanged.
import { API_URL } from './api';
import { ActionError, type Signer, type Unsigned, signSendConfirm } from './tx';

export class Refused extends ActionError {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type Built = { txs: Unsigned[]; extra: Record<string, unknown> };

/** POSTs to an API builder. A refusal keeps its status, reason and details. */
export async function buildReasoned(path: string, body: unknown): Promise<Built> {
  let res: Response;
  try {
    res = await fetch(/^https?:\/\//.test(path) ? path : `${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ActionError('The Opening Cross API could not be reached. Nothing was signed.');
  }
  let json: Record<string, unknown> & { error?: string; reason?: string; transactions?: Unsigned[]; transaction?: string; signers?: string[] };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new ActionError(`The API answered HTTP ${res.status} with something that is not JSON. Nothing was signed.`);
  }
  if (!res.ok) throw new Refused(json.error ?? `The API refused the request (HTTP ${res.status}).`, res.status, typeof json.reason === 'string' ? json.reason : null, json);
  const txs = json.transactions ?? (json.transaction ? [{ transaction: json.transaction, signers: json.signers ?? [] }] : []);
  return { txs, extra: json };
}

/** The wallet-facing errors the program gives when an order meets a rule, in the words a person needs. */
export function explainProgramError(message: string): string {
  if (/Wrong shard for this order/i.test(message)) {
    return 'The ending period moved into its next window while the wallet was open, so the transaction named the wrong window. Nothing was placed and no funds moved. Press the button again to build it for the current window.';
  }
  if (/Orders can no longer be cancelled/i.test(message)) return 'The cancel cutoff has passed: this order can no longer be withdrawn. It is still refunded in full if the cross does not print.';
  if (/identity has reached its order or escrow limit/i.test(message)) return 'This wallet has reached the limit the cross sets on orders or escrow per identity. Cancel an order before the cutoff to free room.';
  if (/does not qualify for the class/i.test(message)) return 'The order does not qualify for the class it asked for. Choose the general class or meet the class’s condition.';
  if (/lottery order must be exactly one lot/i.test(message)) return 'A class-1 lottery order must be exactly one lot. Set the amount to the lot size.';
  if (/Fallback functions are not supported|InstructionFallbackNotFound/i.test(message)) {
    return 'The program deployed on this network does not have this instruction yet: the upgrade (H27) has not been funded. Nothing was changed.';
  }
  return message;
}

/** The text of a failure, with the program's own message translated when it is one of the rule errors. */
export function failureText(e: unknown): string {
  if (e instanceof ActionError) return explainProgramError(e.message);
  return `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
}

export type RunOptions = {
  /** Called with the unsigned answer before anything is signed; throw to stop. */
  inspect?: (built: Built) => void | Promise<void>;
  onStatus?: (s: string) => void;
  /**
   * An order in an ending period is built for one window. If the answer says the window ends within `holdSecs`, the build is held until
   * the next window has begun and made again, so the wallet is never opened for a transaction that is about to be wrong.
   */
  holdIfEndsWithin?: { secs: number; validUntil: (built: Built) => bigint | null; now: () => bigint };
};

/** Builds, signs, sends and confirms. Returns the signatures and the build's extra facts. */
export async function run(path: string, body: unknown, sign: Signer, o: RunOptions = {}): Promise<{ signatures: string[]; extra: Record<string, unknown> }> {
  o.onStatus?.('Preparing…');
  let built = await buildReasoned(path, body);
  const hold = o.holdIfEndsWithin;
  if (hold) {
    const until = hold.validUntil(built);
    if (until !== null && until - hold.now() <= BigInt(hold.secs)) {
      const wait = Number(until - hold.now()) + 2;
      for (let s = Math.max(wait, 0); s > 0; s--) {
        o.onStatus?.(`The ending window changes in a moment; building again in ${s}s…`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      built = await buildReasoned(path, body);
    }
  }
  await o.inspect?.(built);
  const signatures = await signSendConfirm(built.txs, sign, o.onStatus);
  return { signatures, extra: built.extra };
}

export type { Signer };
