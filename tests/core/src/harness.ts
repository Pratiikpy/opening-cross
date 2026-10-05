// LiteSVM harness for cross_core: loads the built programs, creates mints and wallets, sends
// transactions and reads token balances straight from account data.
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  getSignatureFromTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  signTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintDecoder,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  AuthorityType,
  getTokenDecoder,
} from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { existsSync } from 'node:fs';
import { address } from '@solana/kit';

export const DBC_FIXTURE = `${fileURLToPath(new URL('../../fixtures/', import.meta.url))}dynamic_bonding_curve.so`;
export const DLMM_FIXTURE = `${fileURLToPath(new URL('../../fixtures/', import.meta.url))}lb_clmm.so`;
export const DAMM_FIXTURE = `${fileURLToPath(new URL('../../fixtures/', import.meta.url))}cp_amm.so`;

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const T0 = 1_800_000_000n;

/** A transaction the harness landed, in the shape an indexer receives it from an RPC node. */
export type LandedTx = { signature: string; slot: bigint; blockTime: bigint; logs: string[]; err: null };

export class Harness {
  readonly svm: LiteSVM;
  /** Every successful transaction, in order — consumed by the indexer tests. */
  readonly landed: LandedTx[] = [];
  constructor() {
    this.svm = new LiteSVM();
    this.svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, `${ROOT}target/deploy/cross_core.so`);
    this.svm.addProgramFromFile(CROSS_GATE_PROGRAM_ADDRESS, `${ROOT}target/deploy/cross_gate.so`);
    this.svm.addProgramFromFile(CROSS_SETTLE_PROGRAM_ADDRESS, `${ROOT}target/deploy/cross_settle.so`);
    this.svm.addProgramFromFile(address('CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN'), `${ROOT}target/deploy/cross_calendar.so`);
    // Meteora DBC, dumped from mainnet by tests/fixtures/fetch.sh (not redistributed).
    if (existsSync(DBC_FIXTURE)) this.svm.addProgramFromFile(address('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'), DBC_FIXTURE);
    if (existsSync(DLMM_FIXTURE)) this.svm.addProgramFromFile(address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'), DLMM_FIXTURE);
    if (existsSync(DAMM_FIXTURE)) this.svm.addProgramFromFile(address('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'), DAMM_FIXTURE);
    this.setTime(T0);
  }

  setTime(unix: bigint): void {
    const c = this.svm.getClock();
    this.svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unix));
  }

  async wallet(sol = 10n): Promise<KeyPairSigner> {
    const w = await generateKeyPairSigner();
    this.svm.airdrop(w.address, lamports(sol * 1_000_000_000n));
    return w;
  }

  /** Sends one transaction; throws with logs on failure. Returns compute units used. */
  async send(ixs: Instruction[], payer: TransactionSigner, extraSigners: TransactionSigner[] = []): Promise<bigint> {
    void extraSigners; // signers are embedded in the instructions' account metas
    this.svm.expireBlockhash();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) {
      throw new TxError(res.meta().logs(), res.toString());
    }
    const clock = this.svm.getClock();
    this.landed.push({ signature: getSignatureFromTransaction(tx), slot: clock.slot, blockTime: clock.unixTimestamp, logs: res.logs(), err: null });
    return res.computeUnitsConsumed();
  }

  /** Signs and lands a wire transaction built elsewhere (the API), exactly as a wallet would. */
  async sendWire(base64: string, signers: KeyPairSigner[]): Promise<string> {
    const tx = await signTransaction(signers.map((k) => k.keyPair), getTransactionDecoder().decode(getBase64Encoder().encode(base64)));
    const res = this.svm.sendTransaction(tx as Parameters<LiteSVM['sendTransaction']>[0]);
    if (res instanceof FailedTransactionMetadata) throw new TxError(res.meta().logs(), res.toString());
    const clock = this.svm.getClock();
    this.landed.push({ signature: getSignatureFromTransaction(tx), slot: clock.slot, blockTime: clock.unixTimestamp, logs: res.logs(), err: null });
    return getSignatureFromTransaction(tx);
  }

  /** Sends and asserts failure; returns the logs joined for matching. */
  async fail(ixs: Instruction[], payer: TransactionSigner): Promise<string> {
    try {
      await this.send(ixs, payer);
    } catch (e) {
      if (e instanceof TxError) return e.logs.join('\n');
      throw e;
    }
    throw new Error('transaction unexpectedly succeeded');
  }

  async mint(authority: TransactionSigner, decimals = 6): Promise<Address> {
    const mint = await generateKeyPairSigner();
    const space = getMintSize();
    await this.send(
      [
        getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: this.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
        getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority.address, freezeAuthority: null }),
      ],
      authority,
    );
    return mint.address;
  }

  async ata(owner: Address, mint: Address, payer: TransactionSigner): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    await this.send([getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], payer);
    return ata;
  }

  async fund(mint: Address, authority: TransactionSigner, owner: Address, amount: bigint): Promise<Address> {
    const ata = await this.ata(owner, mint, authority);
    await this.send([getMintToInstruction({ mint, token: ata, mintAuthority: authority, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], authority);
    return ata;
  }

  async setMintAuthority(mint: Address, current: TransactionSigner, next: Address | null): Promise<void> {
    await this.send([getSetAuthorityInstruction({ owned: mint, owner: current, authorityType: AuthorityType.MintTokens, newAuthority: next }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], current);
  }

  balance(tokenAccount: Address): bigint {
    const a = this.svm.getAccount(tokenAccount);
    if (!a.exists) return 0n;
    return getTokenDecoder().decode(a.data).amount;
  }

  async balanceOf(owner: Address, mint: Address): Promise<bigint> {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    return this.balance(ata);
  }

  mintInfo(mint: Address) {
    const a = this.svm.getAccount(mint);
    if (!a.exists) throw new Error('mint missing');
    return getMintDecoder().decode(a.data);
  }

  exists(address: Address): boolean {
    return this.svm.getAccount(address).exists;
  }
}

export class TxError extends Error {
  constructor(readonly logs: string[], summary: string) {
    super(`${summary}\n${logs.join('\n')}`);
  }
}

export function salt(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Converts a web3.js v1 instruction (from a vendor SDK or Anchor client) into a kit instruction,
 *  attaching kit signers for any signer accounts. */
export function fromLegacy(
  ix: { programId: { toBase58(): string }; keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array },
  signers: Record<string, unknown> = {},
): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => {
      const a = address(k.pubkey.toBase58());
      const role = k.isSigner ? (k.isWritable ? 3 : 2) : k.isWritable ? 1 : 0;
      return signers[a] ? { address: a, role, signer: signers[a] } : { address: a, role };
    }),
    data: new Uint8Array(ix.data),
  } as Instruction;
}

