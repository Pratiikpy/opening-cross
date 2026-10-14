// Three things any coin holder, or any wallet at all, can do with an extended treasury that the holder page did not offer: open a proposal, add
// quote tokens to the pot stakers share, and pay a revenue round. The rules are the program's (programs/treasury/src/gov.rs `propose_handler`,
// dist.rs `deposit_distribution_handler`, `pay_round_handler`): a proposer is the authority or a holder of at least `proposerMinBps` of the supply,
// a spend carries an amount and a destination, a NAV proposal carries neither, deposits and payments are open to everyone. The API repeats every
// check and the program repeats it again; this page says in words what it can before a wallet is asked.
import { isAddress } from '@solana/kit';
import { formatAtoms, parseAtoms } from './units';

/** The smallest holding that may propose: `supply * minBps / 10,000`, rounded down (the program's `mul_div`). */
export const minHolding = (supply: bigint, minBps: number): bigint => (supply * BigInt(minBps)) / 10_000n;

export type Standing = { ok: true } | { ok: false; message: string };
/** Whether a wallet may open a proposal. The authority always may; a holder needs a holding of at least the minimum and above zero. */
export function proposerStanding(held: bigint, supply: bigint, minBps: number, isAuthority: boolean, coinDecimals: number): Standing {
  if (isAuthority) return { ok: true };
  const need = minHolding(supply, minBps);
  if (held === 0n || held < need) {
    return { ok: false, message: `A proposal needs a holding of at least ${formatAtoms(need > 0n ? need : 1n, coinDecimals)} coins (${Number((minBps / 100).toFixed(2))}% of the supply). This wallet holds ${formatAtoms(held, coinDecimals)}.` };
  }
  return { ok: true };
}

export type ProposalForm = { kind: 'spend' | 'open-nav' | 'close-nav'; amount: string; destination: string; description: string };
export const EMPTY_PROPOSAL: ProposalForm = { kind: 'spend', amount: '', destination: '', description: '' };
export type ProposalErrors = Partial<Record<keyof ProposalForm, string>>;

/** The body of POST /v1/treasuries/:address/tx/propose, without the description hash (the caller hashes the text). */
export function buildProposal(f: ProposalForm, proposer: string | null, quoteDecimals: number | null): { body: Record<string, unknown> | null; errors: ProposalErrors } {
  const errors: ProposalErrors = {};
  let amount: bigint | null = null;
  if (f.kind === 'spend') {
    if (quoteDecimals === null) errors.amount = 'The quote token’s decimals could not be read, so an amount cannot be checked.';
    else {
      amount = parseAtoms(f.amount, quoteDecimals);
      if (amount === null || amount === 0n) errors.amount = `Enter an amount above zero with at most ${quoteDecimals} decimal places.`;
    }
    if (!isAddress(f.destination.trim())) errors.destination = 'The destination is the wallet the money goes to: a Solana address.';
  }
  if (f.description.trim() === '') errors.description = 'Say what the money is for. Holders read this before they vote; only its hash is recorded on chain.';
  if (Object.keys(errors).length > 0 || !proposer) return { body: null, errors };
  return { body: { proposer, kind: f.kind, ...(f.kind === 'spend' ? { amount: String(amount), destination: f.destination.trim() } : {}) }, errors };
}

/** A round can be paid by anyone from the moment it is over until its grace period ends, and only once revenue is attested. */
export const payable = (status: 'open' | 'awaiting-payment' | 'late' | 'paid' | 'missed'): boolean => status === 'awaiting-payment';
