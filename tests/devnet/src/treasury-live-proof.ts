// Live proof for the treasury read side and the disclosure feed (X2/A5 read side, E5): a devnet treasury is created with
// production-shaped terms (30-day allowance period, 7-day grace), indexed from finalized chain data into a real Postgres by the
// treasury indexer process, served by a local API process pointed at devnet, and read back against independent chain reads.
// The owner then posts a signed, Memo-anchored disclosure update through the CLI, and the refusals are exercised over HTTP.
//
//   DATABASE_URL=postgres://… pnpm --filter @opening-cross/devnet-proofs exec tsx src/treasury-live-proof.ts
//
// Needs a Postgres at DATABASE_URL (the migrations are applied by the indexer process). Devnet funds come from the promiser key
// through a throwaway funder, as in the other devnet proofs; whatever is left is returned.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Address, type KeyPairSigner, createKeyPairSignerFromBytes, generateKeyPairSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import { TreasuryState, findTreasuryPda, findVaultPda, getCreateTreasuryInstruction, getSpendInstruction, getTreasuryDecoder } from '@opening-cross/treasury-client';
import { Evidence, ROOT } from './lib.js';
import { accountData, asIx, ata, ataIx, chainTime, exists, freshFunder, fundWallets, mintTo, newMint, revokeMintAuthority, send, sleep, sweepBack, tokenBalance } from './kit.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (a Postgres the indexer and API can use)');
  process.exit(2);
}
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const PORT = Number(process.env.PROOF_API_PORT ?? 8091);
const API = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, DATABASE_URL, RPC_URL, NETWORK: 'devnet', PORT: String(PORT) };
const tsx = (cwd: string, args: string[], extraEnv: Record<string, string> = {}) => execFileSync(process.execPath, ['--import', 'tsx', ...args], { cwd: `${ROOT}${cwd}`, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });

const SAS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';
const ev = new Evidence('X2-treasury-read-side-devnet.md', 'Devnet proof — treasury read side: indexer, API, rights cards and the disclosure feed (X2 / A5 read side, E5)', [
  'Script `tests/devnet/src/treasury-live-proof.ts`. A real devnet treasury is created, indexed from finalized chain data by `services/indexer/src/treasury-main.ts` into a real Postgres, and served by `services/api/src/routes/treasury-dev-server.ts` (the main.ts wiring plus `registerTreasury`) pointed at devnet. Every API figure is compared with an independent chain read made by this script.',
  'The treasury uses production-shaped terms: a 1,000-quote allowance per 30-day period and a 7-day grace. The auditor, team and holders are throwaway keys, so this proves the mechanism and not any real audit process. The disclosure update it posts is a devnet test and says so in its own signed text.',
  '',
  'Not covered: a mainnet treasury (none exists); a lapse, liquidation or redemption driven by this script (those are covered by `A5-treasury-devnet.md`, and the API reads the earlier proof treasuries here); the wrong-sequence and forked-chain refusals over a live cluster (covered by `services/api/test/treasury.test.ts` against a real Postgres, with an injected transaction reader); the web pages (screenshots are recorded separately in this file by the web run).',
]);

let api: ChildProcess | undefined;
let cleanup: (() => Promise<void>) | undefined;

/** Same as the proofs elsewhere: an Ed25519 keypair whose secret bytes can be written to the git-ignored key folder. */
async function extractableSigner(): Promise<{ signer: KeyPairSigner; bytes: number[] }> {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...raw]);
  return { signer: await createKeyPairSignerFromBytes(bytes), bytes: [...bytes] };
}

