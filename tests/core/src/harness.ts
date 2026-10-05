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

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const T0 = 1_800_000_000n;

export class Harness {
  readonly svm: LiteSVM;
  constructor() {
    this.svm = new LiteSVM();
    this.svm.addProgramFromFile(CROSS_CORE_PROGRAM_ADDRESS, `${ROOT}target/deploy/cross_core.so`);
    this.svm.addProgramFromFile(CROSS_GATE_PROGRAM_ADDRESS, `${ROOT}target/deploy/cross_gate.so`);
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
    return res.computeUnitsConsumed();
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

