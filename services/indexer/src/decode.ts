// Turns a transaction's log messages into decoded cross_core events.
//
// Anchor's `emit!` writes `Program data: <base64>` while the emitting program is executing. The
// runtime does not say which program wrote a data line, so we track the invoke stack from the
// `Program <id> invoke [n]` / `success` / `failed` lines and keep only lines written while
// cross_core is on top. That accepts events from cross_core called directly or through CPI (a
// venue, cross_settle) and rejects look-alike payloads written by any other program.
import type { Address } from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  type BaseMintBoundEvent,
  type CrossClearedEvent,
  type CrossCreatedEvent,
  type CrossFinalizedEvent,
  type OrderCancelledEvent,
  type OrderClaimedEvent,
  type OrderCommittedEvent,
  type OrderRevealedEvent,
  type PauseChangedEvent,
  BASE_MINT_BOUND_EVENT_DISCRIMINATOR,
  CROSS_CLEARED_EVENT_DISCRIMINATOR,
  CROSS_CREATED_EVENT_DISCRIMINATOR,
  CROSS_FINALIZED_EVENT_DISCRIMINATOR,
  ORDER_CANCELLED_EVENT_DISCRIMINATOR,
  ORDER_CLAIMED_EVENT_DISCRIMINATOR,
  ORDER_COMMITTED_EVENT_DISCRIMINATOR,
  ORDER_REVEALED_EVENT_DISCRIMINATOR,
  PAUSE_CHANGED_EVENT_DISCRIMINATOR,
  getBaseMintBoundEventDecoder,
  getCrossClearedEventDecoder,
  getCrossCreatedEventDecoder,
  getCrossFinalizedEventDecoder,
  getOrderCancelledEventDecoder,
  getOrderClaimedEventDecoder,
  getOrderCommittedEventDecoder,
  getOrderRevealedEventDecoder,
  getPauseChangedEventDecoder,
} from '@opening-cross/cross-core-client';

export type CrossEvent =
  | { name: 'CrossCreated'; data: CrossCreatedEvent }
  | { name: 'OrderCommitted'; data: OrderCommittedEvent }
  | { name: 'OrderCancelled'; data: OrderCancelledEvent }
  | { name: 'OrderRevealed'; data: OrderRevealedEvent }
  | { name: 'CrossCleared'; data: CrossClearedEvent }
  | { name: 'OrderClaimed'; data: OrderClaimedEvent }
  | { name: 'BaseMintBound'; data: BaseMintBoundEvent }
  | { name: 'CrossFinalized'; data: CrossFinalizedEvent }
  | { name: 'PauseChanged'; data: PauseChangedEvent };

const DECODERS: [Uint8Array, CrossEvent['name'], { decode(b: Uint8Array): unknown }][] = [
  [CROSS_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'CrossCreated', getCrossCreatedEventDecoder()],
  [ORDER_COMMITTED_EVENT_DISCRIMINATOR as Uint8Array, 'OrderCommitted', getOrderCommittedEventDecoder()],
  [ORDER_CANCELLED_EVENT_DISCRIMINATOR as Uint8Array, 'OrderCancelled', getOrderCancelledEventDecoder()],
  [ORDER_REVEALED_EVENT_DISCRIMINATOR as Uint8Array, 'OrderRevealed', getOrderRevealedEventDecoder()],
  [CROSS_CLEARED_EVENT_DISCRIMINATOR as Uint8Array, 'CrossCleared', getCrossClearedEventDecoder()],
  [ORDER_CLAIMED_EVENT_DISCRIMINATOR as Uint8Array, 'OrderClaimed', getOrderClaimedEventDecoder()],
  [BASE_MINT_BOUND_EVENT_DISCRIMINATOR as Uint8Array, 'BaseMintBound', getBaseMintBoundEventDecoder()],
  [CROSS_FINALIZED_EVENT_DISCRIMINATOR as Uint8Array, 'CrossFinalized', getCrossFinalizedEventDecoder()],
  [PAUSE_CHANGED_EVENT_DISCRIMINATOR as Uint8Array, 'PauseChanged', getPauseChangedEventDecoder()],
];

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/** Thrown when the log stream is not one we can attribute safely (e.g. truncated by the runtime). */
export class UnattributableLogs extends Error {}

export function decodeLogs(logs: readonly string[], program: Address = CROSS_CORE_PROGRAM_ADDRESS): CrossEvent[] {
  const stack: string[] = [];
  const out: CrossEvent[] = [];
  for (const line of logs) {
    if (line === 'Log truncated') throw new UnattributableLogs('log output was truncated by the runtime');
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    const ex = EXIT.exec(line);
    if (ex) {
      if (stack.at(-1) !== ex[1]) throw new UnattributableLogs(`unbalanced exit for ${ex[1]}`);
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA) || stack.at(-1) !== program) continue;
    const bytes = Uint8Array.from(Buffer.from(line.slice(DATA.length), 'base64'));
    const match = DECODERS.find(([d]) => bytes.length >= 8 && d.every((b, i) => bytes[i] === b));
    if (!match) continue; // a future event this build does not know; the reconciler covers it
    out.push({ name: match[1], data: match[2].decode(bytes) } as CrossEvent);
  }
  return out;
}

/** JSON-safe form of an event payload: bigints become decimal strings. */
export function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