async function getJson<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function waitFor(what: string, f: () => Promise<boolean>, tries = 60, ms = 3_000) {
  for (let i = 0; i < tries; i++) {
    if (await f().catch(() => false)) return;
    await sleep(ms);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const { funder, promiser } = await freshFunder(250_000_000n);
  cleanup = async () => {
    api?.kill();
    const back = await sweepBack(funder, promiser);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
  };
  const { signer: team, bytes: teamBytes } = await extractableSigner();
  const teamKeyFile = `${ROOT}.keys/treasury-live-team-${team.address.slice(0, 6)}.json`;
  writeFileSync(teamKeyFile, JSON.stringify(teamBytes)); // git-ignored; read only by the CLI below
  const [auditor, alice, bob, stranger] = await Promise.all([1, 2, 3, 4].map(() => generateKeyPairSigner()));
  const { signer: strangerKey, bytes: strangerBytes } = await extractableSigner();
  const strangerKeyFile = `${ROOT}.keys/treasury-live-stranger-${strangerKey.address.slice(0, 6)}.json`;
  writeFileSync(strangerKeyFile, JSON.stringify(strangerBytes));
  void stranger;
  await fundWallets(funder, [team.address, alice!.address, bob!.address, strangerKey.address], 12_000_000n);
  await fundWallets(funder, [auditor!.address], 20_000_000n);

  // ---------------------------------------------------------------- the treasury, on chain
  const credName = `treasury-live-${Date.now()}`;
  const [credential] = await deriveCredentialPda({ authority: auditor!.address, name: credName });
  const [schema] = await deriveSchemaPda({ credential, name: 'monthly-report', version: 1 });
  await send([asIx(getCreateCredentialInstruction({ payer: auditor, credential, authority: auditor, name: credName, signers: [auditor!.address] } as never))], auditor!);
  await send([asIx(getCreateSchemaInstruction({ payer: auditor, authority: auditor, credential, schema, name: 'monthly-report', description: 'Monthly treasury report filed', layout: new Uint8Array([0]), fieldNames: ['ok'] } as never))], auditor!);

  const quoteMint = await newMint(funder, funder.address);
  const coin = await newMint(funder, funder.address);
  await send([await ataIx(funder, team.address, quoteMint), await ataIx(funder, alice!.address, quoteMint)], funder);
  await mintTo(funder, coin, alice!.address, funder, 600_000_000n);
  await mintTo(funder, coin, bob!.address, funder, 400_000_000n);
  await revokeMintAuthority(funder, coin, funder);
  const [treasury] = await findTreasuryPda({ coinMint: coin });
  const [vault] = await findVaultPda({ treasury });
  const t0 = await chainTime();
  const createSig = await send(
    [getCreateTreasuryInstruction({ authority: team, coinMint: coin, quoteMint, treasury, vault, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, allowance: 1_000_000_000n, periodSecs: 2_592_000n, graceSecs: 604_800n, credential, schema })],
    team,
  );
  await send([(await import('@solana-program/token-2022')).getMintToInstruction({ mint: quoteMint, token: vault, mintAuthority: funder, amount: 10_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], funder);
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce: treasury });
  const attExpiry = (await chainTime()) + 35n * 86_400n;
  const attestSig = await send([asIx(getCreateAttestationInstruction({ payer: auditor, authority: auditor, credential, schema, attestation, nonce: treasury, data: new Uint8Array([1]), expiry: attExpiry } as never))], auditor!);
  const teamQuote = await ata(team.address, quoteMint);
  const spendSig = await send(
    [getSpendInstruction({ authority: team, treasury, attestation, quoteMint, vault, destination: teamQuote, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount: 250_000_000n })],
    team,
  );
  const onChain = getTreasuryDecoder().decode(await accountData(treasury));
  const vaultBalance = await tokenBalance(vault);
  ev.check('create', 'a treasury with a 1,000-quote allowance per 30-day period and a 7-day grace exists on devnet, with a live attestation and 250 quote already spent', onChain.state === TreasuryState.Active && onChain.allowance === 1_000_000_000n && onChain.periodSecs === 2_592_000n && onChain.spentInPeriod === 250_000_000n && (await exists(attestation)), `treasury ${treasury}, vault ${vault} holds ${vaultBalance}, attestation ${attestation} expires ${attExpiry}`, createSig);
  ev.check('attest-and-spend', 'the attestation and the spend are on chain', true, `spend moved 250000000 quote atoms to the team`, spendSig);
  void attestSig;

  // ---------------------------------------------------------------- the indexer process, then the API process
  // Finalized commitment lags the confirmed head by about 13 s on devnet, so pass until this treasury's spend is indexed.
  let indexerRuns = 0;
  const pass = () => {
    indexerRuns++;
    return tsx('services/indexer', ['src/treasury-main.ts'], { ONCE: '1' });
  };
  // pg is the indexer's dependency; resolve it from there rather than adding it to this package.
  const pg = createRequire(`${ROOT}services/indexer/package.json`)('pg') as typeof import('pg');
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  await waitFor('the indexer to see the treasury and its spend', async () => {
    pass();
    const { rows } = await db.query('SELECT spend_count FROM treasuries WHERE address = $1', [treasury]);
    return rows[0]?.spend_count === 1;
  }, 40, 5_000);
  const row = (await db.query('SELECT * FROM treasuries WHERE address = $1', [treasury])).rows[0];
  const evs = (await db.query('SELECT name FROM treasury_events WHERE treasury = $1 ORDER BY slot, seq', [treasury])).rows.map((r) => r.name);
  ev.check('indexer', 'the treasury indexer (finalized commitment) projected the creation and the spend into Postgres', row.allowance === '1000000000' && row.authority === team.address && row.spent_total === '250000000' && evs.join() === 'TreasuryCreated,Spent', `${indexerRuns} pass(es); events ${evs.join(', ')}; created_at ${row.created_at}; ${(await db.query('SELECT count(*)::int AS n FROM treasuries')).rows[0].n} treasuries indexed in total (earlier proof runs included)`);

  api = spawn(process.execPath, ['--import', 'tsx', 'src/routes/treasury-dev-server.ts'], { cwd: `${ROOT}services/api`, env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitFor('the API process', async () => (await fetch(`${API}/v1/treasuries`)).ok, 40, 2_000);

  // ---------------------------------------------------------------- the API against independent chain reads
  const d = await getJson(`/v1/treasuries/${treasury}`);
  const b = d.body;
  const att = b.attestation;
  ev.check(
    'api-detail',
    'GET /v1/treasuries/:address returns the terms, spend window, vault, supply and attestation exactly as an independent chain read does',
    d.status === 200 && b.state === 'Active' && b.terms.authority === team.address && b.terms.allowance === '1000000000' && b.terms.periodSecs === '2592000' && b.terms.graceSecs === '604800' && b.spend.spentInPeriod === '250000000' && b.spend.allowanceRemaining === '750000000' &&
      b.balances.vault === vaultBalance.toString() && b.balances.coinSupply === '1000000000' && b.balances.coinMintAuthority === null && att.address === attestation && att.live === true && att.expiry === attExpiry.toString(),
    `vault ${b.balances.vault} (chain ${vaultBalance}); remaining ${b.spend.allowanceRemaining}; attestation ${att.address} live=${att.live} expiry ${att.expiry}; mint authority ${b.balances.coinMintAuthority}; indexed=${b.indexed}`,
  );
  const upgrade = b.programUpgradeAuthority;
  const loaderProgram = await accountData('HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd' as Address);
  ev.check('api-upgrade-authority', 'the program upgrade authority the API reports is read from the loader accounts', typeof upgrade === 'string' && upgrade !== 'unknown' ? upgrade.length >= 32 : upgrade === null, `reported ${String(upgrade)} (program account is ${loaderProgram.length} bytes)`);
  const cards: { id: string; kind: string; now: string | null; enforcedBy: unknown[]; absence: string | null }[] = b.rights;
  ev.check('rights-cards', 'the API returns the rights cards with live lines; every card cites an enforcement or states an absence', cards.length >= 15 && cards.every((c) => c.enforcedBy.length > 0 || c.absence) && cards.find((c) => c.id === 'spend-gate')!.now!.includes('live now') && cards.find((c) => c.id === 'spend-cap')!.now!.includes('750 quote of 1,000 quote'), `${cards.length} cards; spend-cap: ${cards.find((c) => c.id === 'spend-cap')!.now}`);
  const list = await getJson('/v1/treasuries');
  const mine = list.body.treasuries.find((t: { address: string }) => t.address === treasury);
  const states = list.body.treasuries.map((t: { state?: string; indexedState: string }) => t.state ?? t.indexedState);
  ev.check('api-list', 'GET /v1/treasuries lists this treasury and the earlier proof treasuries with their live state', list.status === 200 && mine?.state === 'Active' && mine.vaultBalance === vaultBalance.toString() && mine.disclosure.state === 'current', `${list.body.treasuries.length} treasuries: ${states.join(', ')}`);
  const liquidated = list.body.treasuries.find((t: { state?: string }) => t.state === 'Liquidating');
  if (liquidated) {
    const ld = await getJson(`/v1/treasuries/${liquidated.address}`);
    const redeem = ld.body.rights.find((c: { id: string }) => c.id === 'redeem-pro-rata').now as string;
    ev.check('api-liquidated', 'an earlier proof treasury that was liquidated and redeemed reads as Liquidating with its snapshot and a redemption history', ld.body.state === 'Liquidating' && ld.body.snapshot !== null && redeem.startsWith('Open.') && ld.body.history.redemptionCount >= 1 && ld.body.disclosure.state === 'closed', `${liquidated.address}: snapshot ${JSON.stringify(ld.body.snapshot)}, redemptions ${ld.body.history.redemptionCount}, paid ${ld.body.history.redeemedPaid}`);
  }
  const unknown = await getJson(`/v1/treasuries/${(await generateKeyPairSigner()).address}`);
  const junk = await getJson('/v1/treasuries/not-an-address');
  ev.check('api-refusals', 'an address that is not a treasury answers 404 and junk answers 400', unknown.status === 404 && junk.status === 400, `${unknown.status} ${unknown.body.error}; ${junk.status} ${junk.body.error}`);

  // ---------------------------------------------------------------- the disclosure update through the CLI
  const coveredFrom = Number(t0) - 60;
  const coveredTo = Number(await chainTime()) - 2;
  const cli = (keyFile: string, over: string[] = []) =>
    tsx('services/api', ['src/routes/treasury-update-cli.ts', '--keypair', keyFile, '--treasury', treasury, '--title', 'Devnet test update 1', '--summary', 'Devnet test. Written by tests/devnet/src/treasury-live-proof.ts to exercise the disclosure feed. The figure is this test treasury\'s own devnet spend; it is not a report by any real treasury.', '--covered-from', String(coveredFrom), '--covered-to', String(coveredTo), '--declared-spent', '250000000', '--api', API, '--rpc', RPC_URL, ...over]);
  const out = JSON.parse(cli(teamKeyFile)) as { duplicate: boolean; update: { id: string; sequence: number; signature: string; body: unknown; anchor: { signature: string; slot: string; blockTime: number }; spendCheck: { matches: boolean; spentOnChainAtoms: string } } };
  const u = out.update;
  const memoTx = await (await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [u.anchor.signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }) })).json() as { result: { blockTime: number; slot: number; transaction: { message: { instructions: { parsed?: string }[] } } } };
  const memoText = memoTx.result.transaction.message.instructions.find((i) => typeof i.parsed === 'string')?.parsed;
  ev.check('update-posted', 'the owner CLI signs an update, anchors its id in a Memo signed by the treasury authority, and the API stores it', !out.duplicate && u.sequence === 1 && memoText === `opening-cross/treasury-update/v1 treasury=${treasury} seq=1 id=${u.id}` && memoTx.result.blockTime === u.anchor.blockTime, `update ${u.id}; memo text read back from chain: ${memoText}; block time ${u.anchor.blockTime}`, u.anchor.signature);
  ev.check('update-spend-check', "the update's declared spend is compared with the program's own Spent events for the span it covers", u.spendCheck.matches && u.spendCheck.spentOnChainAtoms === '250000000', `declared 250000000, on chain ${u.spendCheck.spentOnChainAtoms}`);

  const after = await getJson(`/v1/treasuries/${treasury}`);
  ev.check('disclosure-state', 'the treasury page now reports the reporting clock running from the anchored update', after.body.disclosure.state === 'current' && after.body.disclosure.basis === 'last-update' && after.body.disclosure.basisAt === u.anchor.blockTime && after.body.disclosure.updateCount === 1, JSON.stringify(after.body.disclosure));
  const updates = await getJson(`/v1/treasuries/${treasury}/updates`);
  ev.check('updates-list', 'GET /updates returns the stored update unchanged', updates.body.updates.length === 1 && updates.body.updates[0].id === u.id, `1 update, sequence ${updates.body.updates[0].sequence}`);

  // ---------------------------------------------------------------- refusals
  const post = async (update: unknown, memoSignature: string) => {
    const r = await fetch(`${API}/v1/treasuries/${treasury}/updates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update, memoSignature }) });
    return { status: r.status, body: (await r.json()) as { error?: string; duplicate?: boolean } };
  };
  const stored = updates.body.updates[0];
  const replay = await post({ id: stored.id, body: stored.body, signer: stored.signer, signature: stored.signature }, stored.anchor.signature);
  ev.check('refuse-replay', 'posting the same update again changes nothing', replay.status === 200 && replay.body.duplicate === true, `HTTP ${replay.status}, duplicate=${replay.body.duplicate}`);
  const tampered = await post({ id: stored.id, body: { ...stored.body, summary: 'Spent nothing.' }, signer: stored.signer, signature: stored.signature }, stored.anchor.signature);
  ev.check('refuse-tamper', 'an edited body no longer matches its id and is refused', tampered.status === 400 && /ID_MISMATCH/.test(tampered.body.error ?? ''), `HTTP ${tampered.status}: ${tampered.body.error}`);
  let strangerResult = '';
  try {
    cli(strangerKeyFile);
  } catch (e) {
    strangerResult = String((e as { stderr?: string }).stderr ?? e);
  }
  ev.check('refuse-stranger', 'a key that is not the treasury authority cannot post an update, even with a valid signature and a real Memo', /not this treasury's authority/.test(strangerResult), strangerResult.split('\n').find((l) => l.includes('refused')) ?? strangerResult.slice(0, 200));
  const stillOne = await getJson(`/v1/treasuries/${treasury}/updates`);
  ev.check('refusals-store-nothing', 'none of the refusals stored anything', stillOne.body.updates.length === 1, `${stillOne.body.updates.length} update stored`);
  await db.end();
}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => ev.write(error));
main().then(() => done(), (e) => { console.error(e); return done(e); });
