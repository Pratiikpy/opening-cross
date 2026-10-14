// The forms of the settle page that open a market and use Meteora's programs, turned into the bodies of the W3E routes
// (docs/api/W3E-markets-keeper-neutrality.md): the DBC continuation, a DAMM v2 pool (plain, batched, with an Alpha Vault, with its liquidity locked),
// a DLMM pair (plain, batched, behind Token Badges), a Raydium CPMM pool, an Alpha Vault, a Met Lock escrow and a Dynamic Fee Sharing vault.
// Pure and free of React. Every rule here is one the API or the program makes again; this decides what a person is told before a wallet is asked.
import { isAddress } from '@solana/kit';
import { parseAtoms } from './units';

const whole = (s: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | null => {
  const t = s.trim();
  if (!/^\d{1,15}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};
/** A percentage with at most two decimals, as basis points. */
const pctBps = (s: string): number | null => (/^\d{1,3}(\.\d{1,2})?$/.test(s.trim()) ? Math.round(Number(s.trim()) * 100) : null);
const seconds = (s: string): number | null => {
  const t = s.trim() === '' ? NaN : new Date(s).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

export type Built<K extends string> = { body: Record<string, unknown> | null; errors: Partial<Record<K, string>> };
type Decimals = { base: number | null; quote: number | null };

/** The least a batch window can be and the most (program: `batch::MIN_WINDOW_SECS`, `MAX_WINDOW_SECS`). The API names the exact figures; these are the page's own guard. */
export const BATCH_MIN_SECS = 30;
export const BATCH_MAX_SECS = 7 * 86_400;
/** Time for the person to sign and the transaction to land, so a start that is just far enough away is not refused on arrival. */
export const LAND_MARGIN_SECS = 90;

// ---------------------------------------------------------------------------------------------------- the DBC continuation

/**
 * The locked, compounding design the program accepts for `open_dbc_pool_locked`, as JSON with every enum a number. It is the one the API's tests
 * send (services/api/test/settle-open-tx.test.ts), which tests/core run against the real DBC and DAMM v2 binaries. A person edits it as text; the
 * API names every departure from the locked design before anything is signed.
 */
export const LOCKED_DESIGN_TEMPLATE = {
  token: { tokenBaseDecimal: 6, tokenQuoteDecimal: 6, totalTokenSupply: 1_000_000_000, leftover: 5_000_000 },
  fee: { baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage: 40, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: 1, migrationFeeOption: 6, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, migratedPoolFee: { collectFeeMode: 2, dynamicFee: 0, poolFeeBps: 100, compoundingFeeBps: 5000 } },
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 30,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityVestingInfoParams: { vestingPercentage: 60, bpsPerPeriod: 2500, numberOfPeriods: 4, cliffDurationFromMigrationTime: 0, totalDuration: 4 * 86_400 },
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: 1,
  sqrtPriceMultiples: [2, 4],
} as const;

export type DbcForm = { design: string; name: string; symbol: string; uri: string; locked: boolean };
export const EMPTY_DBC: DbcForm = { design: JSON.stringify(LOCKED_DESIGN_TEMPLATE, null, 2), name: '', symbol: '', uri: '', locked: true };

export function buildDbc(f: DbcForm, cross: string, creator: string | null): Built<keyof DbcForm> {
  const errors: Built<keyof DbcForm>['errors'] = {};
  let design: unknown;
  try {
    design = JSON.parse(f.design);
    if (typeof design !== 'object' || design === null || Array.isArray(design)) throw new Error('not an object');
  } catch {
    errors.design = 'The design is not valid JSON: it is one object with token, fee, migration, liquidityDistribution, lockedVesting, activationType and sqrtPriceMultiples.';
  }
  const text = (k: 'name' | 'symbol' | 'uri', max: number, what: string) => {
    const v = f[k].trim();
    if (v.length === 0 || v.length > max) errors[k] = `${what} is 1 to ${max} characters.`;
  };
  text('name', 32, 'The name');
  text('symbol', 10, 'The symbol');
  text('uri', 200, 'The metadata link');
  if (Object.keys(errors).length > 0 || !creator) return { body: null, errors };
  return { body: { cross, creator, design, name: f.name.trim(), symbol: f.symbol.trim(), uri: f.uri.trim(), locked: f.locked }, errors };
}

// ---------------------------------------------------------------------------------------------------- a DAMM v2 pool

export type DammForm = { baseAmount: string; quoteAmount: string; feePct: string; batch: boolean; startAt: string; windowMins: string; endingFeePct: string; periods: string; periodMins: string; alphaVault: boolean; lockAll: boolean };
export const EMPTY_DAMM: DammForm = { baseAmount: '', quoteAmount: '', feePct: '1', batch: false, startAt: '', windowMins: '60', endingFeePct: '0.25', periods: '10', periodMins: '10', alphaVault: false, lockAll: false };

export function buildDamm(f: DammForm, cross: string, creator: string | null, d: Decimals, nowSecs: number): Built<keyof DammForm> {
  const errors: Built<keyof DammForm>['errors'] = {};
  const amount = (k: 'baseAmount' | 'quoteAmount', dec: number | null, what: string) => {
    if (dec === null) {
      errors[k] = `The ${what} token could not be read, so this amount cannot be checked.`;
      return null;
    }
    const a = parseAtoms(f[k], dec);
    if (a === null || a === 0n) errors[k] = `Enter an amount above zero with at most ${dec} decimal places.`;
    return a;
  };
  const base = amount('baseAmount', d.base, 'base');
  const quote = amount('quoteAmount', d.quote, 'quote');
  const fee = pctBps(f.feePct);
  if (fee === null || fee < 1 || fee > 10_000) errors.feePct = 'A fee from 0.01% to 100% with at most two decimals.';
  let batch: Record<string, unknown> | undefined;
  if (f.batch) {
    const window = whole(f.windowMins, 1);
    const start = seconds(f.startAt);
    const ending = pctBps(f.endingFeePct);
    const periods = whole(f.periods, 1, 0xffff);
    const periodMins = whole(f.periodMins, 1);
    if (window === null || window * 60 < BATCH_MIN_SECS || window * 60 > BATCH_MAX_SECS) errors.windowMins = 'The pool is closed for a whole number of minutes: at least 1, at most 7 days.';
    if (start === null) errors.startAt = 'Choose when swaps open.';
    else if (window !== null && start < nowSecs + window * 60 + LAND_MARGIN_SECS) errors.startAt = `Swaps must open at least the window (${window} minutes) plus a minute and a half after the transaction lands. The earliest now is ${new Date((nowSecs + window * 60 + LAND_MARGIN_SECS) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC.`;
    if (ending === null || ending > 10_000) errors.endingFeePct = 'A fee from 0% to 100% with at most two decimals.';
    else if (fee !== null && ending >= fee) errors.endingFeePct = 'A batch-opened pool opens with a fee above the one it settles at: the ending fee must be lower than the opening fee.';
    if (periods === null) errors.periods = 'The fee steps down over 1 to 65,535 periods.';
    if (periodMins === null) errors.periodMins = 'Each fee period lasts a whole number of minutes, at least 1.';
    if (window !== null && start !== null && ending !== null && periods !== null && periodMins !== null) batch = { windowSecs: window * 60, activationPoint: String(start), endingFeeBps: ending, periods, periodSecs: periodMins * 60 };
  }
  if (f.alphaVault && !f.batch) errors.alphaVault = 'An Alpha Vault buys before the public start, so the pool needs a start: choose a batch opening.';
  if (Object.keys(errors).length > 0 || !creator || base === null || quote === null || fee === null) return { body: null, errors };
  return {
    body: { cross, creator, baseAmount: base.toString(), quoteAmount: quote.toString(), feeBps: fee, ...(batch ? { batch } : {}), ...(f.alphaVault ? { alphaVault: true } : {}), ...(f.lockAll ? { lock: { permanentLiquidity: 'all' } } : {}) },
    errors,
  };
}

// ---------------------------------------------------------------------------------------------------- a DLMM pair

export type DlmmForm = { binStep: string; baseFactor: string; baseFeePowerFactor: string; batch: boolean; startAt: string; windowMins: string; alphaVault: boolean; badgeBase: boolean; badgeQuote: boolean };
export const EMPTY_DLMM: DlmmForm = { binStep: '', baseFactor: '', baseFeePowerFactor: '', batch: false, startAt: '', windowMins: '60', alphaVault: false, badgeBase: false, badgeQuote: false };

export function buildDlmm(f: DlmmForm, cross: string, creator: string | null, nowSecs: number): Built<keyof DlmmForm> {
  const errors: Built<keyof DlmmForm>['errors'] = {};
  const binStep = whole(f.binStep, 1, 0xffff);
  const baseFactor = whole(f.baseFactor, 1, 0xffff);
  const power = f.baseFeePowerFactor.trim() === '' ? undefined : whole(f.baseFeePowerFactor, 0, 255);
  if (binStep === null) errors.binStep = 'The bin step is a whole number of basis points: the price gap between two bins.';
  if (baseFactor === null) errors.baseFactor = 'The base factor is a whole number; the base fee is the bin step times it.';
  if (power === null) errors.baseFeePowerFactor = 'The power factor is a whole number from 0 to 255, or empty.';
  let batch: Record<string, unknown> | undefined;
  if (f.batch) {
    const window = whole(f.windowMins, 1);
    const start = seconds(f.startAt);
    if (window === null || window * 60 < BATCH_MIN_SECS || window * 60 > BATCH_MAX_SECS) errors.windowMins = 'The pair is closed for a whole number of minutes: at least 1, at most 7 days.';
    if (start === null) errors.startAt = 'Choose when swaps open.';
    else if (window !== null && start < nowSecs + window * 60 + LAND_MARGIN_SECS) errors.startAt = `Swaps must open at least the window (${window} minutes) plus a minute and a half after the transaction lands.`;
    if (window !== null && start !== null) batch = { windowSecs: window * 60, activationPoint: String(start), ...(f.alphaVault ? { alphaVault: true } : {}) };
  } else if (f.alphaVault) errors.alphaVault = 'An Alpha Vault buys before the public start, so the pair needs a start: choose a batch opening.';
  const badges: Record<string, boolean> = {};
  if (f.badgeBase) badges.base = true;
  if (f.badgeQuote) badges.quote = true;
  if (Object.keys(errors).length > 0 || !creator || binStep === null || baseFactor === null) return { body: null, errors };
  return { body: { cross, creator, binStep, baseFactor, ...(power !== undefined ? { baseFeePowerFactor: power } : {}), ...(batch ? { batch } : {}), ...(Object.keys(badges).length > 0 ? { badges } : {}) }, errors };
}

// ---------------------------------------------------------------------------------------------------- a Raydium CPMM pool

export type RaydiumForm = { baseAmount: string; ammConfigIndex: string; openAt: string };
export const EMPTY_RAYDIUM: RaydiumForm = { baseAmount: '', ammConfigIndex: '', openAt: '' };

export function buildRaydium(f: RaydiumForm, cross: string, creator: string | null, d: Decimals): Built<keyof RaydiumForm> {
  const errors: Built<keyof RaydiumForm>['errors'] = {};
  let base: bigint | null = null;
  if (d.base === null) errors.baseAmount = 'The base token could not be read, so this amount cannot be checked.';
  else {
    base = parseAtoms(f.baseAmount, d.base);
    if (base === null || base === 0n) errors.baseAmount = `Enter an amount above zero with at most ${d.base} decimal places.`;
  }
  const index = f.ammConfigIndex.trim() === '' ? undefined : whole(f.ammConfigIndex, 0, 0xffff);
  if (index === null) errors.ammConfigIndex = 'The fee tier is a whole number (Raydium’s config index), or empty for the first.';
  const open = f.openAt.trim() === '' ? undefined : seconds(f.openAt);
  if (open === null) errors.openAt = 'Choose a time, or leave it empty to open at once.';
  if (Object.keys(errors).length > 0 || !creator || base === null) return { body: null, errors };
  return { body: { cross, creator, baseAmount: base.toString(), ...(index !== undefined ? { ammConfigIndex: index } : {}), ...(open !== undefined ? { openTime: String(open) } : {}) }, errors };
}

// ---------------------------------------------------------------------------------------------------- an Alpha Vault

export type AlphaForm = { mode: 'prorata' | 'fcfs'; buyingCap: string; depositCap: string; perWalletCap: string; depositAt: string; vestStart: string; vestEnd: string };
export const EMPTY_ALPHA: AlphaForm = { mode: 'prorata', buyingCap: '', depositCap: '', perWalletCap: '', depositAt: '', vestStart: '', vestEnd: '' };

export function buildAlphaInit(f: AlphaForm, cross: string, funder: string | null, quoteDecimals: number | null): Built<keyof AlphaForm> {
  const errors: Built<keyof AlphaForm>['errors'] = {};
  const cap = (k: 'buyingCap' | 'depositCap' | 'perWalletCap', what: string) => {
    if (quoteDecimals === null) {
      errors[k] = 'The quote token could not be read, so this amount cannot be checked.';
      return null;
    }
    const a = parseAtoms(f[k], quoteDecimals);
    if (a === null || a === 0n) errors[k] = `${what} is an amount above zero with at most ${quoteDecimals} decimal places.`;
    return a;
  };
  let caps: Record<string, string> = {};
  if (f.mode === 'prorata') {
    const c = cap('buyingCap', 'The most the vault buys');
    if (c !== null) caps = { maxBuyingCap: c.toString() };
  } else {
    const c = cap('depositCap', 'The most the vault takes in');
    const w = cap('perWalletCap', 'The most one wallet may deposit');
    if (c !== null && w !== null) caps = { maxDepositingCap: c.toString(), individualDepositingCap: w.toString() };
  }
  const vs = seconds(f.vestStart);
  const ve = seconds(f.vestEnd);
  const dep = f.depositAt.trim() === '' ? undefined : seconds(f.depositAt);
  if (vs === null) errors.vestStart = 'Choose when claiming starts.';
  if (ve === null) errors.vestEnd = 'Choose when vesting ends.';
  if (vs !== null && ve !== null && ve <= vs) errors.vestEnd = 'Vesting must end after it starts.';
  if (dep === null) errors.depositAt = 'Choose a time, or leave it empty to open deposits at once.';
  if (Object.keys(errors).length > 0 || !funder || vs === null || ve === null) return { body: null, errors };
  return { body: { cross, funder, mode: f.mode, ...caps, startVestingPoint: String(vs), endVestingPoint: String(ve), ...(dep !== undefined ? { depositingPoint: String(dep) } : {}) }, errors };
}

// ---------------------------------------------------------------------------------------------------- a Met Lock escrow

export type MetLockForm = { mint: string; recipient: string; total: string; startAt: string; cliffDays: string; periods: string; periodDays: string; cliffUnlockPct: string };
export const EMPTY_METLOCK: MetLockForm = { mint: '', recipient: '', total: '', startAt: '', cliffDays: '0', periods: '4', periodDays: '30', cliffUnlockPct: '0' };

export function buildMetLock(f: MetLockForm, sender: string | null, base: string | null, mintDecimals: number | null): Built<keyof MetLockForm> {
  const errors: Built<keyof MetLockForm>['errors'] = {};
  if (!isAddress(f.mint.trim())) errors.mint = 'The token to lock is a Solana address.';
  if (!isAddress(f.recipient.trim())) errors.recipient = 'The recipient is a Solana address.';
  let total: bigint | null = null;
  if (mintDecimals === null) errors.total = 'The token could not be read, so the amount cannot be checked.';
  else {
    total = parseAtoms(f.total, mintDecimals);
    if (total === null || total === 0n) errors.total = `Enter an amount above zero with at most ${mintDecimals} decimal places.`;
  }
  const start = seconds(f.startAt);
  const cliff = whole(f.cliffDays, 0, 3650);
  const periods = whole(f.periods, 1, 0xffff);
  const every = whole(f.periodDays, 1, 3650);
  const unlock = pctBps(f.cliffUnlockPct);
  if (start === null) errors.startAt = 'Choose when the schedule starts.';
  if (cliff === null) errors.cliffDays = 'The cliff is a whole number of days, 0 or more.';
  if (periods === null) errors.periods = 'The tokens vest over 1 to 65,535 periods.';
  if (every === null) errors.periodDays = 'Each period is a whole number of days, at least 1.';
  if (unlock === null || unlock > 10_000) errors.cliffUnlockPct = 'A percentage from 0 to 100 with at most two decimals.';
  if (Object.keys(errors).length > 0 || !sender || !base || total === null || start === null || cliff === null || periods === null || every === null || unlock === null) return { body: null, errors };
  return {
    body: { sender, base, mint: f.mint.trim(), recipient: f.recipient.trim(), schedule: { total: total.toString(), start: String(start), cliffSeconds: cliff * 86_400, frequency: every * 86_400, periods, cliffUnlockBps: unlock } },
    errors,
  };
}

// ---------------------------------------------------------------------------------------------------- Dynamic Fee Sharing

export type RecipientRow = { address: string; share: string };
export const MAX_RECIPIENTS = 5;

export function buildFeeShare(rows: RecipientRow[], payer: string | null, base: string | null, cross: string): { body: Record<string, unknown> | null; error: string | null; percents: number[] } {
  // A row with no address is a row not yet filled in, whatever its default weight says.
  const filled = rows.filter((r) => r.address.trim() !== '');
  if (filled.length === 0) return { body: null, error: null, percents: [] };
  if (filled.length > MAX_RECIPIENTS) return { body: null, error: `A fee vault splits between at most ${MAX_RECIPIENTS} recipients.`, percents: [] };
  const shares: number[] = [];
  for (const [i, r] of filled.entries()) {
    if (!isAddress(r.address.trim())) return { body: null, error: `Recipient ${i + 1} is not a Solana address.`, percents: [] };
    const s = whole(r.share, 1, 1_000_000);
    if (s === null) return { body: null, error: `Recipient ${i + 1}’s share is a whole number above zero: a weight, so 1, 1 splits evenly and 3, 1 gives one three quarters.`, percents: [] };
    shares.push(s);
  }
  if (new Set(filled.map((r) => r.address.trim())).size !== filled.length) return { body: null, error: 'A recipient is listed once.', percents: [] };
  const sum = shares.reduce((a, b) => a + b, 0);
  const percents = shares.map((s) => Math.round((s / sum) * 10_000) / 100);
  if (!payer || !base) return { body: null, error: null, percents };
  return { body: { payer, base, cross, recipients: filled.map((r, i) => ({ address: r.address.trim(), share: shares[i] })) }, error: null, percents };
}
