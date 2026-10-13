// The armed pause, end to end, on a LOCAL validator (never a shared cluster). It deploys cross_core as an upgradeable program, creates
// the protocol, unpauses it, and then plays an attack the monitor exists for: the program's upgrade authority is moved to a stranger.
//
//   1. clean passes: nothing found, nothing done
//   2. the authority moves for ONE pass and moves back: a critical finding is raised and then withdrawn, and the persistence rule
//      (3 passes in a row) holds the pause back — a flap does not pause the protocol
//   3. the authority moves and stays: the third consecutive pass pauses new crosses and orders with the guardian key; the protocol
//      account on chain reads paused = true
//   4. more passes after that: the monitor does nothing further and never unpauses
//
// The validator is started by services/monitor/scripts/local-validator.sh (Agave 1.18.26 under WSL). cross_core is deployed with the Solana CLI as a normal
// upgradeable program (a program preloaded with --upgradeable-program cannot have its authority changed on this version):
//   RPC_URL=http://127.0.0.1:18899 ADMIN_KEYPAIR=<upgrade authority and admin> PROGRAM_KEYPAIR=<cross_core program keypair> tsx scripts/local-pause-demo.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, getInitProtocolInstruction, getProtocolDecoder, getSetPausedInstruction, protocolAddress } from '@opening-cross/sdk';
import { Monitor, type Notifier, guardianPause, jsonRpc, programIntegrity, protocolAuthorities, readProgram, stuckCrosses, vaultCoversOrders, type ProgramPins } from '../src/index.js';

const URL = process.env.RPC_URL ?? 'http://127.0.0.1:18899';
if (!/127\.0\.0\.1|localhost/.test(URL)) throw new Error('this demo pauses a protocol; it runs only against a local validator');
const rpc = createSolanaRpc(URL);
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.ADMIN_KEYPAIR ?? '', 'utf8')) as number[]));
const guardian = await generateKeyPairSigner();
const strangerSeed = crypto.getRandomValues(new Uint8Array(32));
const stranger = await createKeyPairSignerFromPrivateKeyBytes(strangerSeed);
const dir = mkdtempSync(join(tmpdir(), 'oc-q3-'));
const adminFile = process.env.ADMIN_KEYPAIR!;
const strangerFile = join(dir, 'stranger.json');
// A Solana CLI keypair file is the 32-byte seed followed by the 32-byte public key.
writeFileSync(strangerFile, JSON.stringify([...strangerSeed, ...getAddressEncoder().encode(stranger.address)]));

const say = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
let failures = 0;
const expect = (label: string, ok: boolean, detail: unknown = '') => {
  say({ check: label, ok, ...(ok ? {} : { detail }) });
  if (!ok) failures += 1;
};

