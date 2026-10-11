// Reads what a measurement needs from the chain: each mint's decimals and its Scaled UI Amount multiplier.
import { type Address, type GetMultipleAccountsApi, type Rpc, fetchEncodedAccounts } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, decodeMint } from '@solana-program/token-2022';
import { SPL_TOKEN_PROGRAM_ADDRESS, assessMint } from '@opening-cross/token-safety';
import { multiplierE12 } from './math.js';

export interface MintFacts {
  readonly mint: string;
  readonly decimals: number;
  /** Multiplier in force now, scaled by 10^12. */
  readonly multiplierE12: bigint;
}

/** Facts for each mint that is a readable token mint; mints that are not are left out. */
export async function readMintFacts(rpc: Rpc<GetMultipleAccountsApi>, mints: readonly string[], nowSeconds: bigint): Promise<Map<string, MintFacts>> {
  const out = new Map<string, MintFacts>();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const accounts = await fetchEncodedAccounts(rpc, batch as Address[]);
    accounts.forEach((acc, j) => {
      const mint = batch[j] as string;
      if (!acc.exists || (acc.programAddress !== TOKEN_2022_PROGRAM_ADDRESS && acc.programAddress !== SPL_TOKEN_PROGRAM_ADDRESS)) return;
      const decoded = decodeMint(acc);
      const report = assessMint(mint as Address, acc.programAddress, decoded.data, nowSeconds);
      out.set(mint, { mint, decimals: report.decimals, multiplierE12: multiplierE12(report.uiMultiplier) });
    });
  }
  return out;
}
