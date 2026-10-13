// The issuer wizard's form state, in one serialisable object, and how a draft is saved in this browser and read back.
// A draft lives in this browser's local storage only: nothing is sent anywhere, and the page says so. A draft read back is
// checked field by field; one that does not fit is dropped, never half-applied.
import type { ListingTypeId } from '@opening-cross/presets/launch';
import { LISTING_TYPES } from '@opening-cross/presets/launch';
import { EMPTY_RULES_FORM, type RulesForm, cloneRulesForm } from '@opening-cross/presets/rules';
import type { OracleDraft } from './issuer-guards';

export type Draft = {
  listingType: ListingTypeId | null;
  baseMint: string;
  quoteMint: string;
  disclosure: 'sealed' | 'open';
  supplyMode: 'escrow' | 'mint';
  kind: 'launch' | 'reopen' | 'tender' | 'recurring';
  minPrice: string;
  tick: string;
  ticks: number;
  /** `YYYY-MM-DDTHH:mm` in the browser's local time, the value of a datetime-local input. */
  openAt: string;
  closeAt: string;
  revealMinutes: number;
  minMatched: string;
  maxImbalancePct: string;
  integratorFeeBps: number;
  /** The wallet that earns the integrator fee; empty means the issuer's own wallet. */
  integrator: string;
  maxOrders: number;
  shards: number;
  schedule: { price: string; quantity: string }[];
  oracle: OracleDraft;
  /** Rules the issuer commits to (B13): a minimum float in percent and a fully diluted value ceiling in quote tokens. Empty = none. */
  minFloatPct: string;
  maxFdv: string;
  /** The rules step: every cross_core rule, in the units a person types. All empty = a cross created without the rules extension. */
  rules: RulesForm;
};

export const DRAFT_KEY = 'opening-bell:issuer-draft:v1';

export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function newDraft(now: Date): Draft {
  const open = new Date(now.getTime() + 60 * 60_000);
  return {
    listingType: null,
    baseMint: '',
    quoteMint: '',
    disclosure: 'sealed',
    supplyMode: 'mint',
    kind: 'launch',
    minPrice: '1.00',
    tick: '0.05',
    ticks: 40,
    openAt: toLocalInput(open),
    closeAt: toLocalInput(new Date(open.getTime() + 2 * 3_600_000)),
    revealMinutes: 30,
    minMatched: '',
    maxImbalancePct: '',
    integratorFeeBps: 0,
    integrator: '',
    maxOrders: 1000,
    shards: 4,
    schedule: [{ price: '1.20', quantity: '' }],
    oracle: { enabled: false, feedId: '', maxDivergencePct: '', maxStalenessSecs: 60 },
    minFloatPct: '',
    maxFdv: '',
    rules: cloneRulesForm(EMPTY_RULES_FORM),
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => isStr(v) && (set as readonly string[]).includes(v);

/** The rules form from stored data; a draft written before the rules step existed, or a field of the wrong type, gives the empty form field by field. */
export function parseRulesForm(raw: unknown): RulesForm {
  const out = cloneRulesForm(EMPTY_RULES_FORM);
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  const target = out as Record<string, unknown>;
  for (const k of Object.keys(EMPTY_RULES_FORM) as (keyof RulesForm)[]) {
    const def = EMPTY_RULES_FORM[k];
    const v = o[k];
    if (Array.isArray(def)) {
      if (Array.isArray(v) && v.every(isStr)) target[k] = [...v];
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') target[k] = v;
    } else if (isStr(v)) target[k] = v;
  }
  return out;
}

/** A draft from stored text, or null if it is not exactly a draft this version wrote. Integers that were NaN are stored as null and come back as defaults. */
export function parseDraft(text: string | null, fallback: Draft): Draft | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (isInt(v) ? v : d);
  const sched = Array.isArray(o.schedule) ? o.schedule : null;
  const oracle = o.oracle && typeof o.oracle === 'object' ? (o.oracle as Record<string, unknown>) : null;
  if (!sched || !oracle) return null;
  if (!sched.every((s) => s && typeof s === 'object' && isStr((s as Record<string, unknown>).price) && isStr((s as Record<string, unknown>).quantity))) return null;
  const strings = ['baseMint', 'quoteMint', 'minPrice', 'tick', 'openAt', 'closeAt', 'minMatched', 'maxImbalancePct', 'integrator', 'minFloatPct', 'maxFdv'] as const;
  if (!strings.every((k) => isStr(o[k]))) return null;
  if (!oneOf(o.disclosure, ['sealed', 'open'] as const) || !oneOf(o.supplyMode, ['escrow', 'mint'] as const) || !oneOf(o.kind, ['launch', 'reopen', 'tender', 'recurring'] as const)) return null;
  const listing = o.listingType === null ? null : oneOf(o.listingType, LISTING_TYPES.map((t) => t.id)) ? o.listingType : undefined;
  if (listing === undefined) return null;
  if (!isStr(oracle.feedId) || !isStr(oracle.maxDivergencePct) || typeof oracle.enabled !== 'boolean') return null;
  return {
    listingType: listing as ListingTypeId | null,
    baseMint: o.baseMint as string,
    quoteMint: o.quoteMint as string,
    disclosure: o.disclosure as Draft['disclosure'],
    supplyMode: o.supplyMode as Draft['supplyMode'],
    kind: o.kind as Draft['kind'],
    minPrice: o.minPrice as string,
    tick: o.tick as string,
    ticks: num(o.ticks, fallback.ticks),
    openAt: o.openAt as string,
    closeAt: o.closeAt as string,
    revealMinutes: num(o.revealMinutes, fallback.revealMinutes),
    minMatched: o.minMatched as string,
    maxImbalancePct: o.maxImbalancePct as string,
    integratorFeeBps: num(o.integratorFeeBps, 0),
    integrator: o.integrator as string,
    maxOrders: num(o.maxOrders, fallback.maxOrders),
    shards: num(o.shards, fallback.shards),
    schedule: (sched as { price: string; quantity: string }[]).map((s) => ({ price: s.price, quantity: s.quantity })),
    oracle: { enabled: oracle.enabled, feedId: oracle.feedId, maxDivergencePct: oracle.maxDivergencePct, maxStalenessSecs: num(oracle.maxStalenessSecs, 60) },
    minFloatPct: o.minFloatPct as string,
    maxFdv: o.maxFdv as string,
    rules: parseRulesForm(o.rules),
  };
}

/** NaN cannot be stored in JSON; a half-typed whole-number field is stored as null and restored to the default. */
export const serializeDraft = (d: Draft): string => JSON.stringify(d, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));

export function loadDraft(fallback: Draft): Draft | null {
  try {
    return parseDraft(localStorage.getItem(DRAFT_KEY), fallback);
  } catch {
    return null;
  }
}

export function saveDraft(d: Draft): boolean {
  try {
    localStorage.setItem(DRAFT_KEY, serializeDraft(d));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing was stored.
  }
}
