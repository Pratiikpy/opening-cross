// A mint-mode launch cross on devnet, shared by the gate and calendar proofs: the cross PDA takes the base
// mint authority and the issuer offers a fixed schedule of tokens; callers choose the gate, calendar and close.
import { type Address, type KeyPairSigner, fetchEncodedAccount } from '@solana/kit';
import { AuthorityType, TOKEN_2022_PROGRAM_ADDRESS, getSetAuthorityInstruction } from '@solana-program/token-2022';
import { CrossKind, Disclosure, SupplyMode, buildCreateCross, crossAddress, getCrossDecoder, getProtocolDecoder, protocolAddress } from '@opening-cross/sdk';
import { rpc } from './lib.js';
import { ataIx, chainTime, newMint, send } from './kit.js';

export const SCALE = 1_000_000n;
export const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

export async function crossView(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!a.exists) throw new Error(`missing cross ${address}`);
  return { address, data: getCrossDecoder().decode(a.data) };
}

export type LaunchOptions = {
  issuer: KeyPairSigner;
  quoteMint: Address;
  /** Seconds from now to the close, or an absolute close timestamp. */
  closeTs: bigint;
  gateMint?: Address | null;
  calendar?: Address | null;
  oracle?: { feedId: Uint8Array; maxDivergenceBps: number; maxStalenessSecs: number } | null;
};

/** Prepares the launch (base mint with the cross PDA as authority) and returns the unsent create instructions. */
export async function prepareLaunch(o: LaunchOptions) {
  const crossId = BigInt(Date.now());
  const cross = await crossAddress(o.issuer.address, crossId);
  const baseMint = await newMint(o.issuer, o.issuer.address);
  await send(
    [getSetAuthorityInstruction({ owned: baseMint, owner: o.issuer, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }), await ataIx(o.issuer, o.issuer.address, baseMint)],
    o.issuer,
  );
  const now = await chainTime();
  const built = await buildCreateCross({
    creator: o.issuer, baseMint, quoteMint: o.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs: o.closeTs, revealEndTs: o.closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: o.issuer.address, gateMint: o.gateMint ?? null,
    shards: 1, maxOrders: 8, proceedsTo: o.issuer.address, schedule: [{ price: 1_000_000n, quantity: 1_000_000_000n }], settler: null, settleDeadlineTs: 0n,
    oracle: o.oracle ?? null, calendar: o.calendar ?? null,
  });
  return { cross, baseMint, built };
}

/** Finalize pays the protocol fee to the fee recipient's quote account, which must exist for this quote mint. */
export async function ensureFeeRecipientAccount(payer: KeyPairSigner, quoteMint: Address): Promise<void> {
  const protocol = await fetchEncodedAccount(rpc, await protocolAddress(), { commitment: 'confirmed' });
  if (!protocol.exists) throw new Error('cross_core protocol singleton missing on devnet; run dp:core first');
  await send([await ataIx(payer, getProtocolDecoder().decode(protocol.data).feeRecipient, quoteMint)], payer);
}
