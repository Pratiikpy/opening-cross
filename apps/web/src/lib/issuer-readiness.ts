// The issuer's readiness checklist: what must be true before "Create the cross" can succeed, each item judged from facts read off the
// chain (see issuer-chain.ts). This file is pure so every verdict can be tested. A fact that could not be read makes its item fail
// with the reason; nothing is assumed to be fine.
import { formatAtoms } from './units';

export type MintRead =
  | { ok: true; program: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null; extensions: string[] }
  | { ok: false; reason: string };

/** Lamports a cross costs to open, from rent-exemption minimums the cluster reported for the real account sizes. */
export type RentModel = {
  cross: bigint;
  level: bigint;
  vault: bigint;
  /** Where the account sizes came from: measured on the newest cross on chain, or the sizes this build was made with when none exists yet. */
  sizes?: 'chain' | 'built-in';
};

export type ChainFacts = {
  base: MintRead | null;
  quote: MintRead | null;
  lamports: bigint | null;
  /** The wallet's associated token account for the quote mint: whether it exists and what it holds (quote atoms). null: could not be read. */
  quoteAccount: { exists: boolean; amount: bigint } | null;
  rent: RentModel | null;
  /** Chain time at the moment it was read, in ms, and the local clock then; the difference carries chain time forward. */
  clock: { chainMs: number; localMs: number } | null;
};

export type ReadinessInput = {
  wallet: string;
  supplyMode: 'escrow' | 'mint';
  baseMint: string;
  quoteMint: string;
  shards: number;
  openAt: Date;
  closeAt: Date;
  /** The create-cross body when the form is valid, else the form's field errors. */
  form: { ok: true; body: Record<string, unknown> } | { ok: false; errors: Record<string, string> } | null;
};

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'wait';
export type Check = { id: string; label: string; status: CheckStatus; detail: string };

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** A signature costs 5000 lamports on Solana; the create is one transaction and each shard another. */
const FEE_PER_TX = 5000n;

const TOKEN_PROGRAMS: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'the classic SPL Token program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
};

const SIZES_NOTE = ' No cross exists yet to measure, so the account sizes are the ones this build was made with.';

export const sol = (lamports: bigint) => `${formatAtoms(lamports, 9, 6)} SOL`;
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** What creating the cross costs in SOL: rent for its accounts and the associated token account if it must be created, plus network fees. */
export function creationCost(rent: RentModel, shards: number, quoteAccountExists: boolean): { rent: bigint; ata: bigint; fees: bigint; total: bigint } {
  const accounts = rent.cross + rent.level * BigInt(1 + shards) + rent.vault * 2n;
  const ata = quoteAccountExists ? 0n : rent.vault;
  const fees = FEE_PER_TX * BigInt(1 + shards);
  return { rent: accounts, ata, fees, total: accounts + ata + fees };
}

/** The bond taken from the issuer's quote account at creation: one atom per order at the highest grid price (cross_core, ADR-0003). */
export function dustBond(body: Record<string, unknown>): bigint | null {
  try {
    const min = BigInt(String(body.minPrice));
    const tick = BigInt(String(body.tick));
    const ticks = BigInt(String(body.ticks));
    const scale = BigInt(String(body.priceScale));
    const max = min + (ticks - 1n) * tick;
    return (BigInt(String(body.maxOrders)) * max + scale - 1n) / scale;
  } catch {
    return null;
  }
}

