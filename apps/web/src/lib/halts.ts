// Halt states (W11, C5), the corporate-action flag and the lender print feed: what GET /v1/halts/:baseMint and GET /v1/feeds/:baseMint serve,
// who may act on them, and the forms that become the bodies of the halt routes. Pure and free of React.
//
// Rules of the program (programs/cross_core/src/halt.rs, docs/evidence/W2D-W11.md): the issuer authority or a registered venue signer halts
// (`set_halt`); only the authority flags or clears a corporate action; anyone may copy a Token-2022 pause (`sync_pause`) and feed a verified Pyth
// update to the circuit breaker (`observe_price`); and nothing but a printing resume cross, created by the authority or the venue signer, lifts a halt.
import { isAddress } from '@solana/kit';
import { type Big } from './series';
import { shortAddress } from './units';

export type HaltReasonName = 'none' | 'issuer-pause' | 'venue-halt' | 'circuit-breaker' | 'corporate-action';

export type HaltState = {
  halted: boolean;
  reason: HaltReasonName | string;
  reasonCode: number;
  corporateAction: boolean;
  since: Big | null;
  issuerUnpaused: boolean;
  authority: string;
  venueSigner: string | null;
  breaker: { windowSlots: Big; moveBps: Big; feedId: string } | null;
  lastResume: { cross: string; price: Big; at: Big } | null;
};

export type HaltRead = { baseMint: string; halt: string | null; note?: string; state?: HaltState; indexed?: { halted: boolean; reason: number; changed_slot: string; changes: number } | null };

export type FeedRead = {
  baseMint: string;
  feed: string | null;
  note?: string;
  quoteMint?: string;
  authority?: string;
  publishers?: string[];
  minMatched?: Big;
  latest?: { price: Big; priceScale: Big; matched: Big; cross: string; ts: Big; slot: Big } | null;
  prints?: { cross_address: string; price: string; matched: string; slot: string }[];
  printCount?: Big;
};

/** What each reason means to a holder, and what has to happen before trading returns. */
export const HALT_REASON: Record<string, { title: string; meaning: string }> = {
  'issuer-pause': { title: 'Paused by the issuer', meaning: 'The issuer paused the token, or halted it from this page.' },
  'venue-halt': { title: 'Halted by the venue', meaning: 'The exchange or market operator named when the halt state was created signalled a halt.' },
  'circuit-breaker': { title: 'Stopped by the circuit breaker', meaning: 'Two oracle prices inside the breaker’s window moved further apart than its limit.' },
  'corporate-action': { title: 'Corporate action in progress', meaning: 'The issuer flagged a split, a dividend or another change to what one token represents.' },
  none: { title: 'Not halted', meaning: 'Nothing is stopping crosses of this token.' },
};

export type Role = 'authority' | 'venue' | 'none';
export function roleOf(state: HaltState | undefined, wallet: string | null): Role {
  if (!state || !wallet) return 'none';
  if (state.authority === wallet) return 'authority';
  if (state.venueSigner === wallet) return 'venue';
  return 'none';
}

export type Headline = { tone: 'ok' | 'block' | 'warn' | 'info'; title: string; lines: string[] };

