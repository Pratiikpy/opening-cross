// Trust layer on devnet: the promiser signs a band for a real devnet cross while its call is open, grades it after the
// keepers settle it, and anchors the signed promise in a Memo transaction; the indexer's view equals the chain.
// Run after keeper-chaos.ts (it reads /tmp/dn-d2-state.json) with the stack from run-stack.sh up.
//
//   node --import tsx src/trust-devnet.ts
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { type Address, type Base58EncodedBytes, fetchEncodedAccount, getBase58Decoder } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder } from '@opening-cross/cross-core-client';
import { createHash } from 'node:crypto';

// An independent re-implementation of the anchor check: leaves are sha256(0x00 || id), inner nodes sha256(0x01 || left || right).
const sha = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
function verifyProof(id: string, proof: { hash: string; side: 'L' | 'R' }[], root: string): boolean {
  let h = sha(Buffer.from([0]), Buffer.from(id, 'hex'));
  for (const step of proof) h = step.side === 'L' ? sha(Buffer.from([1]), Buffer.from(step.hash, 'hex'), h) : sha(Buffer.from([1]), h, Buffer.from(step.hash, 'hex'));
  return h.toString('hex') === root;
}
const parseMemo = (t: string) => { const m = /^opening-cross\/promises\/v1 root=([0-9a-f]{64}) n=(\d+)$/.exec(t); return m ? { root: m[1]!, count: Number(m[2]) } : null; };
import { Evidence, ROOT, RPC, rpc } from './lib.js';

