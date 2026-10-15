// Checks the Jito evidence against the live network, read-only:
//   1. the eight derived tip accounts equal the block engine's `getTipAccounts`, and each account on chain is owned by the tip-payment program;
//   2. for recent bundles from the explorer, every transaction resolves back to its own bundle through `bundleOf`, `tipIn` finds the tip the explorer reports, and the
//      transactions that share a bundle are counted by how many distinct signers they have (the case that links two bidders).
//
//   pnpm exec tsx scripts/jito-live.ts [bundles=25] [endpoint ...]
import { FailoverRpc } from '../../reliability/src/index.js';
import { EXPLORER_BASE, JITO_TIP_PAYMENT_PROGRAM, bundleInfo, bundleOf, jitoTipAccounts, pacedRpc, tipIn, type ParsedTransaction } from '../src/index.js';

const [countArg, ...endpoints] = process.argv.slice(2);
const sample = Number(countArg ?? 25);
const rpc = pacedRpc(new FailoverRpc(endpoints.length ? endpoints : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], { rounds: 4 }), { minIntervalMs: 400 });
const engine = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failures.push(what);
};

const derived = [...(await jitoTipAccounts())];
const res = await fetch(engine, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }) });
const published = ((await res.json()) as { result: string[] }).result;
check(derived.length === 8 && [...derived].sort().join() === [...published].sort().join(), `derived tip accounts equal the block engine's list (${published.length} published)`);
for (const a of derived) {
  const info = await rpc.call<{ value: { owner: string } | null }>('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }]);
  check(info.value?.owner === JITO_TIP_PAYMENT_PROGRAM, `${a} is owned by the tip-payment program`);
}

const tips = new Set<string>(derived);
const recent = (await (await fetch(`${EXPLORER_BASE}/api/v1/bundles/recent?limit=200&sort=Time&asc=false`)).json()) as { bundleId: string; transactions: string[]; tippers: string[]; landedTipLamports: number }[];
const multi = recent.filter((b) => b.transactions.length > 1).slice(0, sample);
console.log(`explorer returned ${recent.length} recent bundles; ${recent.filter((b) => b.transactions.length > 1).length} have more than one transaction; checking ${multi.length}`);
let signerSets = 0;
let multiSigner = 0;
let withNonTipperSigner = 0;
let withTwoNonTipperSigners = 0;
let tipFound = 0;
let tipFromListedTipper = 0;
for (const b of multi) {
  const info = await bundleInfo(b.bundleId);
  check(info !== null && info.signatures.join() === b.transactions.join(), `bundle ${b.bundleId.slice(0, 8)} detail matches the list`);
  const signers = new Set<string>();
  let tipHere = false;
  let tipperPaid = false;
  for (const sig of b.transactions) {
    const back = await bundleOf(sig, Math.floor(Date.now() / 1000) - 60);
    check(back.status === 'bundled' && back.bundleId === b.bundleId, `  ${sig.slice(0, 8)} resolves to its bundle`);
    const tx = await rpc.call<(ParsedTransaction & { transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } } }) | null>('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (!tx) continue;
    const payer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
    if (payer) signers.add(payer);
    const t = tipIn(tx, tips);
    if (t) {
      tipHere = true;
      if (b.tippers.includes(t.from)) tipperPaid = true;
    }
  }
  signerSets += 1;
  if (signers.size > 1) multiSigner += 1;
  const nonTippers = [...signers].filter((x) => !b.tippers.includes(x));
  if (nonTippers.length >= 1) withNonTipperSigner += 1;
  if (nonTippers.length >= 2) withTwoNonTipperSigners += 1;
  if (tipperPaid) tipFromListedTipper += 1;
  if (tipHere) tipFound += 1;
  else console.log('NO TIP FOUND', b.bundleId, JSON.stringify({ tippers: b.tippers, landedTipLamports: b.landedTipLamports, signers: [...signers], transactions: b.transactions }));
}
console.log(JSON.stringify({ bundlesChecked: signerSets, withMoreThanOneSigner: multiSigner, withASignerWhoDidNotPayTheTip: withNonTipperSigner, withTwoSignersWhoDidNotPayTheTip: withTwoNonTipperSigners, tipFoundByTipIn: tipFound, tipPaidByTheListedTipper: tipFromListedTipper }));
check(tipFound === signerSets, 'tipIn found a tip to a derived tip account in every checked bundle');
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