const clock = (v: Big | null) => (v === null ? 'an unknown time' : `${new Date(Number(v) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

/** The state of a mint in plain words: what is stopped, why, and what lifts it. */
export function haltHeadline(r: HaltRead): Headline {
  if (!r.state) {
    return { tone: 'info', title: 'No halt state exists for this token', lines: [r.note ?? 'Nothing can halt a cross of it, and no resume cross is needed.'] };
  }
  const s = r.state;
  const lines: string[] = [];
  if (s.halted) {
    const why = HALT_REASON[s.reason] ?? { title: String(s.reason), meaning: 'The reason is not one this page knows.' };
    lines.push(`${why.title}${s.since !== null ? ` since ${clock(s.since)}` : ''}. ${why.meaning}`);
    lines.push('A cross that honours the halt does not print while it lasts: it refunds every order in full. Trading returns only when a resume cross, created by the issuer or the venue, prints at a single price. Nobody else can lift the halt, and no waiting does.');
    if (s.reason === 'issuer-pause' && s.issuerUnpaused) lines.push('The issuer has lifted its pause on the token itself, but the halt stays until a resume cross prints.');
    if (s.corporateAction) lines.push('A corporate action is also flagged.');
    return { tone: 'block', title: 'Halted', lines };
  }
  if (s.corporateAction) {
    lines.push('The issuer flagged a corporate action. A cross that honours the flag does not print while it lasts, and refunds every order in full. Only the issuer can clear the flag.');
    return { tone: 'warn', title: 'Corporate action flagged', lines };
  }
  lines.push('Trading is not halted.');
  if (s.lastResume) lines.push(`The last resume cross ${shortAddress(s.lastResume.cross)} printed at ${s.lastResume.price.toString()} (price units) on ${clock(s.lastResume.at)}.`);
  return { tone: 'ok', title: 'Not halted', lines };
}

// ---------------------------------------------------------------------------------------------------- forms

const HEX64 = /^[0-9a-fA-F]{64}$/;

export type HaltInitForm = { venueSigner: string; breaker: boolean; feedId: string; windowSlots: string; movePct: string };
export const EMPTY_HALT_INIT: HaltInitForm = { venueSigner: '', breaker: false, feedId: '', windowSlots: '150', movePct: '10' };
export type HaltInitErrors = Partial<Record<keyof HaltInitForm, string>>;

/** The body of POST /v1/tx/init-halt-state. */
export function buildHaltInit(f: HaltInitForm, authority: string | null, baseMint: string): { body: Record<string, unknown> | null; errors: HaltInitErrors } {
  const errors: HaltInitErrors = {};
  if (f.venueSigner.trim() !== '' && !isAddress(f.venueSigner.trim())) errors.venueSigner = 'This is not a Solana address.';
  let breaker: { feedId: string; windowSlots: number; moveBps: number } | undefined;
  if (f.breaker) {
    if (!HEX64.test(f.feedId.trim().replace(/^0x/, ''))) errors.feedId = 'A Pyth price feed id is 64 hexadecimal characters.';
    const w = /^\d{1,9}$/.test(f.windowSlots.trim()) ? Number(f.windowSlots.trim()) : null;
    if (w === null || w < 1) errors.windowSlots = 'The window is a whole number of slots, at least 1 (about 0.4 seconds each).';
    const t = f.movePct.trim();
    const bps = /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
    if (bps === null || bps < 1 || bps > 10_000) errors.movePct = 'A percentage above 0 and up to 100, with at most two decimals.';
    if (!errors.feedId && !errors.windowSlots && !errors.movePct && w !== null && bps !== null) breaker = { feedId: f.feedId.trim().replace(/^0x/, '').toLowerCase(), windowSlots: w, moveBps: bps };
  }
  if (Object.keys(errors).length > 0 || !authority || !isAddress(baseMint)) return { body: null, errors };
  return {
    body: { authority, baseMint, ...(f.venueSigner.trim() ? { venueSigner: f.venueSigner.trim() } : {}), ...(breaker ? { breaker } : {}) },
    errors,
  };
}

export type PublishersParse = { ok: true; list: string[] } | { ok: false; error: string };
/** One wallet per line or separated by commas or spaces: one to four, each once. */
export function parsePublishers(text: string): PublishersParse {
  const list = text.split(/[\s,]+/).filter(Boolean);
  if (list.length === 0) return { ok: false, error: 'Name at least one wallet that may publish prints.' };
  if (list.length > 4) return { ok: false, error: 'A print feed has at most four publishers.' };
  const bad = list.find((a) => !isAddress(a));
  if (bad) return { ok: false, error: `${shortAddress(bad)} is not a Solana address.` };
  if (new Set(list).size !== list.length) return { ok: false, error: 'A publisher is listed once.' };
  return { ok: true, list };
}

/** The sentence a holder reads about the lender print feed. */
export function feedText(f: FeedRead): string {
  if (!f.feed) return f.note ?? 'No lender print feed exists for this token.';
  const n = f.publishers?.length ?? 0;
  const latest = f.latest ? ` The latest print was ${f.latest.matched.toString()} base atoms at ${f.latest.price.toString()} (price units), from cross ${shortAddress(f.latest.cross)}.` : ' No print has been recorded yet.';
  return `${n} publisher${n === 1 ? '' : 's'} may record prints; a cross only feeds lenders when it traded at least ${(f.minMatched ?? 0).toString()} base atoms.${latest}`;
}
