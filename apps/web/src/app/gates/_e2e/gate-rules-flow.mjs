// The gate screens in a real browser against a real cluster, with real transactions: an issuer creates a gate for a token and switches
// compliance rules on; three people with different standings at the issuer's identity provider try to get a pass; the issuer blocks one.
// Everything the page shows is checked against the chain, and every transaction is signed in a wallet and lands on the cluster.
//
// Needs, running: a validator with cross_gate and the Solana Attestation Service (RPC_URL), the web app (BASE_URL, started with
// NEXT_PUBLIC_RPC_URL=<RPC_URL> and NEXT_PUBLIC_KYC_ATTESTER_URL=<ATTESTER_URL>). It starts the identity attester itself.
//
//   RPC_URL=http://127.0.0.1:18899 BASE_URL=http://localhost:3480 ATTESTER_PORT=18787 OUT=<dir> CHROME=<chrome.exe> \
//   services/identity-attester/node_modules/.bin/tsx apps/web/src/app/gates/_e2e/gate-rules-flow.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
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
import {
  CONFIG_BASE_SIZE,
  CountryPolicy,
  FLAG,
  RULES_EXT_SIZE,
  countryListed,
  countryNumeric,
  findConfigPda,
  findDeniedAddress,
  findIdentityAddress,
  findPassAddress,
  findTermsAddress,
  getGateConfigDecoder,
  getTermsDecoder,
  readRules,
} from '../../../../../../packages/cross-gate-client/src/index.js';

