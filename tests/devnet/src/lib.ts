// Shared helpers for the devnet proofs: connection, signing key, kit↔web3 instruction bridge,
// expected-failure assertions and evidence files.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { type Address, type Instruction, AccountRole, address, createSolanaRpc } from '@solana/kit';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
export const connection = new Connection(RPC, 'confirmed');
export const rpc = createSolanaRpc(RPC);

/** The devnet operations key (git-ignored, see docs/HUMAN_TASKS.md for funding). */
export const operator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))),
);

/** Converts a @solana/kit instruction into a web3.js v1 instruction. */
export function toLegacy(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

export const kitAddr = (k: PublicKey): Address => address(k.toBase58());

export async function send(tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer ??= signers[0]!.publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

/** Sends a transaction that must fail and returns the log line proving why. */
export async function expectFailure(tx: Transaction, signers: Keypair[], mustContain: string): Promise<string> {
  let landed: string | undefined;
  try {
    landed = await send(tx, signers);
  } catch (e) {
    const logs = e instanceof SendTransactionError ? ((await e.getLogs(connection)) ?? []) : [];
    const text = `${String(e)}\n${logs.join('\n')}`;
    if (!text.includes(mustContain)) throw new Error(`failed for the wrong reason (wanted "${mustContain}"):\n${text}`);
    return logs.find((l) => l.includes(mustContain)) ?? text.split('\n').find((l) => l.includes(mustContain)) ?? mustContain;
  }
  throw new Error(`expected failure but landed: ${landed}`);
}

export type Step = { id: string; claim: string; result: 'PASS' | 'FAIL'; signature?: string; detail: string };

export class Evidence {
  readonly steps: Step[] = [];
  constructor(
    private readonly file: string,
    private readonly title: string,
    private readonly header: string[],
  ) {}

  record(s: Step): void {
    this.steps.push(s);
    console.log(`${s.result} ${s.id}: ${s.claim}${s.signature ? ` (${s.signature})` : ''} — ${s.detail}`);
  }

  check(id: string, claim: string, ok: boolean, detail: string, signature?: string): void {
    this.record({ id, claim, result: ok ? 'PASS' : 'FAIL', detail, ...(signature ? { signature } : {}) });
  }

  write(error?: unknown): void {
    const ok = !error && this.steps.every((s) => s.result === 'PASS');
    const lines = [
      `# ${this.title}`,
      '',
      `Run: ${new Date().toISOString()} · RPC ${RPC}`,
      ...this.header,
      '',
      `Overall: **${ok ? 'PASS' : 'FAIL'}**`,
      '',
      '| Step | Claim | Result | Transaction | Detail |',
      '|---|---|---|---|---|',
      ...this.steps.map(
        (s) =>
          `| ${s.id} | ${s.claim} | ${s.result} | ${s.signature ? `[${s.signature.slice(0, 8)}…](https://explorer.solana.com/tx/${s.signature}?cluster=devnet)` : '—'} | ${s.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
      ),
      ...(error ? ['', '## Error', '', '```', String(error instanceof Error ? error.stack : error), '```'] : []),
      '',
    ];
    writeFileSync(`${ROOT}docs/evidence/${this.file}`, lines.join('\n'));
    console.log(`evidence written to docs/evidence/${this.file} (${ok ? 'PASS' : 'FAIL'})`);
    if (!ok) process.exitCode = 1;
  }
}
