// The treasury creation form turned into the API's request, exactly and with every refusal named. Amounts are converted with the quote
// token's decimals and refused if they would round; periods are whole seconds; the coin must already have a fixed supply, which is
// the one thing the program insists on (SupplyNotFixed) and the one thing most worth telling an issuer before they sign.
import { isAddress } from '@solana/kit';
import type { MintRead } from './issuer-readiness';
import { parseAtoms } from './units';

export type TreasuryForm = {
  coinMint: string;
  quoteMint: string;
  allowance: string;
  periodAmount: string;
  periodUnit: 'hours' | 'days';
  graceAmount: string;
  graceUnit: 'hours' | 'days';
  credential: string;
  schema: string;
};

export const EMPTY_TREASURY: TreasuryForm = { coinMint: '', quoteMint: '', allowance: '', periodAmount: '30', periodUnit: 'days', graceAmount: '7', graceUnit: 'days', credential: '', schema: '' };

const UNIT_SECS = { hours: 3_600, days: 86_400 } as const;
const MAX_SECS = 10 * 365 * 86_400;

export type TreasuryCheck = { ok: true; body: Record<string, unknown>; summary: { allowanceAtoms: bigint; periodSecs: number; graceSecs: number } } | { ok: false; errors: Record<string, string> };

const wholeNumber = (t: string) => (/^\d{1,6}$/.test(t.trim()) ? Number(t.trim()) : null);

export function checkTreasuryForm(f: TreasuryForm, authority: string, coin: MintRead | null, quote: MintRead | null): TreasuryCheck {
  const errors: Record<string, string> = {};
  if (!isAddress(f.coinMint.trim())) errors.coinMint = 'Enter the coin’s mint address.';
  else if (coin && !coin.ok) errors.coinMint = coin.reason;
  else if (coin && coin.ok) {
    if (coin.mintAuthority !== null) errors.coinMint = 'This coin’s supply is not fixed yet: its mint authority is still set. A treasury can only be created after the supply is fixed. A coin minted by a cross is fixed when the cross finalizes.';
    else if ((coin.supply ?? 1n) === 0n) errors.coinMint = 'This coin has no supply, so nobody could hold a claim on the treasury.';
  }
  if (!isAddress(f.quoteMint.trim())) errors.quoteMint = 'Enter the mint address of the token the treasury holds.';
  else if (quote && !quote.ok) errors.quoteMint = quote.reason;
  else if (f.coinMint.trim() === f.quoteMint.trim()) errors.quoteMint = 'The treasury must hold a different token from the coin.';

  const decimals = quote && quote.ok ? quote.decimals : null;
  let allowance: bigint | null = null;
  if (decimals === null) errors.allowance = errors.allowance ?? 'Check the quote token first so the amount can be read exactly.';
  else {
    allowance = parseAtoms(f.allowance, decimals);
    if (allowance === null || allowance === 0n) errors.allowance = `Enter an amount above zero with at most ${decimals} decimal places.`;
  }
  const p = wholeNumber(f.periodAmount);
  const g = wholeNumber(f.graceAmount);
  const periodSecs = p === null ? null : p * UNIT_SECS[f.periodUnit];
  const graceSecs = g === null ? null : g * UNIT_SECS[f.graceUnit];
  if (periodSecs === null || periodSecs < 1 || periodSecs > MAX_SECS) errors.periodAmount = 'Enter a whole number above zero, at most ten years.';
  if (graceSecs === null || graceSecs > MAX_SECS) errors.graceAmount = 'Enter a whole number, at most ten years (0 means no grace).';
  if (!isAddress(f.credential.trim())) errors.credential = 'Enter the attestation credential address your attester created.';
  if (!isAddress(f.schema.trim())) errors.schema = 'Enter the attestation schema address.';
  if (Object.keys(errors).length || allowance === null || periodSecs === null || graceSecs === null) return { ok: false, errors };
  return {
    ok: true,
    body: { authority, coinMint: f.coinMint.trim(), quoteMint: f.quoteMint.trim(), allowance: allowance.toString(), periodSecs, graceSecs, credential: f.credential.trim(), schema: f.schema.trim() },
    summary: { allowanceAtoms: allowance, periodSecs, graceSecs },
  };
}