export function evaluateReadiness(input: ReadinessInput, facts: ChainFacts | null, nowMs: number): Check[] {
  const checks: Check[] = [];
  const need = (id: string, label: string): Check => ({ id, label, status: 'wait', detail: 'Check both mints to read this from the chain.' });
  if (!facts || !facts.base || !facts.quote) {
    return [need('authority', 'Mint authority matches the supply mode'), need('decimals', 'Mint decimals'), need('programs', 'Token programs'), need('rent', 'SOL for rent and fees'), need('quote', 'Quote token account and bond'), need('window', 'Call window'), need('form', 'Form')];
  }
  const { base, quote } = facts;

  // ---- supply mode and mint authority
  if (!base.ok) checks.push({ id: 'authority', label: 'Mint authority matches the supply mode', status: 'fail', detail: `The base mint could not be read: ${base.reason}` });
  else if (input.supplyMode === 'mint') {
    if (base.mintAuthority === input.wallet) {
      checks.push({
        id: 'authority',
        label: 'Mint authority matches the supply mode',
        status: 'pass',
        detail: 'This wallet holds the base mint authority. Creating the cross hands it to the cross in the same transaction; from then on only the cross can mint, and only at the clearing price.',
      });
    } else if (base.mintAuthority === null) {
      checks.push({ id: 'authority', label: 'Mint authority matches the supply mode', status: 'fail', detail: 'The base mint has no mint authority, so nothing can be minted at settlement. Choose "Sell orders from escrow" instead.' });
    } else {
      checks.push({
        id: 'authority',
        label: 'Mint authority matches the supply mode',
        status: 'fail',
        detail: `The base mint authority is ${short(base.mintAuthority)}, not this wallet. A minting cross needs this wallet to hold it. Connect ${short(base.mintAuthority)}, or choose "Sell orders from escrow".`,
      });
    }
  } else {
    checks.push({
      id: 'authority',
      label: 'Mint authority matches the supply mode',
      status: 'pass',
      detail: 'Escrow supply needs no mint authority: sellers deposit tokens that already exist.',
    });
  }
  if (base.ok && base.freezeAuthority !== null)
    checks.push({ id: 'freeze', label: 'Freeze authority', status: 'warn', detail: `The base mint can be frozen by ${short(base.freezeAuthority)}. A frozen vault or buyer account blocks payouts; buyers can see this on the cross page.` });

  // ---- decimals
  if (base.ok && quote.ok) checks.push({ id: 'decimals', label: 'Mint decimals', status: 'pass', detail: `Base token ${base.decimals} decimals, quote token ${quote.decimals} decimals. Prices and amounts are converted with these.` });
  else checks.push({ id: 'decimals', label: 'Mint decimals', status: 'fail', detail: [!base.ok ? `Base mint: ${base.reason}` : null, !quote.ok ? `Quote mint: ${quote.reason}` : null].filter(Boolean).join(' ') });

  // ---- token programs
  if (base.ok && quote.ok) {
    const name = (p: string) => TOKEN_PROGRAMS[p] ?? `an unrecognised program (${short(p)})`;
    const ext = [...base.extensions.map((e) => `base: ${e}`), ...quote.extensions.map((e) => `quote: ${e}`)];
    if (input.baseMint && input.baseMint === input.quoteMint) checks.push({ id: 'programs', label: 'Token programs', status: 'fail', detail: 'The base and quote mint are the same token. A cross needs two different tokens.' });
    else if (!(base.program in TOKEN_PROGRAMS) || !(quote.program in TOKEN_PROGRAMS))
      checks.push({ id: 'programs', label: 'Token programs', status: 'fail', detail: `Base mint is owned by ${name(base.program)}, quote mint by ${name(quote.program)}. Only the classic SPL Token program and Token-2022 are handled.` });
    else
      checks.push({
        id: 'programs',
        label: 'Token programs',
        status: ext.length ? 'warn' : 'pass',
        detail: `Base mint uses ${name(base.program)}, quote mint uses ${name(quote.program)}.${ext.length ? ` Token-2022 extensions found (${ext.join(', ')}); check that none can tax, hook or block transfers into the cross vault.` : ''}`,
      });
  }

  // ---- SOL for rent and fees
  const exists = facts.quoteAccount?.exists ?? false;
  if (facts.lamports === null) checks.push({ id: 'rent', label: 'SOL for rent and fees', status: 'fail', detail: 'This wallet’s SOL balance could not be read from the network.' });
  else if (!facts.rent) checks.push({ id: 'rent', label: 'SOL for rent and fees', status: 'fail', detail: 'The account sizes could not be measured from an existing cross, so the cost cannot be worked out. Try again.' });
  else {
    const cost = creationCost(facts.rent, input.shards, exists);
    const ok = facts.lamports >= cost.total;
    checks.push({
      id: 'rent',
      label: 'SOL for rent and fees',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `This wallet holds ${sol(facts.lamports)}; creating needs about ${sol(cost.total)}: ${sol(cost.rent)} rent for the cross, its book, ${input.shards} shards and two vaults${cost.ata ? `, ${sol(cost.ata)} for your quote token account` : ''}, plus ${sol(cost.fees)} in fees.${facts.rent.sizes === 'built-in' ? SIZES_NOTE : ''}`
        : `This wallet holds ${sol(facts.lamports)} but creating needs about ${sol(cost.total)} (${sol(cost.rent)} rent for the cross, its book, ${input.shards} shards and two vaults${cost.ata ? `, ${sol(cost.ata)} for your quote token account` : ''}, plus ${sol(cost.fees)} in fees). Add ${sol(cost.total - facts.lamports)} more.${facts.rent.sizes === 'built-in' ? SIZES_NOTE : ''}`,
    });
  }

  // ---- quote account and bond
  const bond = input.form?.ok ? dustBond(input.form.body) : null;
  const q = quote.ok ? quote : null;
  if (!q) checks.push({ id: 'quote', label: 'Quote token account and bond', status: 'fail', detail: 'The quote mint could not be read, so the account cannot be checked.' });
  else if (facts.quoteAccount === null) checks.push({ id: 'quote', label: 'Quote token account and bond', status: 'fail', detail: 'This wallet’s quote token account could not be read from the network.' });
  else if (bond === null) {
    checks.push({
      id: 'quote',
      label: 'Quote token account and bond',
      status: 'wait',
      detail: exists ? 'The quote token account exists. The bond is worked out once the price grid and order limit are valid.' : 'No quote token account yet; it is created in the first transaction. The bond is worked out once the price grid and order limit are valid.',
    });
  } else {
    const have = facts.quoteAccount.amount;
    const fmt = (v: bigint) => formatAtoms(v, q.decimals);
    if (!exists && bond > 0n)
      checks.push({ id: 'quote', label: 'Quote token account and bond', status: 'fail', detail: `This wallet has no quote token account, and creating takes a bond of ${fmt(bond)} quote from it (one atom per allowed order at the highest price). Receive at least ${fmt(bond)} quote first.` });
    else if (have < bond)
      checks.push({ id: 'quote', label: 'Quote token account and bond', status: 'fail', detail: `The bond is ${fmt(bond)} quote (one atom per allowed order at the highest price) and this wallet holds ${fmt(have)}. It is returned at settlement.` });
    else checks.push({ id: 'quote', label: 'Quote token account and bond', status: 'pass', detail: `${exists ? 'The quote token account exists' : 'The quote token account is created in the first transaction'}. The bond is ${fmt(bond)} quote and this wallet holds ${fmt(have)}; the bond is returned at settlement.` });
  }

  // ---- window, against the chain's clock where it was read
  const chainNow = facts.clock ? nowMs + (facts.clock.chainMs - facts.clock.localMs) : nowMs;
  const clockNote = facts.clock ? 'the network’s clock' : 'this device’s clock (the network’s could not be read)';
  const open = input.openAt.getTime();
  const close = input.closeAt.getTime();
  if (Number.isNaN(open) || Number.isNaN(close)) checks.push({ id: 'window', label: 'Call window', status: 'fail', detail: 'Choose when orders open and close.' });
  else if (open < chainNow) checks.push({ id: 'window', label: 'Call window', status: 'fail', detail: `Orders are set to open in the past by ${Math.max(1, Math.round((chainNow - open) / 60_000))} min, against ${clockNote}. Move the opening time forward.` });
  else if (close <= open) checks.push({ id: 'window', label: 'Call window', status: 'fail', detail: 'The call must close after it opens.' });
  else {
    const mins = Math.max(1, Math.round((open - chainNow) / 60_000));
    checks.push({ id: 'window', label: 'Call window', status: facts.clock ? 'pass' : 'warn', detail: `Orders open in about ${mins} min and stay open ${formatDurationMs(close - open)}, against ${clockNote}.` });
  }

  // ---- the form itself
  if (!input.form) checks.push({ id: 'form', label: 'Form', status: 'wait', detail: 'Waiting for both mints to be read.' });
  else if (!input.form.ok) {
    const [field, msg] = Object.entries(input.form.errors)[0] ?? ['form', 'Fix the fields marked above.'];
    const n = Object.keys(input.form.errors).length;
    checks.push({ id: 'form', label: 'Form', status: 'fail', detail: `${msg}${n > 1 ? ` (${n} fields need attention, starting with ${field.replace(/\..*/, '')})` : ''}` });
  } else checks.push({ id: 'form', label: 'Form', status: 'pass', detail: 'Every field is valid and sits on the price grid.' });
  return checks;
}

function formatDurationMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 120) return `${mins} min`;
  const h = mins / 60;
  return h < 48 ? `${Number.isInteger(h) ? h : h.toFixed(1)} h` : `${Math.round(h / 24)} days`;
}

/** Create is allowed only when no item fails or still waits. Warnings are shown but do not block. */
export const ready = (checks: readonly Check[]) => checks.length > 0 && checks.every((c) => c.status === 'pass' || c.status === 'warn');
