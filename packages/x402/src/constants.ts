// Program addresses come from the official clients. The Lighthouse address appears in no client package; it is the one
// value the x402 SVM scheme names by hand, and test/live.test.ts reads it from mainnet to prove it is an executable program.
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from '@solana-program/memo';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };

/** SPL Memo v3, the memo program the x402 SVM scheme names. */
export const MEMO_PROGRAM_ADDRESS = LEGACY_MEMO_PROGRAM_ADDRESS_V3;

/** Wallets such as Phantom and Solflare append Lighthouse assertions to a transaction they sign. The scheme allows them. */
export const LIGHTHOUSE_PROGRAM_ADDRESS = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

export const X402_VERSION = 2;

/** Compute budget instruction discriminators (ComputeBudgetInstruction::SetComputeUnitLimit and SetComputeUnitPrice). */
export const SET_COMPUTE_UNIT_LIMIT = 2;
export const SET_COMPUTE_UNIT_PRICE = 3;
/** SPL Token and Token-2022 TransferChecked share the discriminator 12 and the layout [u8 12, u64 amount, u8 decimals]. */
export const TRANSFER_CHECKED = 12;

export const MAX_MEMO_BYTES = 256;
/** A Solana transaction is at most 1232 bytes on the wire. */
export const MAX_TRANSACTION_BYTES = 1232;

/** Limits on what a payer may make the fee payer spend. The scheme caps the price per compute unit at 5 lamports and says
 * implementations may be stricter; the product of limit and price is what the fee payer actually pays, so that is capped too. */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 20_000;
export const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n;
export const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000_000n;
export const MAX_COMPUTE_UNIT_LIMIT = 200_000;
/** Upper bound of the priority fee (limit times price, in lamports) a verified transaction may carry. */
export const MAX_PRIORITY_FEE_LAMPORTS = 10_000n;

/** CAIP-2 identifier of a Solana cluster: `solana:` plus the first 32 characters of its genesis hash. */
export const CAIP2_GENESIS_PREFIX_LENGTH = 32;
