// Helpers for tests that run against a real validator: fund accounts, make a mint and token accounts, send transactions
// and read balances. Nothing here is mocked; the RPC endpoint is a solana-test-validator.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { fetchMaybeToken, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintSize, getMintToInstruction } from '@solana-program/token-2022';
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../src/constants.js';
import type { SvmRpc } from '../src/network.js';

export const RPC_URL = process.env.X402_TEST_RPC ?? 'http://127.0.0.1:8940';
export const rpc = createSolanaRpc(RPC_URL) as unknown as SvmRpc;

export async function chainUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), signal: AbortSignal.timeout(2000) });
    return ((await res.json()) as { result?: string }).result === 'ok';
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function airdrop(to: Address, sol: number): Promise<void> {
  const before = (await rpc.getBalance(to, { commitment: 'confirmed' }).send()).value;
  await rpc.requestAirdrop(to, lamports(BigInt(Math.round(sol * 1e9)))).send();
  for (let i = 0; i < 60; i++) {
    if ((await rpc.getBalance(to, { commitment: 'confirmed' }).send()).value > before) return;
    await sleep(250);
  }
  throw new Error('the airdrop did not arrive');
}

export async function send(payer: KeyPairSigner, ixs: Instruction[], extraSigners: KeyPairSigner[] = []): Promise<string> {
  void extraSigners;
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(tx);
  await sendTransactionWithoutConfirmingFactory({ rpc: rpc as never })(tx as never, { commitment: 'confirmed', skipPreflight: false });
  for (let i = 0; i < 120; i++) {
    const s = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (s?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    await sleep(250);
  }
  throw new Error(`transaction ${sig} was not confirmed`);
}

export async function createMint(payer: KeyPairSigner, authority: Address, decimals: number, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<KeyPairSigner> {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: tokenProgram }),
    getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority, freezeAuthority: null }, { programAddress: tokenProgram }),
  ]);
  return mint;
}

export async function ata(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
}

/** Creates the owner's associated token account if needed, paid for by `payer`. */
export async function createAta(payer: KeyPairSigner, owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<Address> {
  const address = await ata(owner, mint, tokenProgram);
  await send(payer, [getCreateAssociatedTokenIdempotentInstruction({ payer, ata: address, owner, mint, tokenProgram })]);
  return address;
}

export async function mintTo(payer: KeyPairSigner, mintAuthority: KeyPairSigner, mint: Address, owner: Address, amount: bigint, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<void> {
  const token = await createAta(payer, owner, mint, tokenProgram);
  await send(payer, [getMintToInstruction({ mint, token, mintAuthority, amount }, { programAddress: tokenProgram })]);
}

export async function tokenBalance(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<bigint> {
  const t = await fetchMaybeToken(rpc as never, await ata(owner, mint, tokenProgram), { commitment: 'confirmed' });
  return t.exists ? t.data.amount : 0n;
}

export const lamportBalance = async (a: Address): Promise<bigint> => (await rpc.getBalance(a, { commitment: 'confirmed' }).send()).value;

export { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
