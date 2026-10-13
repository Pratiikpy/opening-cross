// A cross account for tests: the program's own encoder over a zeroed account, with the fields a bid depends on set.
import { type Address, generateKeyPairSigner, getAddressEncoder, none } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, Disclosure, getCrossDecoder, getCrossEncoder } from '@opening-cross/sdk';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

export type TestCross = { address: Address; account: { data: Uint8Array; owner: Address }; baseMint: Address; quoteMint: Address };

export async function makeCross(over: Record<string, unknown> = {}): Promise<TestCross> {
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  const base = getCrossDecoder().decode(z);
  const baseMint = (await generateKeyPairSigner()).address;
  const quoteMint = (await generateKeyPairSigner()).address;
  const address = (await generateKeyPairSigner()).address;
  const fields = {
    ...base,
    state: 0,
    disclosure: Disclosure.Open,
    baseMint,
    quoteMint,
    baseBound: true,
    baseDecimals: 6,
    quoteDecimals: 6,
    baseTokenProgram: TOKEN_PROGRAM,
    quoteTokenProgram: TOKEN_PROGRAM,
    supplyMode: 0,
    openTs: 1_000n,
    closeTs: 2_000n,
    revealEndTs: 2_000n,
    minPrice: 1_000_000n,
    tick: 100_000n,
    ticks: 20,
    priceScale: 1_000_000n,
    shards: 4,
    maxOrders: 1000,
    gateMint: none(),
    ...over,
  };
  return { address, baseMint, quoteMint, account: { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getCrossEncoder().encode(fields as never)) } };
}

/** An SPL token account holding `amount` of `mint` for `owner` (only the fields the sponsor reads: the amount at byte 64). */
export function tokenAccount(owner: Address, mint: Address, amount: bigint): { data: Uint8Array; owner: Address } {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data, owner: TOKEN_PROGRAM };
}
