// Kit-based helpers shared by the gate, calendar and treasury devnet proofs: sending over HTTP,
// simulated expected failures, chain time, Token-2022 mints and associated accounts, and a
// throwaway funder drawn from the devnet promiser key.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  AuthorityType,
  getTokenDecoder,
} from '@solana-program/token-2022';
import { ROOT, rpc } from './lib.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** sas-lib targets an older kit; its instructions are plain data and sign and serialise unchanged. */
export const asIx = (x: unknown) => x as Instruction;

async function buildWithBlockhash(ixs: Instruction[], payer: KeyPairSigner) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
  return { tx, blockhash: blockhash.blockhash };
}
const build = async (ixs: Instruction[], payer: KeyPairSigner) => (await buildWithBlockhash(ixs, payer)).tx;

/**
 * Sends over HTTP (public devnet WebSockets drop), re-broadcasts the same signed transaction while its blockhash
 * is valid, and polls until confirmed. Throws on a failed transaction. The public endpoint is several load-balanced
 * nodes and drops transactions under load: a blockhash a node does not know yet, or a transaction it never
 * forwards, is retried; a transaction is rebuilt only once its blockhash has expired and its signature is unseen.
 */
export async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { tx, blockhash } = await buildWithBlockhash(ixs, payer);
    const signature = getSignatureFromTransaction(tx);
    const wire = getBase64EncodedWireTransaction(tx);
    const broadcast = async () => {
      for (let i = 0; ; i++) {
        try {
          await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: i > 0 }).send();
          return;
        } catch (e) {
          if (i < 6 && /Blockhash not found/.test(`${e} ${(e as { cause?: unknown }).cause}`)) { await sleep(1_500); continue; }
          throw e;
        }
      }
    };
    await broadcast();
    for (let i = 0; ; i++) {
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      const st = value[0];
      if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
      await sleep(1_000);
      if (i % 5 === 4) {
        if (!(await rpc.isBlockhashValid(blockhash as never, { commitment: 'confirmed' }).send()).value) {
          const last = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
          if (last && !last.err) return signature;
          break; // expired and never seen: rebuild with a fresh blockhash
        }
        await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send().catch(() => undefined);
      }
    }
  }
  throw new Error('transaction not confirmed after 4 blockhash lifetimes');
}

/**
 * Runs a transaction through the cluster's simulator, which executes the real deployed program against
 * current state, and returns the program log that names the error. Fails if the transaction would succeed
 * or fails for another reason. Nothing lands on chain.
 */
export async function mustFail(ixs: Instruction[], payer: KeyPairSigner, mustContain: string): Promise<string> {
  const tx = await build(ixs, payer);
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true, sigVerify: false })
    .send();
  const logs = value.logs ?? [];
  if (!value.err) throw new Error(`expected "${mustContain}" but the simulation succeeded`);
  const hit = logs.find((l) => l.includes(mustContain));
  if (!hit) throw new Error(`failed for the wrong reason (wanted "${mustContain}"): ${JSON.stringify(value.err)}\n${logs.join('\n')}`);
  return hit.trim();
}

export async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? Math.floor(Date.now() / 1000));
}
export async function waitUntil(ts: bigint): Promise<void> {
  while ((await chainTime()) < ts) await sleep(2_000);
}

export async function exists(address: Address): Promise<boolean> {
  return (await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' })).exists;
}
export async function accountData(address: Address): Promise<Uint8Array> {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!a.exists) throw new Error(`missing account ${address}`);
  return a.data;
}

export async function ata(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}
export async function tokenBalance(token: Address): Promise<bigint> {
  const a = await fetchEncodedAccount(rpc, token, { commitment: 'confirmed' });
  return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
}
export const balanceOf = async (owner: Address, mint: Address) => tokenBalance(await ata(owner, mint));
export const ataIx = async (payer: KeyPairSigner, owner: Address, mint: Address) =>
  getCreateAssociatedTokenIdempotentInstruction({ payer, ata: await ata(owner, mint), owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

/** Creates a 6-decimals Token-2022 mint with `authority` as mint authority. */
export async function newMint(payer: KeyPairSigner, authority: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await send(
    [
      getCreateAccountInstruction({ payer, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority, freezeAuthority: null }),
    ],
    payer,
  );
  return mint.address;
}
export const mintTo = async (payer: KeyPairSigner, mint: Address, owner: Address, authority: KeyPairSigner, amount: bigint) =>
  send(
    [await ataIx(payer, owner, mint), getMintToInstruction({ mint, token: await ata(owner, mint), mintAuthority: authority, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })],
    payer,
  );
export const revokeMintAuthority = (payer: KeyPairSigner, mint: Address, current: KeyPairSigner) =>
  send([getSetAuthorityInstruction({ owned: mint, owner: current, authorityType: AuthorityType.MintTokens, newAuthority: null }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], payer);

const promiserPath = `${ROOT}.keys/devnet-promiser.json`;
export const lamportsOf = async (a: Address) => (await rpc.getBalance(a, { commitment: 'confirmed' }).send()).value;

/**
 * A fresh throwaway keypair funded from the devnet promiser key (never more than 1.5 SOL in one run),
 * so a proof never touches the operator key and leaves no shared state behind.
 */
export async function freshFunder(lamports: bigint): Promise<{ funder: KeyPairSigner; promiser: KeyPairSigner }> {
  if (lamports > 1_500_000_000n) throw new Error('funding is capped at 1.5 SOL per run');
  const promiser = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(promiserPath, 'utf8'))));
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...raw]);
  const funder = await createKeyPairSignerFromBytes(bytes);
  // Kept in the git-ignored key folder so a crashed run never strands its devnet SOL.
  writeFileSync(`${ROOT}.keys/devnet-proof-funder-${funder.address.slice(0, 6)}.json`, JSON.stringify([...bytes]));
  await send([getTransferSolInstruction({ source: promiser, destination: funder.address, amount: lamports })], promiser);
  return { funder, promiser };
}
/** Funds extra wallets from the funder. */
export const fundWallets = (funder: KeyPairSigner, to: Address[], each: bigint) =>
  send(to.map((destination) => getTransferSolInstruction({ source: funder, destination, amount: each })), funder);
/** Returns whatever is left to the promiser (best effort; leaves rent for the fee). */
export async function sweepBack(funder: KeyPairSigner, promiser: KeyPairSigner): Promise<bigint> {
  const left = await lamportsOf(funder.address);
  if (left <= 10_000n) return 0n;
  await send([getTransferSolInstruction({ source: funder, destination: promiser.address, amount: left - 5_000n })], funder);
  return left - 5_000n;
}

/** Simulates a transaction that must succeed against current devnet state (nothing lands). */
export async function mustSucceed(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const tx = await build(ixs, payer);
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true, sigVerify: false })
    .send();
  if (value.err) throw new Error(`expected the simulation to succeed: ${JSON.stringify(value.err)}\n${(value.logs ?? []).join('\n')}`);
  return `simulation succeeded (${value.unitsConsumed} compute units)`;
}
