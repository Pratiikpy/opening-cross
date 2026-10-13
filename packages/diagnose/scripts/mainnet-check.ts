// Checks the diagnosis against real failures on mainnet. For each failed transaction of a program, the tool's answer is
// compared with what the program itself logged ("Error Code: X. Error Number: N"): the program is the ground truth, so
// any disagreement is a stale table or a bug here. Read-only.
//
//   pnpm exec tsx scripts/mainnet-check.ts <programId> [count] [endpoint ...]
import { diagnose } from '../src/index.js';

const [programId, countArg, ...endpoints] = process.argv.slice(2);
if (!programId) throw new Error('usage: mainnet-check.ts <programId> [count] [endpoint ...]');
const want = Number(countArg ?? 60);
const urls = endpoints.length ? endpoints : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = urls[attempt % urls.length]!;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (res.status === 200 && j.result !== undefined) return j.result;
    } catch {
      // try the next endpoint
    }
    await sleep(400 + attempt * 300);
  }
  throw new Error(`${method} could not be answered by any endpoint`);
}

interface Sig { signature: string; err: unknown; slot: number }
const failed: Sig[] = [];
let before: string | undefined;
let scanned = 0;
const maxFetch = want * 8;
while (failed.length < maxFetch && scanned < 12000) {
  const page = await rpc<Sig[]>('getSignaturesForAddress', [programId, { limit: 1000, ...(before ? { before } : {}) }]);
  if (page.length === 0) break;
  scanned += page.length;
  before = page[page.length - 1]!.signature;
  failed.push(...page.filter((s) => s.err));
}
console.log(`scanned ${scanned} recent transactions of ${programId}: ${failed.length} failed (${((100 * failed.length) / scanned).toFixed(1)}%)`);

const tally = new Map<string, number>();
const disagreements: unknown[] = [];
let checked = 0;
let withProgramLog = 0;
let ownFailures = 0;
let agree = 0;
let unmapped = 0;
const examples: Record<string, string> = {};
// Keep going until `want` failures inside the program itself have been seen, or the fetch budget is spent.
for (const s of failed) {
  if (ownFailures >= want || checked >= maxFetch) break;
  const tx = await rpc<{ meta: { err: unknown; logMessages: string[] }; transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number }[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  if (!tx?.meta) continue;
  checked += 1;
  const keys = tx.transaction.message.accountKeys;
  const d = diagnose({ err: tx.meta.err, logs: tx.meta.logMessages, instructionPrograms: tx.transaction.message.instructions.map((i) => keys[i.programIdIndex] ?? '') });
  const key = `${d.where.program?.name ?? '?'} / ${d.error.name ?? JSON.stringify(tx.meta.err).slice(0, 60)} [${d.category}]`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
  examples[key] ??= d.summary;
  if (d.where.program?.address === programId) ownFailures += 1;
  if (d.programLog && d.where.program?.address === programId) {
    withProgramLog += 1;
    if (d.tableAgreesWithProgram === true) agree += 1;
    else if (d.tableAgreesWithProgram === false) disagreements.push({ signature: s.signature, table: d.error, programLog: d.programLog });
    else unmapped += 1;
  }
  await sleep(150);
}
console.log(`diagnosed ${checked}; ${ownFailures} failed inside ${programId} itself (the rest failed in other programs that appear in the same transaction); in those, the program logged its own error name in ${withProgramLog}; the table agreed in ${agree}, disagreed in ${disagreements.length}, had no entry in ${unmapped}`);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k, '\n      ', examples[k]);
if (disagreements.length) console.log('DISAGREEMENTS', JSON.stringify(disagreements, null, 1));
process.exit(disagreements.length === 0 ? 0 : 1);
