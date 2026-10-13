'use client';

// What a wallet holds of one token, read from the chain the app points at, so an order that the wallet cannot fund is
// stopped with a sentence instead of a failed simulation ("custom program error: 0x1").
import { RPC_URL } from './config';

type Accounts = { result?: { value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }; error?: { code?: number; message: string } };

/** The sum of the wallet's token accounts for `mint` (any token program), or null when the network could not be read. */
export async function readTokenBalance(owner: string, mint: string): Promise<bigint | null> {
  try {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
      });
      const json = (await res.json().catch(() => ({}))) as Accounts;
      if ((res.status === 429 || json.error?.code === 429) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
        continue;
      }
      if (!json.result) return null;
      return json.result.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    }
  } catch {
    return null;
  }
}

/** How much more the wallet would need, or 0n when it can fund the order or its balance is unknown. */
export const shortfall = (balance: bigint | null, needed: bigint): bigint => (balance === null || balance >= needed ? 0n : needed - balance);
