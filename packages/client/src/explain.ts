// Turns what a Solana RPC says about a refused or failed transaction into a sentence a person can act on.
// The cluster answers in program logs and error codes ("custom program error: 0x1"); a wallet that is short of
// SOL for rent used to see exactly that. Pure: it reads the error object and the logs and nothing else.
import { formatSol } from './units.js';

export type RpcFailure = { code?: number; message?: string; data?: { logs?: string[] | null; err?: unknown } | null };

/** A sentence for a failed or refused transaction, or null when nothing recognisable is in it. */
export function explainFailure(f: RpcFailure): string | null {
  const logs = f.data?.logs ?? [];
  const text = [f.message ?? '', ...logs].join('\n');

  // The System Program refusing to move lamports: the wallet cannot pay the rent or the fee.
  const short = /Transfer: insufficient lamports (\d+), need (\d+)/.exec(text);
  if (short) {
    const have = BigInt(short[1]!);
    const need = BigInt(short[2]!);
    return `Your wallet does not hold enough SOL for this step: it has ${formatSol(have)} and the step needs ${formatSol(need)} (rent for the accounts it opens). Add SOL to this wallet and try again; nothing was spent.`;
  }
  if (/Attempt to debit an account but found no record of a prior credit/i.test(text)) {
    return 'This wallet has no SOL on this network, so it cannot pay the network fee. Add a little SOL and try again.';
  }
  if (/insufficient funds for fee|Insufficient funds for rent/i.test(text)) {
    return 'This wallet does not hold enough SOL for the network fee and rent. Add SOL and try again.';
  }
  if (/Blockhash not found|block height exceeded/i.test(text)) {
    return 'The transaction expired before the network confirmed it. Nothing was spent; try again.';
  }
  const tokenTransfer = /Tokenkeg|TokenzQd|Instruction: (Transfer|TransferChecked)/.test(text);
  if (/Error: insufficient funds/i.test(text) || (tokenTransfer && /custom program error: 0x1\b/.test(text))) {
    return 'This wallet does not hold enough of the token for this order. Nothing was spent.';
  }
  const program = logs.find((l) => l.includes('Error Message:'))?.split('Error Message:')[1]?.trim();
  if (program) return `The program refused this: ${program}`;
  if (/custom program error: 0x1\b/.test(text) && /11111111111111111111111111111111/.test(text)) {
    return 'This wallet does not hold enough SOL to open the accounts this step needs. Add SOL and try again.';
  }
  if (f.message && !/^Transaction simulation failed$/i.test(f.message)) return f.message;
  return null;
}