const ROOT = new URL('../../../../../../', import.meta.url);
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:18899';
const BASE = process.env.BASE_URL ?? 'http://localhost:3480';
const ATTESTER_PORT = process.env.ATTESTER_PORT ?? '18787';
const OUT = process.env.OUT ?? 'e2e-out';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('apps/web/e2e/gate-wallet.js', ROOT), 'utf8');
const rpc = createSolanaRpc(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const problems = [];
const evidence = { signatures: {}, accounts: {} };
const log = (ok, what, detail = '') => {
  results.push({ ok, what, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
};

// ---- keys and funds: all disposable, written under OUT only
async function newKey(name) {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const secret = [...pkcs8.slice(-32), ...raw];
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(secret));
  writeFileSync(`${OUT}/${name}.key.json`, JSON.stringify(secret));
  return { name, secret, signer, address: signer.address };
}
const issuer = await newKey('issuer');
const attester = await newKey('attester');
const alice = await newKey('alice'); // in India, verified by the provider
const bob = await newKey('bob'); // in the United States, verified by the provider
const carol = await newKey('carol'); // unknown to the provider
const dave = await newKey('dave'); // an insider the issuer grants a pass to
writeFileSync(`${OUT}/attester.secret`, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'));

for (const k of [issuer, attester, alice, bob, carol, dave]) {
  await rpc.requestAirdrop(k.address, lamports(5_000_000_000n)).send();
}
for (let i = 0; i < 60; i++) {
  const balances = await Promise.all([issuer, attester, alice, bob, carol, dave].map((k) => rpc.getBalance(k.address, { commitment: 'confirmed' }).send()));
  if (balances.every((b) => b.value > 0n)) break;
  await sleep(1000);
}

async function land(instructions, payer) {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(
    pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m), (m) => appendTransactionMessageInstructions(instructions, m)),
  );
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
  const signature = getSignatureFromTransaction(tx);
  for (let i = 0; i < 60; i++) {
    const s = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (s?.err) throw new Error(`setup transaction failed: ${JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return signature;
    await sleep(500);
  }
  throw new Error('setup transaction was not confirmed');
}

// ---- a Token-2022 mint whose mint authority is the issuer (setup, not under test)
const t22 = createRequire(new URL('tests/core/package.json', ROOT))('@solana-program/token-2022');
const sys = createRequire(new URL('tests/core/package.json', ROOT))('@solana-program/system');
const mintKey = await generateKeyPairSigner();
const space = t22.getMintSize();
await land(
  [
    sys.getCreateAccountInstruction({ payer: issuer.signer, newAccount: mintKey, lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(), space, programAddress: t22.TOKEN_2022_PROGRAM_ADDRESS }),
    t22.getInitializeMint2Instruction({ mint: mintKey.address, decimals: 6, mintAuthority: issuer.address, freezeAuthority: null }),
  ],
  issuer.signer,
);
const MINT = mintKey.address;
console.log(`token mint ${MINT}`);

// ---- the identity provider's records (a manual allowlist: the provider is the issuer's own KYC) and the attester
const providerFile = `${OUT}/provider.json`;
const future = Math.floor(Date.now() / 1000) + 365 * 86_400;
writeFileSync(
  providerFile,
  JSON.stringify({
    wallets: {
      [alice.address]: { customerRef: 'PERSON-ALICE', tier: 1, country: 'IN', expiresAt: future, kycVerified: true, sanctionsScreened: true },
      [bob.address]: { customerRef: 'PERSON-BOB', tier: 1, country: 'US', expiresAt: future, kycVerified: true, sanctionsScreened: true },
    },
  }),
);
const local = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const TSX = local(new URL(`services/identity-attester/node_modules/.bin/${process.platform === "win32" ? "tsx.CMD" : "tsx"}`, ROOT));
const ATTESTER_DIR = local(new URL("services/identity-attester/", ROOT));
const attesterEnv = {
  ...process.env,
  RPC_URL: RPC,
  ATTESTER_KEYPAIR: `${OUT}/attester.key.json`,
  ATTESTER_SECRET_FILE: `${OUT}/attester.secret`,
  ATTESTER_PROVIDER: 'allowlist',
  ATTESTER_ALLOWLIST_FILE: providerFile,
  ATTESTER_WALLET_SIGNED: '1',
  ATTESTER_CORS_ORIGIN: new URL(BASE).origin,
  ATTESTER_SYNC_INTERVAL_SECS: '0',
  ATTESTER_SYNC_DELAY_MS: '0',
  PORT: ATTESTER_PORT,
};
const init = spawnSync(TSX, ['src/kyc-cli.ts', 'init'], { cwd: ATTESTER_DIR, env: attesterEnv, encoding: 'utf8', shell: process.platform === 'win32' });
if (init.status !== 0) throw new Error(`attester init failed: ${init.stderr}`);
const sas = JSON.parse(init.stdout);
console.log(`attester credential ${sas.credential}, identity schema ${sas.identitySchema}`);
evidence.accounts.credential = sas.credential;
evidence.accounts.identitySchema = sas.identitySchema;
if (await fetch(`http://127.0.0.1:${ATTESTER_PORT}/v1/health`).then((r) => r.ok, () => false)) throw new Error(`something already answers on attester port ${ATTESTER_PORT}`);
const server = spawn(TSX, ['src/kyc-cli.ts', 'serve'], { cwd: ATTESTER_DIR, env: attesterEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let attesterLog = '';
server.stdout.on('data', (d) => (attesterLog += d));
server.stderr.on('data', (d) => (attesterLog += d));
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${ATTESTER_PORT}/v1/health`).then((r) => r.ok, () => false)) break;
  await sleep(500);
}

// ---- chain readers
async function account(address) {
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
  return value ? { data: new Uint8Array(Buffer.from(value.data[0], 'base64')), owner: value.owner } : null;
}
const exists = async (pda) => (await account((await pda)[0])) !== null;
const configAddress = (await findConfigPda({ mint: MINT }))[0];
const chainRules = async () => {
  const a = await account(configAddress);
  return a ? { config: getGateConfigDecoder().decode(a.data), rules: readRules(a.data), size: a.data.length } : null;
};

// ---- browser
let lastPage = null;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function open(who, width = 1440, scheme = 'light') {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, colorScheme: scheme, timezoneId: 'UTC' });
  if (who) {
    await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: who.secret, chain: 'solana:devnet' })};`);
    await ctx.addInitScript(WALLET_JS);
  }
  const page = await ctx.newPage();
  lastPage = page;
  // The older gates list on /gates asks the Opening Cross API (http://localhost:8080), which this run does not start: those failures are not this page's.
  const apiDown = (text) => /localhost:8080|Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(text);
  page.on('console', (m) => m.type() === 'error' && !apiDown(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && !apiDown(r.url()) && problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  return { ctx, page };
}
async function connect(page, who) {
  const option = page.getByRole('button', { name: /E2E Test Wallet/ });
  for (let attempt = 1; !(await option.isVisible()); attempt++) {
    if (attempt > 8) throw new Error('the wallet list never opened');
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await option.waitFor({ timeout: 4000 }).catch(() => undefined);
  }
  await option.click();
  await page.getByLabel(`Connected as ${who.address}`).waitFor();
}
const gatePage = async (page, who) => {
  await page.goto(`${BASE}/gates/${MINT}`, { waitUntil: 'domcontentloaded' });
  if (who) await connect(page, who);
};
const sigOf = async (page, testId) => {
  const href = await page.locator(`[data-testid="${testId}-done"] a`).getAttribute('href');
  return href?.match(/tx\/([1-9A-HJ-NP-Za-km-z]{60,90})/)?.[1] ?? null;
};
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
const noOverflow = async (page, name) => log(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `no horizontal overflow: ${name}`);
const axe = async (page, name) => {
  const r = await new AxeBuilder({ page }).analyze();
  log(r.violations.length === 0, `axe clean: ${name}`, r.violations.map((v) => `${v.id}(${v.nodes.length})`).join(','));
};

try {
  // ============ 1. a token with no gate; the mint authority creates one
  {
    const { ctx, page } = await open(null);
    await gatePage(page, null);
    await page.getByTestId('gate-missing').waitFor({ timeout: 120_000 });
    log((await page.getByTestId('gate-missing').innerText()).includes('This token has no gate'), 'a token with no gate says so');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(alice);
    await gatePage(page, alice);
    await page.getByTestId('gate-missing').waitFor({ timeout: 120_000 });
    await page.getByTestId('not-mint-authority').waitFor({ timeout: 30_000 });
    log(true, 'a wallet that is not the mint authority is told only the mint authority can create the gate');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(issuer);
    await gatePage(page, issuer);
    await page.getByTestId('create-gate').waitFor({ timeout: 120_000 });
    await shot(page, '01-create-gate');
    await page.getByTestId('create-gate-submit').click();
    // The button is replaced by the gate's own page once the chain shows the gate, so wait for that rather than for the button's message.
    await page.getByTestId('rules-form').waitFor({ timeout: 120_000 });
    evidence.signatures.createGate = (await rpc.getSignaturesForAddress(configAddress, { commitment: 'confirmed' }).send()).at(-1)?.signature ?? null;
    const c = await chainRules();
    log(c !== null && c.config.authority === issuer.address && c.rules === null && c.size === CONFIG_BASE_SIZE, 'the gate exists on chain with the issuer as authority and no rules', `config ${configAddress}`);
    await page.getByTestId('no-rules').waitFor({ timeout: 60_000 });
    log(true, 'the page shows the gate with no compliance rules');
    await ctx.close();
  }

  // ============ 2. the issuer switches rules on: Regulation S, KP excluded, a one-year lock
  {
    const { ctx, page } = await open(issuer);
    await gatePage(page, issuer);
    await page.getByTestId('rules-form').waitFor({ timeout: 120_000 });
    await page.getByTestId('preset').selectOption('reg-s');
    await page.getByTestId('restricted').fill('KP');
    await page.getByTestId('identityCredential').fill(sas.credential);
    // Only half an attester is a mistake the form names, and the button stays off.
    await page.getByTestId('identitySchema').fill('');
    await page.getByTestId('form-problems').waitFor();
    log((await page.getByTestId('form-problems').innerText()).includes('Identity attester'), 'half an attester is named as a problem');
    log(await page.getByTestId('submit-rules').isDisabled(), 'the submit button is off while the form has a problem');
    await page.getByTestId('identitySchema').fill(sas.identitySchema);
    await shot(page, '02-rules-form');
    await noOverflow(page, 'rules form');
    log(await page.getByTestId('form-problems').count() === 0, 'a complete form has no problems');
    await page.getByTestId('submit-rules').click();
    await page.getByTestId('submit-rules-done').waitFor({ timeout: 120_000 });
    evidence.signatures.initRules = await sigOf(page, 'submit-rules');
    const c = await chainRules();
    const r = c?.rules;
    const us = countryNumeric('US');
    const kp = countryNumeric('KP');
    log(!!r && r.countryPolicy === CountryPolicy.Deny && countryListed(r.countries, us) && countryListed(r.countries, kp) && c.size === CONFIG_BASE_SIZE + RULES_EXT_SIZE, 'the rules on chain deny the United States and North Korea', `config is ${c?.size} bytes`);
    log(!!r && r.lockPolicy.__option === 'Some' && r.lockPolicy.value.durationSecs === 365n * 86_400n && (r.requiredFlags & (FLAG.kyc | FLAG.sanctionsClear)) === (FLAG.kyc | FLAG.sanctionsClear) && r.identity.__option === 'Some' && r.identity.value.credential === sas.credential, 'a one-year resale lock, KYC and sanctions flags and the issuer\'s attester are on chain');
    await page.getByTestId('requirements').waitFor({ timeout: 60_000 });
    const text = await page.getByTestId('requirements').innerText();
    log(/No holders in .*United States/.test(text) && /365 days/.test(text), 'the page says what the rules say', text.replace(/\n/g, ' | '));
    await shot(page, '03-rules-on');
    await ctx.close();
  }

  // ============ 3. three people ask for a pass
  {
    // Alice: in India, verified. Verifies, claims, holds a pass.
    const { ctx, page } = await open(alice);
    await gatePage(page, alice);
    await page.getByTestId('standing-reasons').waitFor({ timeout: 120_000 });
    log((await page.getByTestId('standing-reasons').innerText()).includes('No identity attestation'), 'before verifying, Alice is told she has no attestation');
    await shot(page, '04-alice-before');
    await page.getByTestId('verify-check').click();
    // Once the chain shows the attestation the page moves on to the claim step, replacing the verify step.
    await page.getByTestId("claim-pass").waitFor({ timeout: 120_000 });
    const recorded = await page.getByTestId("standing-record").innerText();
    log(recorded.includes("India"), "the attester recorded Alice verification on chain: the page shows country India and offers the claim", recorded);
    await page.getByTestId('claim-pass').waitFor({ timeout: 120_000 });
    await shot(page, '05-alice-can-claim');
    await page.getByTestId('claim-pass').click();
    // The claim step is replaced by the pass-held notice once the chain shows the pass.
    await page.getByTestId('pass-held').waitFor({ timeout: 120_000 });
    evidence.signatures.aliceClaim = (await rpc.getSignaturesForAddress((await findPassAddress(MINT, alice.address))[0], { commitment: 'confirmed' }).send()).at(-1)?.signature ?? null;
    const t = await account((await findTermsAddress(MINT, alice.address))[0]);
    const terms = t ? getTermsDecoder().decode(t.data) : null;
    log((await exists(findPassAddress(MINT, alice.address))) && terms?.country === countryNumeric('IN') && (terms.flags & FLAG.kyc) !== 0 && terms.source === 1, 'Alice holds a pass on chain with country India, KYC and source SAS');
    log((await chainRules()).rules.passes === 1, 'the pass counter reads 1');
    await shot(page, '06-alice-holds-pass');
    await noOverflow(page, 'alice holds pass');
    await axe(page, 'gate page, holder with a pass');
    await ctx.close();
  }
  {
    // Bob: verified, but in the United States. The attester records the truth; the gate refuses and says why.
    const { ctx, page } = await open(bob);
    await gatePage(page, bob);
    await page.getByTestId('verify-check').click();
    await page.getByTestId('standing-record').waitFor({ timeout: 120_000 });
    await page.getByTestId('standing-reasons').waitFor({ timeout: 120_000 });
    const reasons = await page.getByTestId('standing-reasons').innerText();
    log(/United States/.test(reasons), 'Bob\'s country is refused by name', reasons.replace(/\n/g, ' | '));
    log((await page.getByTestId('claim-pass').count()) === 0, 'Bob is offered no claim button');
    log(!(await exists(findPassAddress(MINT, bob.address))), 'Bob holds no pass on chain');
    await shot(page, '07-bob-refused');
    await ctx.close();
  }
  {
    // Carol: the provider has never heard of her.
    const { ctx, page } = await open(carol);
    await gatePage(page, carol);
    await page.getByTestId('verify-check').click();
    await page.getByTestId('verify-ineligible').waitFor({ timeout: 120_000 });
    log((await page.getByTestId('verify-ineligible').innerText()).includes('No verified identity record'), 'Carol is told the provider has no record of her wallet');
    log(!(await exists(findPassAddress(MINT, carol.address))), 'Carol holds no pass on chain');
    await shot(page, '08-carol-no-record');
    await ctx.close();
  }

  // ============ 4. the issuer grants an insider a pass, then blocks Alice
  {
    const { ctx, page } = await open(issuer);
    await gatePage(page, issuer);
    await page.getByTestId('grant-pass').waitFor({ timeout: 120_000 });
    await page.getByTestId('grant-owner').fill(dave.address);
    await page.getByTestId('grant-country').fill('GB');
    await page.getByTestId('grant-insider').check();
    // The rules require a sanctions screen: a grant without it is refused by the program, and the page says so.
    await page.getByTestId('grant-submit').click();
    await page.getByTestId('grant-submit-error').waitFor({ timeout: 120_000 });
    log((await page.getByTestId('grant-submit-error').innerText()).includes('lacks a flag this token requires'), 'a grant the rules forbid is refused by the program and the page says why');
    log(!(await exists(findPassAddress(MINT, dave.address))), 'the refused grant created no pass');
    await page.getByTestId('grant-sanctions').check();
    await shot(page, '09-grant-form');
    await page.getByTestId('grant-submit').click();
    await page.getByTestId('grant-submit-done').waitFor({ timeout: 120_000 });
    evidence.signatures.grantDave = await sigOf(page, 'grant-submit');
    const t = await account((await findTermsAddress(MINT, dave.address))[0]);
    const terms = t ? getTermsDecoder().decode(t.data) : null;
    log(terms?.source === 0 && (terms.flags & FLAG.affiliate) !== 0 && terms.country === countryNumeric('GB'), 'Dave holds an authority-granted pass flagged as an insider, country United Kingdom');

    await page.getByTestId('control-wallet').fill(alice.address);
    await page.getByTestId('wallet-facts').waitFor({ timeout: 60_000 });
    log((await page.getByTestId('wallet-facts').innerText()).startsWith('Holds a pass'), 'the wallet controls show Alice holds a pass');
    await page.getByTestId('block-wallet').click();
    await page.getByTestId('block-wallet-done').waitFor({ timeout: 120_000 });
    evidence.signatures.blockAlice = await sigOf(page, 'block-wallet');
    log(!(await exists(findPassAddress(MINT, alice.address))) && (await exists(findDeniedAddress(MINT, alice.address))) && !(await exists(findTermsAddress(MINT, alice.address))) && !(await exists(findIdentityAddress(MINT, new Uint8Array(32)))), 'blocking closes Alice\'s pass and denies her wallet in one transaction');
    log((await chainRules()).rules.passes === 2 - 1, 'the pass counter follows (Dave in, Alice out)', `passes ${(await chainRules()).rules.passes}`);
    await page.getByTestId('wallet-facts').filter({ hasText: 'Currently blocked' }).waitFor({ timeout: 60_000 });
    await shot(page, '10-alice-blocked-issuer');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(alice);
    await gatePage(page, alice);
    await page.getByTestId('standing-reasons').waitFor({ timeout: 120_000 });
    const text = await page.getByTestId('standing-reasons').innerText();
    log(/blocked/.test(text), 'Alice, blocked, is told she has been blocked', text.replace(/\n/g, ' | '));
    await shot(page, '11-alice-blocked');
    await ctx.close();
  }

  // ============ 5. the look of it: both themes, both widths, no overflow, no axe violations
  for (const [width, scheme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const { ctx, page } = await open(issuer, width, scheme);
    await gatePage(page, issuer);
    await page.getByTestId('rules-form').waitFor({ timeout: 120_000 });
    await shot(page, `20-issuer-${width}-${scheme}`);
    await noOverflow(page, `issuer view ${width} ${scheme}`);
    await axe(page, `issuer view ${width} ${scheme}`);
    await ctx.close();
  }
  for (const [width, scheme] of [[1440, 'light'], [390, 'dark']]) {
    const { ctx, page } = await open(null, width, scheme);
    await page.goto(`${BASE}/gates`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('gate-mint').waitFor({ timeout: 120_000 });
    // A field filled before the page hydrates is reset by it: type again until the page has taken the value.
    for (let i = 0; i < 10 && !(await page.getByTestId('gate-mint-invalid').isVisible()); i++) {
      await page.getByTestId('gate-mint').fill('not an address');
      await page.getByTestId('gate-mint-invalid').waitFor({ timeout: 2000 }).catch(() => undefined);
    }
    await page.getByTestId('gate-mint-invalid').waitFor();
    await page.getByTestId('gate-mint').fill(MINT);
    await shot(page, `21-finder-${width}-${scheme}`);
    await noOverflow(page, `/gates ${width} ${scheme}`);
    await axe(page, `/gates ${width} ${scheme}`);
    await page.getByTestId('gate-open').click();
    await page.getByTestId('rules-card').waitFor({ timeout: 120_000 });
    log(page.url().endsWith(`/gates/${MINT}`), 'the finder opens the gate page for the pasted mint');
    await ctx.close();
  }
  {
    const { ctx, page } = await open(null);
    await page.goto(`${BASE}/gates/not-an-address`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('gate-invalid').waitFor({ timeout: 60_000 });
    log(true, 'a link with a malformed mint is refused with a message, not a crash');
    await ctx.close();
  }
} catch (e) {
  const alerts = lastPage ? await lastPage.locator('[role=alert]').allInnerTexts().catch(() => []) : [];
  if (lastPage) await lastPage.screenshot({ path: `${OUT}/failure.png`, fullPage: true }).catch(() => undefined);
  log(false, 'the flow ran to the end', `${e instanceof Error ? e.message : String(e)} | alerts on the page: ${JSON.stringify(alerts)} | page problems: ${problems.slice(0, 3).join(' || ')}`);
} finally {
  await browser.close();
  // On Windows the server is a child of a command shell: stop the whole tree, or it keeps the port and answers the next run.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill();
}

const bad = results.filter((r) => !r.ok);
log(problems.length === 0, 'no console errors, page errors or failed requests', problems.slice(0, 5).join(' || '));
writeFileSync(`${OUT}/results.json`, JSON.stringify({ mint: MINT, results, problems, evidence, attesterLog: attesterLog.slice(-2000) }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
process.exit(bad.length === 0 && problems.length === 0 ? 0 : 1);
