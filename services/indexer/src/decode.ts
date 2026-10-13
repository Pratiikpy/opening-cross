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
  type AdminChangedEvent,
  type AdminProposedEvent,
  type ChallengeExpiredEvent,
  type ChallengeResolvedEvent,
  type CrossExtSnapshotEvent,
  type DrawFinishedEvent,
  type DrawStartedEvent,
  type ExtensionPendingEvent,
  type HaltChangedEvent,
  type InsiderChallengedEvent,
  type LockCreatedEvent,
  type LockReleasedEvent,
  type OrderPlacementEvent,
  type PrintFedEvent,
  type RulesSetEvent,
  type SeriesCreatedEvent,
  type SeriesSpawnedEvent,
  BASE_MINT_BOUND_EVENT_DISCRIMINATOR,
  CROSS_CLEARED_EVENT_DISCRIMINATOR,
  CROSS_CREATED_EVENT_DISCRIMINATOR,
  CROSS_FINALIZED_EVENT_DISCRIMINATOR,
  ORDER_CANCELLED_EVENT_DISCRIMINATOR,
  ORDER_CLAIMED_EVENT_DISCRIMINATOR,
  ORDER_COMMITTED_EVENT_DISCRIMINATOR,
  ORDER_REVEALED_EVENT_DISCRIMINATOR,
  PAUSE_CHANGED_EVENT_DISCRIMINATOR,
  ADMIN_CHANGED_EVENT_DISCRIMINATOR,
  ADMIN_PROPOSED_EVENT_DISCRIMINATOR,
  CHALLENGE_EXPIRED_EVENT_DISCRIMINATOR,
  CHALLENGE_RESOLVED_EVENT_DISCRIMINATOR,
  CROSS_EXT_SNAPSHOT_EVENT_DISCRIMINATOR,
  DRAW_FINISHED_EVENT_DISCRIMINATOR,
  DRAW_STARTED_EVENT_DISCRIMINATOR,
  EXTENSION_PENDING_EVENT_DISCRIMINATOR,
  HALT_CHANGED_EVENT_DISCRIMINATOR,
  INSIDER_CHALLENGED_EVENT_DISCRIMINATOR,
  LOCK_CREATED_EVENT_DISCRIMINATOR,
  LOCK_RELEASED_EVENT_DISCRIMINATOR,
  ORDER_PLACEMENT_EVENT_DISCRIMINATOR,
  PRINT_FED_EVENT_DISCRIMINATOR,
  RULES_SET_EVENT_DISCRIMINATOR,
  SERIES_CREATED_EVENT_DISCRIMINATOR,
  SERIES_SPAWNED_EVENT_DISCRIMINATOR,
  getBaseMintBoundEventDecoder,
  getCrossClearedEventDecoder,
  getCrossCreatedEventDecoder,
  getCrossFinalizedEventDecoder,
  getOrderCancelledEventDecoder,
  getOrderClaimedEventDecoder,
  getOrderCommittedEventDecoder,
  getOrderRevealedEventDecoder,
  getPauseChangedEventDecoder,
  getAdminChangedEventDecoder,
  getAdminProposedEventDecoder,
  getChallengeExpiredEventDecoder,
  getChallengeResolvedEventDecoder,
  getCrossExtSnapshotEventDecoder,
  getDrawFinishedEventDecoder,
  getDrawStartedEventDecoder,
  getExtensionPendingEventDecoder,
  getHaltChangedEventDecoder,
  getInsiderChallengedEventDecoder,
  getLockCreatedEventDecoder,
  getLockReleasedEventDecoder,
  getOrderPlacementEventDecoder,
  getPrintFedEventDecoder,
  getRulesSetEventDecoder,
  getSeriesCreatedEventDecoder,
  getSeriesSpawnedEventDecoder,
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
  | { name: 'PauseChanged'; data: PauseChangedEvent }
  | { name: 'AdminChanged'; data: AdminChangedEvent }
  | { name: 'AdminProposed'; data: AdminProposedEvent }
  | { name: 'ChallengeExpired'; data: ChallengeExpiredEvent }
  | { name: 'ChallengeResolved'; data: ChallengeResolvedEvent }
  | { name: 'CrossExtSnapshot'; data: CrossExtSnapshotEvent }
  | { name: 'DrawFinished'; data: DrawFinishedEvent }
  | { name: 'DrawStarted'; data: DrawStartedEvent }
  | { name: 'ExtensionPending'; data: ExtensionPendingEvent }
  | { name: 'HaltChanged'; data: HaltChangedEvent }
  | { name: 'InsiderChallenged'; data: InsiderChallengedEvent }
  | { name: 'LockCreated'; data: LockCreatedEvent }
  | { name: 'LockReleased'; data: LockReleasedEvent }
  | { name: 'OrderPlacement'; data: OrderPlacementEvent }
  | { name: 'PrintFed'; data: PrintFedEvent }
  | { name: 'RulesSet'; data: RulesSetEvent }
  | { name: 'SeriesCreated'; data: SeriesCreatedEvent }
  | { name: 'SeriesSpawned'; data: SeriesSpawnedEvent };

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
// Events of the rules extension (ADR-0450 to ADR-0462). The program deployed before it never emits them; a log without them decodes as before.
  [ADMIN_CHANGED_EVENT_DISCRIMINATOR as Uint8Array, 'AdminChanged', getAdminChangedEventDecoder()],
  [ADMIN_PROPOSED_EVENT_DISCRIMINATOR as Uint8Array, 'AdminProposed', getAdminProposedEventDecoder()],
  [CHALLENGE_EXPIRED_EVENT_DISCRIMINATOR as Uint8Array, 'ChallengeExpired', getChallengeExpiredEventDecoder()],
  [CHALLENGE_RESOLVED_EVENT_DISCRIMINATOR as Uint8Array, 'ChallengeResolved', getChallengeResolvedEventDecoder()],
  [CROSS_EXT_SNAPSHOT_EVENT_DISCRIMINATOR as Uint8Array, 'CrossExtSnapshot', getCrossExtSnapshotEventDecoder()],
  [DRAW_FINISHED_EVENT_DISCRIMINATOR as Uint8Array, 'DrawFinished', getDrawFinishedEventDecoder()],
  [DRAW_STARTED_EVENT_DISCRIMINATOR as Uint8Array, 'DrawStarted', getDrawStartedEventDecoder()],
  [EXTENSION_PENDING_EVENT_DISCRIMINATOR as Uint8Array, 'ExtensionPending', getExtensionPendingEventDecoder()],
  [HALT_CHANGED_EVENT_DISCRIMINATOR as Uint8Array, 'HaltChanged', getHaltChangedEventDecoder()],
  [INSIDER_CHALLENGED_EVENT_DISCRIMINATOR as Uint8Array, 'InsiderChallenged', getInsiderChallengedEventDecoder()],
  [LOCK_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'LockCreated', getLockCreatedEventDecoder()],
  [LOCK_RELEASED_EVENT_DISCRIMINATOR as Uint8Array, 'LockReleased', getLockReleasedEventDecoder()],
  [ORDER_PLACEMENT_EVENT_DISCRIMINATOR as Uint8Array, 'OrderPlacement', getOrderPlacementEventDecoder()],
  [PRINT_FED_EVENT_DISCRIMINATOR as Uint8Array, 'PrintFed', getPrintFedEventDecoder()],
  [RULES_SET_EVENT_DISCRIMINATOR as Uint8Array, 'RulesSet', getRulesSetEventDecoder()],
  [SERIES_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'SeriesCreated', getSeriesCreatedEventDecoder()],
  [SERIES_SPAWNED_EVENT_DISCRIMINATOR as Uint8Array, 'SeriesSpawned', getSeriesSpawnedEventDecoder()],
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