const run = promisify(execFile);
const API = process.env.API_URL ?? 'http://localhost:8080';
const ev = new Evidence('T-trust-devnet.md', 'Trust layer on devnet — signed band, grade, anchor, indexer drift', [
  'Script `tests/devnet/src/trust-devnet.ts` over the stack from `tests/devnet/run-stack.sh` (indexer, API, promiser on devnet) and the launch cross created by `keeper-chaos.ts`',
  `API ${API} (NETWORK=devnet), RPC ${RPC}`,
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async (path: string) => {
  const r = await fetch(API + path);
  return { status: r.status, body: (await r.json()) as any };
};
async function poll<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(8_000);
  }
}
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, ['--import', 'tsx', `${ROOT}packages/promises/src/cli.ts`, ...args], { cwd: `${ROOT}packages/promises`, maxBuffer: 8 << 20 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

async function main() {
  const state = JSON.parse(readFileSync('/tmp/dn-d2-state.json', 'utf8')) as { crosses: { name: string; address: string }[] };
  const L = state.crosses.find((c) => c.name === 'launch')!.address as Address;
  const readCross = async () => {
    const a = await fetchEncodedAccount(rpc, L, { commitment: 'confirmed' });
    if (!a.exists) throw new Error('launch cross missing');
    return getCrossDecoder().decode(a.data);
  };
  const cross = await readCross();

  const signer = (await j('/v1/promises/signer')).body.signer as string;
  const cp = await j(`/v1/crosses/${L}/promise`);
  const promise = cp.body.promise;
  const id: string = promise.id;
  ev.check('band-issued', 'the promiser signed a band for the open-book launch (served by the API under the published signer)', cp.status === 200 && Boolean(id) && cp.body.signer === signer, `promise ${id.slice(0, 16)}…, signer ${signer}, point tick ${promise.claim.pointTick}, status ${promise.claim.status}`);
  ev.check('band-before-close', 'the band was signed while the call was open (issuedAt before the chain close time)', BigInt(promise.issuedAt) < cross.closeTs, `issuedAt ${promise.issuedAt}, closeTs ${cross.closeTs}`);

  const v1 = await cli([`${API}/v1/promises/${id}`, '--signer', signer, '--inputs', `${API}/v1/promises/${id}/inputs`]);
  ev.check('stranger-verify', 'a stranger following the published instruction: the id and signature check out for the published signer, the published book hashes to inputsHash, the recomputed point equals the promised tick', v1.code === 0, v1.out.trim().split('\n').slice(0, 5).join(' / ').slice(0, 300));

  // Settled by the keepers (keeper-chaos.ts); the promiser grades against the cross account.
  const graded = await poll('the promiser to grade the band', async () => {
    const g = (await j(`/v1/promises/${id}`)).body;
    return g.grade ? g : null;
  }, 15 * 60_000);
  const cleared = await readCross();
  const price = cleared.clearing.__option === 'Some' ? cleared.clearing.value.price : null;
  const clearedTick = price === null ? null : Number((price - cleared.minPrice) / cleared.tick);
  ev.check('graded', 'the promiser graded the band against the cleared cross account', graded.grade.status === 'SCORED' && graded.grade.clearedTick === clearedTick, `${JSON.stringify(graded.grade)} · chain: P* ${price}, tick ${clearedTick}`);

  const v2 = await cli([`${API}/v1/promises/${id}`, '--signer', signer, '--inputs', `${API}/v1/promises/${id}/inputs`, '--rpc', RPC]);
  ev.check('stranger-grade', 'the same published command with --rpc reads the outcome from the cross account on chain and reports the grade', v2.code === 0 && /GRADE SCORED/.test(v2.out), v2.out.split('\n').filter((l) => /GRADE|error|cleared/i.test(l)).join(' / ').slice(0, 300));

  const accuracy = (await j('/v1/accuracy')).body;
  ev.check('track-record', 'the public track record counts the graded promise', accuracy.totals.graded >= 1, JSON.stringify(accuracy.totals));

  // Anchoring: the promiser folds unanchored ids into a Merkle root and writes it to a Memo transaction.
  const anchored = await poll('the promiser to anchor the promise', async () => {
    const g = (await j(`/v1/promises/${id}`)).body;
    return g.anchor ?? null;
  }, 10 * 60_000);
  const included = verifyProof(id, anchored.proof, anchored.root);
  ev.check('anchor-inclusion', 'the Merkle inclusion proof for the promise verifies against the anchored root', included, `root ${anchored.root.slice(0, 16)}…, ${anchored.count} promise(s) in the anchor`);
  const tx = await rpc.getTransaction(anchored.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
  const memoLog = (tx?.meta?.logMessages ?? []).find((l) => l.includes('Memo'));
  const memoText = (tx?.meta?.logMessages ?? []).map((l) => /Memo \(len \d+\): "(.*)"/.exec(l)?.[1]).find(Boolean);
  const digest = memoText ? parseMemo(memoText) : null;
  const payer = tx?.transaction.message.accountKeys[0];
  ev.check('anchor-on-chain', 'the Memo transaction on devnet carries exactly that root, was paid by the promiser, and its chain time bounds the promise from above', digest?.root === anchored.root && payer === signer && tx?.blockTime != null && BigInt(tx.blockTime) >= BigInt(promise.issuedAt), `tx ${anchored.signature.slice(0, 12)}…, memo "${memoText}", fee payer ${payer}, blockTime ${tx?.blockTime}, issuedAt ${promise.issuedAt}${memoLog ? '' : ' (no Memo log line)'}`, anchored.signature);

  // Indexer at zero drift: the index equals the chain at finalized commitment, and the API says so.
  const rec = await run(process.execPath, ['--import', 'tsx', 'src/reconcile-cli.ts'], { cwd: `${ROOT}services/indexer`, env: { ...process.env, RPC_URL: RPC, DATABASE_URL: process.env.DATABASE_URL!, ATTEMPTS: '6', WAIT_MS: '12000' }, maxBuffer: 8 << 20 }).then((r) => ({ code: 0, out: r.stdout }), (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
  const parsed = (() => { try { return JSON.parse(rec.out) as { crossesCompared: number; driftCount: number; drift: unknown[] }; } catch { return null; } })();
  ev.check('indexer-drift', 'the one-shot reconciler compares every indexed cross, order and counter with finalized chain state and finds zero drift', rec.code === 0 && parsed?.driftCount === 0, parsed ? `${parsed.crossesCompared} crosses compared, drift ${parsed.driftCount}${parsed.driftCount ? ` ${JSON.stringify(parsed.drift).slice(0, 300)}` : ''}` : rec.out.slice(0, 300));
  const health = await j('/v1/health');
  ev.check('api-health', 'the API health check reports no drift alerts in the last hour', health.body.ok === true && health.body.recentDriftAlerts === 0, JSON.stringify(health.body));
  const stats = await j('/v1/stats');
  const onchain = await rpc.getProgramAccounts(CROSS_CORE_PROGRAM_ADDRESS, { commitment: 'finalized', encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(CROSS_DISCRIMINATOR as Uint8Array) as Base58EncodedBytes, encoding: 'base58' } }] }).send();
  ev.check('indexer-complete', 'every cross account owned by cross_core on devnet has a row in the index', onchain.length === stats.body.crosses_total, `chain ${onchain.length} cross accounts, indexed ${stats.body.crosses_total}, printed ${stats.body.crosses_printed}`);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
