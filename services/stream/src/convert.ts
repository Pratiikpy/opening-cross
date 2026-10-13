// An indexed event row to the stream's typed message. The names of enum values come from the generated client, so a variant
// the program adds appears under its own name without a change here.
import { CrossKind, Disclosure, NoPrintReason, SupplyMode } from '@opening-cross/cross-core-client';
import type { EventRow } from './source.js';

export class UnknownEvent extends Error {}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const nameOf = (e: Record<number, string>, v: unknown): string => {
  const n = e[Number(v)];
  if (n === undefined) throw new UnknownEvent(`enum value ${String(v)} is not known to this build`);
  return kebab(n);
};
const RATIONED = ['none', 'buy', 'sell'] as const;
const side = (v: unknown) => (Number(v) === 0 ? 'SIDE_BUY' : Number(v) === 1 ? 'SIDE_SELL' : 'SIDE_UNSPECIFIED');
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');
const some = (o: unknown): Record<string, unknown> | null => (o && typeof o === 'object' && (o as { __option?: string }).__option === 'Some' ? ((o as { value: Record<string, unknown> }).value ?? null) : null);

export type EventMessage = Record<string, unknown>;

/** The message for one event. An event name this build does not know is an error the caller reports, not a silent skip. */
export function toWire(r: EventRow): EventMessage {
  const p = r.payload;
  const base = { cursor: { position: r.position.toString() }, name: r.name, cross: r.cross ?? '', slot: r.slot.toString(), signature: r.signature, seq: r.seq, block_time: r.blockTime === null ? '0' : r.blockTime.toString() };
  switch (r.name) {
    case 'CrossCreated':
      return { ...base, cross_created: { creator: str(p.creator), kind: nameOf(CrossKind as never, p.kind), supply_mode: nameOf(SupplyMode as never, p.supplyMode), disclosure: nameOf(Disclosure as never, p.disclosure), base_mint: str(p.baseMint), quote_mint: str(p.quoteMint), open_ts: str(p.openTs), close_ts: str(p.closeTs), reveal_end_ts: str(p.revealEndTs), protocol_fee_bps: Number(p.protocolFeeBps), integrator_fee_bps: Number(p.integratorFeeBps) } };
    case 'OrderCommitted':
      return { ...base, order_committed: { order: str(p.order), owner: str(p.owner), side: side(p.side), escrow: str(p.escrow), index: Number(p.index), sealed: Boolean(p.sealed) } };
    case 'OrderCancelled':
      return { ...base, order_cancelled: { order: str(p.order), owner: str(p.owner) } };
    case 'OrderRevealed':
      return { ...base, order_revealed: { order: str(p.order), side: side(p.side), price: str(p.price), quantity: str(p.quantity) } };
    case 'CrossCleared': {
      const c = some(p.clearing);
      const npr = p.noPrintReason as { __option?: string; value?: unknown } | undefined;
      return {
        ...base,
        cross_cleared: {
          printed: Boolean(p.printed),
          ...(c ? { price: str(c.price), matched: str(c.matched), rationed: RATIONED[Number(c.rationed)] ?? 'none' } : {}),
          ...(npr?.__option === 'Some' ? { no_print_reason: nameOf(NoPrintReason as never, npr.value) } : {}),
        },
      };
    }
    case 'OrderClaimed':
      return { ...base, order_claimed: { order: str(p.order), owner: str(p.owner), side: side(p.side), fill: str(p.fill), quote_out: str(p.quoteOut), base_out: str(p.baseOut), fee: str(p.fee) } };
    case 'BaseMintBound':
      return { ...base, base_mint_bound: { base_mint: str(p.baseMint) } };
    case 'CrossFinalized':
      return { ...base, cross_finalized: { protocol_fee: str(p.protocolFee), integrator_fee: str(p.integratorFee), proceeds_quote: str(p.proceedsQuote), dust_base: str(p.dustBase) } };
    case 'PauseChanged':
      return { ...base, pause_changed: { paused: Boolean(p.paused) } };
    default:
      throw new UnknownEvent(`event "${r.name}" has no message in stream.proto`);
  }
}
