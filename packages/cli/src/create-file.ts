// The file `opening-cross create` reads: a JSON document validated against a JSON Schema, then turned into the request
// the transaction builders take. Prices and amounts are written the way people write them (quote tokens per base token,
// base tokens) unless the file says `"units": "atoms"`; times are unix seconds, ISO 8601, "now" or "+10m".
import { Ajv, type ErrorObject } from 'ajv';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { isAddress } from '@solana/kit';
import { type CreateCrossRequest, type Market, type RpcClient, parseAtoms, parsePrice } from '@opening-cross/client';
import { UsageError } from './exit.js';

const ADDRESS = { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$', description: 'A base58 Solana address.' } as const;
const NULLABLE_ADDRESS = { anyOf: [ADDRESS, { type: 'null' }] } as const;
const DECIMAL = { anyOf: [{ type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' }, { type: 'integer', minimum: 0 }], description: 'A non-negative decimal number, as a string. Quote tokens per base token for prices, base tokens for amounts (atoms when units is "atoms").' } as const;
const U64 = { anyOf: [{ type: 'string', pattern: '^[0-9]{1,20}$' }, { type: 'integer', minimum: 0 }], description: 'A whole number from 0 to 18446744073709551615.' } as const;
const TIME = {
  anyOf: [
    { type: 'integer', minimum: 0 },
    { type: 'string', pattern: '^([0-9]+|now|\\+[0-9]+[smhd]|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2}))$' },
  ],
  description: 'Unix seconds, an ISO 8601 timestamp with a zone, "now", or a delay such as "+10m" (s, m, h or d) from the cluster’s clock.',
} as const;

/** The JSON Schema of the create file. `schemas/create-cross.schema.json` is this object, written out (a test keeps them equal). */
export const CREATE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/Pratiikpy/opening-cross/blob/main/packages/cli/schemas/create-cross.schema.json',
  title: 'Opening Cross: create a cross',
  type: 'object',
  additionalProperties: false,
  required: ['quoteMint', 'supplyMode', 'disclosure', 'grid', 'window', 'shards', 'maxOrders'],
  properties: {
    $schema: { type: 'string' },
    units: { enum: ['tokens', 'atoms'], default: 'tokens', description: 'How prices and amounts are written. In "tokens", price fields are quote tokens per base token and amounts are base tokens; in "atoms" they are on-chain integers (prices per priceScale base atoms).' },
    creator: { ...ADDRESS, description: 'Optional. When present it must be the signing wallet.' },
    baseMint: { ...NULLABLE_ADDRESS, description: 'The token being sold. Omit or null for a deferred-mint cross, whose settlement adapter creates it.' },
    quoteMint: ADDRESS,
    baseTokenProgram: { ...ADDRESS, description: 'Default: the owner of baseMint.' },
    quoteTokenProgram: { ...ADDRESS, description: 'Default: the owner of quoteMint.' },
    crossId: { ...U64, description: 'Default: a random 48-bit number, printed when the cross is created.' },
    kind: { enum: ['launch', 'reopen', 'tender', 'recurring'], default: 'launch' },
    supplyMode: { enum: ['escrow', 'mint', 'deferred-mint'] },
    disclosure: { enum: ['sealed', 'open'] },
    grid: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'tick', 'ticks'],
      description: 'The price grid: min, min + tick, ... up to ticks entries. Orders must sit on it.',
      properties: {
        min: DECIMAL,
        tick: DECIMAL,
        ticks: { type: 'integer', minimum: 1, maximum: 256 },
        priceScale: { ...U64, description: 'Base atoms a price is quoted per. Default: 10^decimals of the base token, so prices are quote atoms per whole base token.' },
        baseDecimals: { type: 'integer', minimum: 0, maximum: 18, description: 'Only for a deferred-mint cross, which has no base mint to read decimals from.' },
      },
    },
    window: {
      type: 'object',
      additionalProperties: false,
      required: ['close'],
      properties: {
        open: { ...TIME, description: 'Default: now.' },
        close: TIME,
        revealEnd: { ...TIME, description: 'Sealed crosses: when the reveal window ends. Open crosses: ignored.' },
      },
    },
    referencePrice: { anyOf: [DECIMAL, { type: 'null' }], description: 'A reference price (the clearing guard anchors to it). Same units as grid.min.' },
    minMatched: { ...DECIMAL, description: 'The least volume that must trade for the cross to print. Default 0.' },
    maxImbalanceBps: { anyOf: [{ type: 'integer', minimum: 0, maximum: 10000 }, { type: 'null' }] },
    integratorFeeBps: { type: 'integer', minimum: 0, maximum: 300, default: 0 },
    integrator: { ...ADDRESS, description: 'Default: the creator.' },
    gateMint: { ...NULLABLE_ADDRESS, description: 'Only holders of a cross_gate pass for this mint may place orders.' },
    shards: { type: 'integer', minimum: 1, maximum: 32 },
    maxOrders: { type: 'integer', minimum: 1, maximum: 1000000 },
    proceedsTo: { ...ADDRESS, description: 'Default: the creator.' },
    schedule: {
      type: 'array',
      description: 'Mint modes: the issuer’s supply as sell levels.',
      items: { type: 'object', additionalProperties: false, required: ['price', 'quantity'], properties: { price: DECIMAL, quantity: DECIMAL } },
    },
    oracle: {
      anyOf: [
        { type: 'object', additionalProperties: false, required: ['feedId', 'maxDivergenceBps', 'maxStalenessSecs'], properties: { feedId: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' }, maxDivergenceBps: { type: 'integer', minimum: 0, maximum: 10000 }, maxStalenessSecs: { type: 'integer', minimum: 0, maximum: 86400 } } },
        { type: 'null' },
      ],
    },
    calendar: NULLABLE_ADDRESS,
    settler: NULLABLE_ADDRESS,
    settleDeadline: { ...TIME, description: 'Deferred-mint crosses: after this time an unbound cross can be abandoned and refunded.' },
  },
} as const;

type Pointer = string;

function describeErrors(errors: readonly ErrorObject[]): string[] {
  // For an `anyOf` Ajv reports every branch; keep the one with the most specific complaint per location.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errors) {
    if (e.keyword === 'anyOf') continue;
    const where: Pointer = e.instancePath || '(the file)';
    const what =
      e.keyword === 'required' ? `is missing "${(e.params as { missingProperty: string }).missingProperty}"`
      : e.keyword === 'additionalProperties' ? `has an unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`
      : e.keyword === 'enum' ? `must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(', ')}`
      : e.keyword === 'pattern' ? `is not in the expected format (${e.message ?? 'pattern'})`
      : (e.message ?? 'is invalid');
    const line = `${where} ${what}`;
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateShape = ajv.compile(CREATE_SCHEMA as unknown as Record<string, unknown>);

/** Validates parsed JSON against the schema; throws a UsageError listing every problem with its location. */
export function validateCreateFile(doc: unknown, source: string): asserts doc is CreateFile {
  if (!validateShape(doc)) {
    const problems = describeErrors(validateShape.errors ?? []);
    throw new UsageError(`${source} is not a valid create file:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

export type CreateFile = {
  units?: 'tokens' | 'atoms';
  creator?: string;
  baseMint?: string | null;
  quoteMint: string;
  baseTokenProgram?: string;
  quoteTokenProgram?: string;
  crossId?: string | number;
  kind?: CreateCrossRequest['kind'];
  supplyMode: CreateCrossRequest['supplyMode'];
  disclosure: CreateCrossRequest['disclosure'];
  grid: { min: string | number; tick: string | number; ticks: number; priceScale?: string | number; baseDecimals?: number };
  window: { open?: string | number; close: string | number; revealEnd?: string | number };
  referencePrice?: string | number | null;
  minMatched?: string | number;
  maxImbalanceBps?: number | null;
  integratorFeeBps?: number;
  integrator?: string;
  gateMint?: string | null;
  shards: number;
  maxOrders: number;
  proceedsTo?: string;
  schedule?: { price: string | number; quantity: string | number }[];
  oracle?: { feedId: string; maxDivergenceBps: number; maxStalenessSecs: number } | null;
  calendar?: string | null;
  settler?: string | null;
  settleDeadline?: string | number;
};

/** Parses a time field into unix seconds. `now` is the cluster's clock. */
export function parseTime(v: string | number, now: bigint, field: string): bigint {
  if (typeof v === 'number') return BigInt(v);
  if (/^\d+$/.test(v)) return BigInt(v);
  if (v === 'now') return now;
  const rel = /^\+(\d+)([smhd])$/.exec(v);
  if (rel) return now + BigInt(rel[1]!) * { s: 1n, m: 60n, h: 3600n, d: 86400n }[rel[2] as 's' | 'm' | 'h' | 'd'];
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new UsageError(`${field}: "${v}" is not a valid timestamp.`);
  return BigInt(Math.floor(ms / 1000));
}

const SPL_MINT_DECIMALS_OFFSET = 44;

async function readMint(rpc: RpcClient, mint: string, field: string): Promise<{ decimals: number; tokenProgram: string }> {
  const acct = await rpc.getAccount(mint);
  if (!acct) throw new UsageError(`${field}: the mint ${mint} does not exist on this cluster.`);
  if (acct.owner !== TOKEN_PROGRAM_ADDRESS && acct.owner !== TOKEN_2022_PROGRAM_ADDRESS) throw new UsageError(`${field}: ${mint} is not an SPL token mint (it is owned by ${acct.owner}).`);
  const decimals = acct.data[SPL_MINT_DECIMALS_OFFSET];
  if (decimals === undefined) throw new UsageError(`${field}: ${mint} is too short to be a mint account.`);
  return { decimals, tokenProgram: acct.owner };
}

const u64 = (v: string | number, field: string): bigint => {
  const n = BigInt(v);
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new UsageError(`${field}: ${v} does not fit 64 bits.`);
  return n;
};

/** Turns a validated create file into the request the transaction builders take, reading mint decimals and token programs from the cluster. */
export async function toCreateRequest(file: CreateFile, deps: { creator: string; rpc: RpcClient; now: bigint; random?: (n: number) => Uint8Array }): Promise<CreateCrossRequest> {
  const { creator, rpc, now } = deps;
  if (file.creator !== undefined && file.creator !== creator) throw new UsageError(`creator: the file names ${file.creator} but the signing wallet is ${creator}. Remove the field or sign with that wallet.`);
  for (const [field, v] of Object.entries({ quoteMint: file.quoteMint, baseMint: file.baseMint, baseTokenProgram: file.baseTokenProgram, quoteTokenProgram: file.quoteTokenProgram, integrator: file.integrator, proceedsTo: file.proceedsTo, gateMint: file.gateMint, calendar: file.calendar, settler: file.settler })) {
    if (typeof v === 'string' && !isAddress(v)) throw new UsageError(`${field}: "${v}" is not a valid Solana address.`);
  }
  const deferred = file.supplyMode === 'deferred-mint';
  if (!deferred && !file.baseMint) throw new UsageError('baseMint is required unless supplyMode is "deferred-mint".');
  if (deferred && file.baseMint) throw new UsageError('A deferred-mint cross has no base mint yet: remove baseMint.');
  if (file.schedule !== undefined && file.schedule.length > 0 && file.supplyMode === 'escrow') throw new UsageError('schedule is for the mint modes; an escrow cross takes sellers’ own orders.');
  if (file.supplyMode !== 'escrow' && (file.schedule === undefined || file.schedule.length === 0)) throw new UsageError(`schedule is required for supplyMode "${file.supplyMode}": the issuer's supply is the schedule.`);

  const quote = await readMint(rpc, file.quoteMint, 'quoteMint');
  const base = file.baseMint ? await readMint(rpc, file.baseMint, 'baseMint') : null;
  const baseDecimals = base?.decimals ?? file.grid.baseDecimals;
  if (baseDecimals === undefined) throw new UsageError('grid.baseDecimals is required for a deferred-mint cross (there is no base mint to read it from).');
  const atoms = file.units === 'atoms';
  const priceScale = file.grid.priceScale === undefined ? 10n ** BigInt(baseDecimals) : u64(file.grid.priceScale, 'grid.priceScale');
  const market: Market = { priceScale, baseDecimals, quoteDecimals: quote.decimals };
  const price = (v: string | number, field: string): bigint => {
    if (atoms) return u64(v, field);
    const p = parsePrice(String(v), market);
    if (p === null) throw new UsageError(`${field}: ${v} quote tokens per base token is not exactly representable with priceScale ${priceScale} (quote has ${quote.decimals} decimals).`);
    return p;
  };
  const amount = (v: string | number, field: string): bigint => {
    if (atoms) return u64(v, field);
    const a = parseAtoms(String(v), baseDecimals);
    if (a === null) throw new UsageError(`${field}: ${v} is not a valid amount of base tokens (at most ${baseDecimals} decimal places).`);
    return a;
  };

  const minPrice = price(file.grid.min, 'grid.min');
  const tick = price(file.grid.tick, 'grid.tick');
  if (tick === 0n) throw new UsageError('grid.tick must be greater than zero.');
  if (minPrice === 0n) throw new UsageError('grid.min must be greater than zero.');
  const openTs = file.window.open === undefined ? now : parseTime(file.window.open, now, 'window.open');
  const closeTs = parseTime(file.window.close, now, 'window.close');
  if (closeTs <= openTs) throw new UsageError('window.close must be after window.open.');
  let revealEndTs = closeTs;
  if (file.disclosure === 'sealed') {
    if (file.window.revealEnd === undefined) throw new UsageError('window.revealEnd is required for sealed crosses: the time bidders have to reveal after the close.');
    revealEndTs = parseTime(file.window.revealEnd, now, 'window.revealEnd');
    if (revealEndTs <= closeTs) throw new UsageError('window.revealEnd must be after window.close.');
  }

  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  return {
    creator,
    baseMint: file.baseMint ?? null,
    quoteMint: file.quoteMint,
    baseTokenProgram: file.baseTokenProgram ?? base?.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS,
    quoteTokenProgram: file.quoteTokenProgram ?? quote.tokenProgram,
    crossId: file.crossId === undefined ? random(6).reduce((acc, x) => acc * 256n + BigInt(x), 0n) : u64(file.crossId, 'crossId'),
    kind: file.kind ?? 'launch',
    supplyMode: file.supplyMode,
    disclosure: file.disclosure,
    minPrice,
    tick,
    ticks: file.grid.ticks,
    priceScale,
    openTs,
    closeTs,
    revealEndTs,
    referencePrice: file.referencePrice === undefined || file.referencePrice === null ? null : price(file.referencePrice, 'referencePrice'),
    minMatched: file.minMatched === undefined ? 0n : amount(file.minMatched, 'minMatched'),
    maxImbalanceBps: file.maxImbalanceBps ?? null,
    integratorFeeBps: file.integratorFeeBps ?? 0,
    integrator: file.integrator ?? creator,
    gateMint: file.gateMint ?? null,
    shards: file.shards,
    maxOrders: file.maxOrders,
    proceedsTo: file.proceedsTo ?? creator,
    schedule: (file.schedule ?? []).map((l, i) => ({ price: price(l.price, `schedule[${i}].price`), quantity: amount(l.quantity, `schedule[${i}].quantity`) })),
    oracle: file.oracle ?? null,
    calendar: file.calendar ?? null,
    settler: file.settler ?? null,
    settleDeadlineTs: file.settleDeadline === undefined ? 0n : parseTime(file.settleDeadline, now, 'settleDeadline'),
  };
}