async function send(ixs: Instruction[], payer: KeyPairSigner) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 60; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(`${sig} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${sig} not confirmed`);
}
async function airdrop(to: KeyPairSigner, sol: number) {
  const sig = await rpc.requestAirdrop(to.address, lamports(BigInt(sol) * 1_000_000_000n)).send();
  for (let i = 0; i < 60; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('airdrop not confirmed');
}
function setAuthority(newAuthority: string, current: string) {
  const r = spawnSync('solana', ['program', 'set-upgrade-authority', CROSS_CORE_PROGRAM_ADDRESS, '--upgrade-authority', current, '--new-upgrade-authority', newAuthority, '--skip-new-upgrade-authority-signer-check', '--url', URL, '--keypair', adminFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`set-upgrade-authority failed: ${r.stderr || r.stdout}`);
}
const paused = async () => getProtocolDecoder().decode(Uint8Array.from(Buffer.from(((await rpc.getAccountInfo(await protocolAddress(), { encoding: 'base64', commitment: 'confirmed' }).send()).value!.data as unknown as [string, string])[0], 'base64'))).paused;

await airdrop(admin, 20);
if (!(await readProgram(jsonRpc(URL), CROSS_CORE_PROGRAM_ADDRESS))) {
  const so = join(process.cwd(), '..', '..', 'target', 'deploy', 'cross_core.so');
  const d = spawnSync('solana', ['program', 'deploy', so, '--program-id', process.env.PROGRAM_KEYPAIR ?? '', '--upgrade-authority', adminFile, '--keypair', adminFile, '--url', URL], { encoding: 'utf8' });
  if (d.status !== 0) throw new Error(`deploy failed: ${d.stderr || d.stdout}`);
  say({ step: 'deployed cross_core as an upgradeable program', upgradeAuthority: admin.address });
}
await airdrop(guardian, 5);
const protocol = await protocolAddress();
await send([getInitProtocolInstruction({ admin, protocol, guardian: guardian.address, feeRecipient: admin.address, feeBps: [30, 5, 15, 30] })], admin);
await send([getSetPausedInstruction({ signer: admin, protocol, paused: false })], admin);
expect('the protocol exists and is open', (await paused()) === false);

const reader = jsonRpc(URL);
const state = await readProgram(reader, CROSS_CORE_PROGRAM_ADDRESS);
expect('cross_core is an upgradeable program whose authority is the admin', state?.upgradeAuthority === admin.address, state);
const pins: ProgramPins = { [CROSS_CORE_PROGRAM_ADDRESS]: { sha256: state!.executableSha256, upgradeAuthority: admin.address } };

const events: { kind: string; body: unknown }[] = [];
const notifier: Notifier = { notify: async (e) => void events.push({ kind: e.kind, body: e.body }) };
let pauseCalls = 0;
const real = guardianPause(URL, guardian);
const monitor = new Monitor({
  rpc: reader,
  consecutive: 3,
  notifier,
  pause: { isPaused: () => real.isPaused(), pause: async () => (pauseCalls++, real.pause()) },
  checks: [vaultCoversOrders(), protocolAuthorities({ admin: admin.address, guardian: guardian.address, feeRecipient: admin.address }), programIntegrity(pins), stuckCrosses()],
});
const pass = async (label: string) => {
  const r = await monitor.pass();
  say({ pass: label, findings: r.findings.map((f) => `${f.severity}: ${f.message.slice(0, 110)}`), checkErrors: r.checkErrors, decision: r.decision?.kind ?? null });
  return r;
};

// 1. Clean.
for (let i = 1; i <= 2; i++) expect(`clean pass ${i}: no findings, no decision`, (await pass(`clean-${i}`)).findings.length === 0);

// 2. A flap: the authority moves for one pass and moves back.
setAuthority(stranger.address, adminFile);
const flap1 = await pass('flap-1');
expect('moved authority is a critical finding', flap1.findings.some((f) => f.severity === 'critical' && f.check === 'program-integrity'), flap1.findings);
expect('one critical pass does not pause', flap1.decision?.kind !== 'paused' && pauseCalls === 0, flap1.decision);
setAuthority(admin.address, strangerFile);
const flap2 = await pass('flap-restored');
expect('restored authority: finding gone', flap2.findings.length === 0, flap2.findings);
expect('the flap never paused the protocol', pauseCalls === 0 && (await paused()) === false);

// 3. The authority moves and stays.
setAuthority(stranger.address, adminFile);
const a = await pass('attack-1');
const b = await pass('attack-2');
expect('two consecutive critical passes do not pause', pauseCalls === 0 && (await paused()) === false, { a: a.decision, b: b.decision });
const c = await pass('attack-3');
expect('the third consecutive pass pauses with the guardian key', c.decision?.kind === 'paused' && pauseCalls === 1, c.decision);
expect('the protocol account on chain reads paused = true', (await paused()) === true);

// 4. Afterwards.
for (let i = 1; i <= 3; i++) await pass(`after-${i}`);
expect('later passes do not send another pause', pauseCalls === 1);
expect('the monitor never unpauses', (await paused()) === true);
say({ events: events.map((e) => `${e.kind}:${(e.body as { kind?: string; message?: string }).kind ?? (e.body as { message?: string }).message?.slice(0, 60)}`).slice(0, 12) });
process.exit(failures === 0 ? 0 : 1);
