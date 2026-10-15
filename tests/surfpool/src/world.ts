// The shared fixture: the operator key, the programs deployed at their real addresses, a funded wallet per person, and Token-2022
// mints. Everything is created on the surfnet the tests talk to; nothing here touches a real cluster.
import { createHash } from 'node:crypto';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  createKeyPairSignerFromPrivateKeyBytes,
  fetchEncodedAccount,
  generateKeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  getTokenDecoder,
} from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS, getInitProtocolInstruction, protocolAddress } from '@opening-cross/sdk';
import { airdrop, deployProgram, rpc, send, surfnetUp } from './surfnet.js';

/** A throwaway key for the local surfnet: the same on every run, so the protocol account a previous run created still has its admin. */
export async function testKey(label: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(createHash('sha256').update(`opening-cross surfpool tests: ${label}`).digest()));
}

export const FEES: [number, number, number, number] = [30, 5, 15, 30];
export const SCALE = 1_000_000n;
export const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

export interface World {
  operator: KeyPairSigner;
  protocol: Address;
}

let ready: Promise<World> | null = null;

/** Brings up what every test needs, once per file: the surfnet answers, cross_core is deployed, the protocol account exists. */
export function world(): Promise<World> {
  ready ??= (async () => {
    if (!(await surfnetUp())) throw new Error('no Surfpool surfnet answers at SURFPOOL_URL (default http://127.0.0.1:18899); start one with `pnpm --filter @opening-cross/surfpool-tests surfnet`');
    const operator = await testKey('operator');
    await airdrop(operator.address, 1_000);
    const core = await fetchEncodedAccount(rpc, CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'confirmed' });
    // The binary is written fresh on each run, so the surfnet runs the build in target/deploy and not whatever an earlier run left.
    await deployProgram(CROSS_CORE_PROGRAM_ADDRESS, 'cross_core');
    void core;
    const protocol = await protocolAddress();
    if (!(await fetchEncodedAccount(rpc, protocol, { commitment: 'confirmed' })).exists) {
      await send([getInitProtocolInstruction({ admin: operator, protocol, guardian: operator.address, feeRecipient: operator.address, feeBps: FEES })], operator);
    }
    return { operator, protocol };
  })();
  return ready;
}

export async function ata(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}

export async function balanceOf(owner: Address, mint: Address): Promise<bigint> {
  const a = await fetchEncodedAccount(rpc, await ata(owner, mint), { commitment: 'confirmed' });
  return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
}

export async function newMint(payer: KeyPairSigner, authority: Address, decimals = 6): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await send([getCreateAccountInstruction({ payer, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority, freezeAuthority: null })], payer);
  return mint.address;
}

/** A funded wallet that holds `quote` (and optionally `base`) tokens. */
export async function person(operator: KeyPairSigner, o: { quote?: { mint: Address; amount: bigint }; base?: { mint: Address; amount: bigint }; sol?: bigint } = {}): Promise<KeyPairSigner> {
  const who = await generateKeyPairSigner();
  const ixs: Instruction[] = [getTransferSolInstruction({ source: operator, destination: who.address, amount: o.sol ?? 50_000_000n })];
  for (const t of [o.quote, o.base]) {
    if (!t) continue;
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(who.address, t.mint), owner: who.address, mint: t.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
    ixs.push(getMintToInstruction({ mint: t.mint, token: await ata(who.address, t.mint), mintAuthority: operator, amount: t.amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  await send(ixs, operator);
  return who;
}

export { AuthorityType, TOKEN_2022_PROGRAM_ADDRESS, getSetAuthorityInstruction, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction };
