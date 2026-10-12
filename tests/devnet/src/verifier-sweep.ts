// Devnet verifier sweep (ROADMAP D5). Lists every account owned by cross_core on devnet, then runs the published
// `opening-cross-verify` command over every cross — the same way a stranger would, against a public RPC — and records
// each verdict. Crosses the verifier cannot judge are named with the reason, never skipped silently.
//
//   node --import tsx src/verifier-sweep.ts
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { type Address, type Base58EncodedBytes, fetchEncodedAccount, getBase58Decoder } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, ORDER_DISCRIMINATOR, getCrossDecoder } from '@opening-cross/cross-core-client';
import { type FairnessProof } from '@opening-cross/verifier';
import { ROOT, RPC, rpc } from './lib.js';

const run = promisify(execFile);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b58 = (b: Uint8Array) => getBase58Decoder().decode(b) as Base58EncodedBytes;
const file = 'D5-verifier-devnet-sweep.md';
const out: string[] = [];

type Verdict = {
  cross: string;
  state: string;
  size: number;
  verdict: 'VERIFIED' | 'MISMATCH' | 'NOT CLEARED' | 'UNREADABLE';
  detail: string;
  onchain?: FairnessProof['onchain'];
  recomputed?: FairnessProof['recomputed'];
  levels?: number;
};

async function main() {
  // Every account the program owns, by 8-byte discriminator.
  const all = await rpc.getProgramAccounts(CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 8 } }).send();
  const byDisc = new Map<string, number>();
  for (const a of all) byDisc.set(hex(Buffer.from(a.account.data[0], 'base64')), (byDisc.get(hex(Buffer.from(a.account.data[0], 'base64'))) ?? 0) + 1);
  const known = new Map<string, string>([[hex(CROSS_DISCRIMINATOR as Uint8Array), 'Cross'], [hex(ORDER_DISCRIMINATOR as Uint8Array), 'Order']]);

  const crossAccounts = await rpc
    .getProgramAccounts(CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'confirmed', encoding: 'base64', filters: [{ memcmp: { offset: 0n, bytes: b58(CROSS_DISCRIMINATOR as Uint8Array), encoding: 'base58' } }] })
    .send();

  const verdicts: Verdict[] = [];
  for (const acct of crossAccounts) {
    const data = Buffer.from(acct.account.data[0], 'base64');
    let state = '?';
    let decoded;
    try {
      decoded = getCrossDecoder().decode(data);
      state = CrossState[decoded.state]!;
    } catch (e) {
      verdicts.push({ cross: acct.pubkey, state, size: data.length, verdict: 'UNREADABLE', detail: `account is ${data.length} bytes and does not decode with the current Cross layout (${String(e).split('\n')[0]!.slice(0, 90)}); written by an earlier program build` });
      continue;
    }
    // The published command, exactly as documented, against the public RPC.
    let proof: FairnessProof | undefined;
    let exit = 0;
    let stderr = '';
    try {
      const r = await run(process.execPath, ['--import', 'tsx', `${ROOT}packages/verifier/src/cli.ts`, acct.pubkey, '--rpc', RPC], { cwd: `${ROOT}tests/devnet`, maxBuffer: 16 << 20 });
      proof = JSON.parse(r.stdout) as FairnessProof;
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      exit = err.code ?? 1;
      stderr = (err.stderr ?? '').split('\n').find((l) => /Error|not found/.test(l)) ?? (err.stderr ?? '').slice(0, 200);
      try {
        proof = JSON.parse(err.stdout ?? '') as FairnessProof;
      } catch {
        // no proof printed
      }
    }
    if (!proof) {
      verdicts.push({ cross: acct.pubkey, state, size: data.length, verdict: 'UNREADABLE', detail: `verifier exited ${exit}: ${stderr.trim().slice(0, 160)}` });
    } else if (proof.state === 'Live') {
      verdicts.push({ cross: acct.pubkey, state, size: data.length, verdict: 'NOT CLEARED', detail: `still Live on chain (close ${decoded.closeTs}, reveal end ${decoded.revealEndTs}); nobody has cleared it`, onchain: proof.onchain, levels: proof.book.length });
    } else {
      verdicts.push({
        cross: acct.pubkey, state, size: data.length, verdict: proof.verified && exit === 0 ? 'VERIFIED' : 'MISMATCH',
        detail: proof.notes.join(' ') || (proof.onchain.printed ? `printed at ${proof.onchain.price}, ${proof.onchain.matched} matched` : `no print (${proof.recomputed.noPrintReason})`),
        onchain: proof.onchain, recomputed: proof.recomputed, levels: proof.book.length,
      });
    }
    console.log(`${verdicts.at(-1)!.verdict} ${acct.pubkey} ${state}`);
  }

  const count = (v: Verdict['verdict']) => verdicts.filter((x) => x.verdict === v).length;
  const ok = count('MISMATCH') === 0;
  out.push(
    '# D5 — Verifier sweep over every cross_core cross on devnet', '',
    `Run: ${new Date().toISOString()} · RPC ${RPC} · program \`${CROSS_CORE_PROGRAM_ADDRESS}\``,
    'Script `tests/devnet/src/verifier-sweep.ts`; every cross is judged by spawning the published command `opening-cross-verify <cross> --rpc <url>` (packages/verifier/src/cli.ts), which reads the cross and its book from the public RPC and recomputes the clearing with the second implementation (`referenceClear`).', '',
    `Overall: **${ok ? 'NO MISMATCH' : 'MISMATCH FOUND'}** — ${crossAccounts.length} cross accounts: ${count('VERIFIED')} verified, ${count('MISMATCH')} mismatched, ${count('NOT CLEARED')} not yet cleared (nothing to verify), ${count('UNREADABLE')} unreadable.`, '',
    '## Accounts owned by the program', '',
    '| Discriminator | Kind | Accounts |', '|---|---|---|',
    ...[...byDisc].sort((a, b) => b[1] - a[1]).map(([d, n]) => `| \`${d}\` | ${known.get(d) ?? 'other program account (shard, book, protocol, …)'} | ${n} |`), '',
    `Total program accounts: ${all.length}.`, '',
    '## Crosses', '',
    '| Cross | State | Verdict | On chain | Recomputed | Book levels | Note |', '|---|---|---|---|---|---|---|',
    ...verdicts.map((v) => `| \`${v.cross}\` | ${v.state} | **${v.verdict}** | ${v.onchain ? (v.onchain.printed ? `P* ${v.onchain.price}, ${v.onchain.matched}` : 'no print') : '—'} | ${v.recomputed ? (v.recomputed.printed ? `P* ${v.recomputed.price}, ${v.recomputed.matched}` : `no print (${v.recomputed.noPrintReason})`) : '—'} | ${v.levels ?? '—'} | ${v.detail.replace(/\|/g, '/')} |`), '',
  );
  writeFileSync(`${ROOT}docs/evidence/${file}`, out.join('\n'));
  appendFileSync('/tmp/dn-sweep.out', JSON.stringify(verdicts.map((v) => [v.cross, v.verdict])) + '\n');
  console.log(`written docs/evidence/${file}: ${count('VERIFIED')} verified, ${count('MISMATCH')} mismatch, ${count('NOT CLEARED')} not cleared, ${count('UNREADABLE')} unreadable`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
