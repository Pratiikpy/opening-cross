#!/usr/bin/env node
// opening-cross-adapter <reopen|halt-resume|tender|block-sale> [options]
//
// Every adapter plans from live state, prints what it would do and why, and then either simulates the transactions on the cluster
// (--shadow, the default: nothing is sent) or signs and sends them (--send, needs --keypair). The key is read, used in memory and
// forgotten. Addresses of mints are given; token programs and decimals are read from the chain.
//
//   common      --api <url> --rpc <url> --base <mint> --quote <mint> [--creator <address>] [--keypair <file>] [--shadow | --send]
//   reopen      --session-in <seconds> [--reference <quote tokens per base token>] [--sealed] [--half-band-bps 1000]
//   halt-resume --was-halted [--reference <price>]
//   tender      --holders <json file of addresses> --floor <price> --ceiling <price> --quantity <base tokens> --ack-not-legal-advice [--gate-mint <mint>]
//   block-sale  --seller <address> --amount <base tokens> --reserve <price> [--squads]
import { readFileSync } from 'node:fs';
import { type CreateCrossRequest, apiTxBuilder, createApiClient, createRpcClient, formatPrice, localTxBuilder, parseAtoms, parsePrice } from '@opening-cross/client';
import { loadKeypairSigner } from '@opening-cross/client/node';
import { type Plan, type Skip, run } from './common.js';
import { planBlockSale } from './block-sale.js';
import { planHaltResume } from './halt-resume.js';
import { lastPrint, readMint, safetyRisks } from './live.js';
import { planReopen } from './reopen.js';
import { planTender } from './tender.js';

// A refused plan is an answer, not a crash: say it in one line and exit non-zero.
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (n: string): string => opt(n) ?? usage(`--${n} is required`);
function usage(msg: string): never {
  console.error(`${msg}\nusage: opening-cross-adapter <reopen|halt-resume|tender|block-sale> --api <url> --rpc <url> --base <mint> --quote <mint> ... (see the header of src/cli.ts)`);
  process.exit(2);
}
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

if (!cmd || !['reopen', 'halt-resume', 'tender', 'block-sale'].includes(cmd)) usage('say which adapter to run');
const api = need('api').replace(/\/$/, '');
const rpc = createRpcClient({ url: need('rpc') });
const baseMint = need('base');
const quoteMint = need('quote');
const [base, quote] = await Promise.all([readMint(rpc, baseMint), readMint(rpc, quoteMint)]);
const keypair = opt('keypair') ? await loadKeypairSigner(opt('keypair')!) : null;
const creator = opt('creator') ?? opt('seller') ?? keypair?.address ?? usage('--creator, --seller or --keypair is required');
const now = await rpc.unixTime();
const market = { priceScale: 10n ** BigInt(base.decimals), baseDecimals: base.decimals, quoteDecimals: quote.decimals };
const price = (t: string, what: string): bigint => parsePrice(t, market) ?? usage(`${what} "${t}" is not a price this token pair can represent exactly`);
const tokens = (t: string, what: string): bigint => parseAtoms(t, base.decimals) ?? usage(`${what} "${t}" is not an amount of tokens with at most ${base.decimals} decimals`);
const common = { baseMint, quoteMint, baseProgram: base.program, quoteProgram: quote.program, baseDecimals: base.decimals, now };

let plan: (Plan & { sellOrder?: unknown; gate?: unknown }) | Skip;
if (cmd === 'reopen' || cmd === 'halt-resume') {
  const reference = opt('reference') ? price(opt('reference')!, 'the reference') : await lastPrint(api, baseMint, quoteMint, base.decimals);
  if (cmd === 'reopen') {
    if (reference === null) usage('the pair has never printed; give --reference');
    plan = planReopen({ ...common, creator, referencePrice: reference, sessionOpenTs: now + BigInt(Number(need('session-in'))), disclosure: flag('sealed') ? 'sealed' : 'open', ...(opt('half-band-bps') ? { halfBandBps: Number(opt('half-band-bps')) } : {}) });
  } else {
    plan = planHaltResume({ ...common, creator, risks: await safetyRisks(api, baseMint), wasHalted: flag('was-halted'), lastPrint: reference });
  }
} else if (cmd === 'tender') {
  const holders = JSON.parse(readFileSync(need('holders'), 'utf8')) as string[];
  plan = planTender({ ...common, issuer: creator, holders, floorPrice: price(need('floor'), 'the floor'), ceilingPrice: price(need('ceiling'), 'the ceiling'), quantity: tokens(need('quantity'), 'the quantity'), acknowledgeNotLegalAdvice: flag('ack-not-legal-advice'), ...(opt('gate-mint') ? { gateMint: opt('gate-mint')! } : {}), ...(opt('window-secs') ? { windowSecs: Number(opt('window-secs')), minWindowSecs: 60 } : {}) });
} else {
  plan = planBlockSale({ ...common, seller: creator, amount: tokens(need('amount'), 'the amount'), reservePrice: price(need('reserve'), 'the reserve') });
}

if ('action' in plan) {
  console.log(`Nothing to do: ${plan.reason}`);
  process.exit(0);
}
console.log(plan.explanation.join('\n'));
for (const w of plan.warnings) console.log(`Note: ${w}`);
const r: CreateCrossRequest = plan.request;
console.log(`\nGrid ${formatPrice(r.minPrice, market)} to ${formatPrice(r.minPrice + BigInt(r.ticks - 1) * r.tick, market)} per token; closes ${r.closeTs}.`);
if (plan.gate) console.log(`Gate prerequisite: ${json(plan.gate)}`);

const builder = flag('local') ? localTxBuilder(rpc) : apiTxBuilder(createApiClient({ baseUrl: api }));
const built = await builder.createCross(r);
console.log(`Cross address ${String(built.extra.cross ?? 'see the transactions')}; ${built.transactions.length} transactions.`);
if (flag('squads')) {
  console.log('\nFor the multisig, the create transaction (base64, unsigned; the vault is its only signer):');
  console.log(built.transactions[0]!.transaction);
  if (plan.sellOrder) console.log(`\nThen, once the cross exists, place the sell order: ${json(plan.sellOrder)}`);
  process.exit(0);
}
const mode = flag('send') ? 'send' : 'shadow';
if (mode === 'send' && !keypair) usage('--send needs --keypair');
const out = await run(built.transactions, { mode, rpc, ...(keypair ? { sign: keypair.sign } : {}), onStatus: (s) => console.error(s) });
if (out.mode === 'shadow' && out.simulations) {
  const [first, ...rest] = out.simulations;
  console.log(`
Shadow mode: nothing was sent. The cluster simulated the transactions against its current state.`);
  console.log(`  create: ${first!.ok ? `would succeed (${first!.unitsConsumed} compute units)` : `would FAIL: ${json(first!.err)}`}`);
  const later = rest.filter((x) => x.inconclusive).length;
  if (later) console.log(`  ${later} further transaction(s) (the book shards) cannot be simulated before the cross exists; they are inconclusive, not failed.`);
  const bad = rest.filter((x) => !x.ok && !x.inconclusive);
  for (const b of bad) console.log(`  FAILED: ${json(b.err)}`);
  process.exit(first!.ok && bad.length === 0 ? 0 : 1);
}
console.log(json(out));
