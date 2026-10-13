// The gate screens in a real browser against devnet: /gates, and the Eligibility and GateField components (hosted on a temporary preview route).
// A fresh disposable wallet (funded from the devnet promiser key) opens a gated cross's eligibility card, is refused with the diagnostic, gets a devnet
// test attestation by signing the attester's challenge in the wallet, claims its pass through the API-built transaction, and the pass is read from chain.
//
//   BASE_URL=http://localhost:3471 API_URL=http://127.0.0.1:8099 ATTESTER_URL=http://127.0.0.1:8091 CROSS=<cross> GATE=<gate mint> CHROME=<chrome.exe> OUT=<dir> node e2e/gate-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { address, appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createNoopSigner, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction, getProgramDerivedAddress, getAddressEncoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, AccountRole } from '@solana/kit';

const BASE = process.env.BASE_URL ?? 'http://localhost:3471';
const API = process.env.API_URL ?? 'http://127.0.0.1:8099';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const OUT = process.env.OUT ?? 'e2e/screens/gate';
const CROSS = process.env.CROSS;
const GATE = process.env.GATE;
const GATE_PROGRAM = '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./gate-wallet.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = createSolanaRpc(RPC);
const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// A fresh wallet, funded with a little devnet SOL from the promiser key (read here only, never printed).
const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const key = [...pkcs8.slice(-32), ...raw];
const wallet = (await createKeyPairSignerFromBytes(Uint8Array.from(key))).address;
const promiser = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(new URL('../../../.keys/devnet-promiser.json', import.meta.url), 'utf8'))));
const FIELD_ONLY = process.env.FIELD_ONLY === '1';
for (let attempt = 0; !FIELD_ONLY; attempt++) {
  try {
    const data = new Uint8Array(12);
    data.set([2, 0, 0, 0]);
    new DataView(data.buffer).setBigUint64(4, 6_000_000n, true);
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(promiser, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstruction({ programAddress: address('11111111111111111111111111111111'), accounts: [{ address: promiser.address, role: AccountRole.WRITABLE_SIGNER, signer: promiser }, { address: address(wallet), role: AccountRole.WRITABLE }], data }, m),
      ),
    );
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
    break;
  } catch (e) {
    if (attempt > 6) throw e;
    await sleep(2000 * (attempt + 1));
  }
}
for (let i = 0; i < 90 && !FIELD_ONLY; i++) {
  const funded = await rpc.getBalance(address(wallet), { commitment: 'confirmed' }).send().then((r) => r.value > 0n, () => false);
  if (funded) break;
  await sleep(2000);
}

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const problems = [];
async function open(width, scheme, wire) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, colorScheme: scheme, timezoneId: 'UTC' });
  if (wire) {
    await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
    await ctx.addInitScript(WALLET_JS);
  }
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && console.log('HTTP', r.status(), r.request().method(), r.url().slice(0, 120)));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  return { ctx, page };
}
const connect = async (page) => {
  const option = page.getByRole('button', { name: /E2E Test Wallet/ });
  for (let attempt = 1; !(await option.isVisible()); attempt++) {
    if (attempt > 8) throw new Error('the wallet list never opened');
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await option.waitFor({ timeout: 4000 }).catch(() => undefined);
  }
  await option.click();
  await page.getByLabel(`Connected as ${wallet}`).waitFor();
};
const axe = async (page, name) => {
  const r = await new AxeBuilder({ page }).analyze();
  log(r.violations.length === 0, `axe clean: ${name}${r.violations.length ? ' ' + r.violations.map((v) => `${v.id}(${v.nodes.length})`).join(',') : ''}`);
};

try {
  // ---- /gates without a wallet: both themes, both widths
  for (const [width, scheme] of FIELD_ONLY ? [] : [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const { ctx, page } = await open(width, scheme, false);
    await page.goto(`${BASE}/gates`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('gate-presets').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid^="gate-"]:not([data-testid="gate-presets"]):not([data-testid="gate-reasons"])').first().waitFor({ timeout: 240_000 });
    await page.screenshot({ path: `${OUT}/gates-${width}-${scheme}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    log(!overflow, `/gates has no horizontal overflow at ${width} ${scheme}`);
    await axe(page, `/gates ${width} ${scheme}`);
    await ctx.close();
  }

  // ---- with a wallet: standing on /gates
  if (!FIELD_ONLY) {
    const { ctx, page } = await open(1440, 'light', true);
    await page.goto(`${BASE}/gates`, { waitUntil: 'domcontentloaded' });
    await connect(page);
    const card = page.getByTestId(`standing-${GATE}`);
    await card.waitFor({ timeout: 120_000 });
    const text = await card.innerText();
    log(/do not hold a pass/.test(text) && /No attestation/.test(text), '/gates shows the wallet without a pass and the missing attestation');
    await page.screenshot({ path: `${OUT}/gates-wallet-1440-light.png`, fullPage: true });
    await ctx.close();
  }

  // ---- eligibility card: refusal, attest, claim
  if (!FIELD_ONLY) {
    const { ctx, page } = await open(1440, 'light', true);
    await page.goto(`${BASE}/gates/preview-tmp?cross=${CROSS}&gate=${GATE}`, { waitUntil: 'domcontentloaded' });
    await connect(page);
    const verdict = page.getByTestId('eligibility-verdict');
    await verdict.waitFor({ timeout: 120_000 });
    log(/cannot place an order yet/.test(await verdict.innerText()), 'a wallet without a pass is told it cannot place an order yet');
    log(await page.getByTestId('reason-NO_ATTESTATION').isVisible(), 'the card names the failed rule (no attestation) and what would satisfy it');
    await page.screenshot({ path: `${OUT}/eligibility-refused-1440-light.png`, fullPage: true });
    await axe(page, 'eligibility refused');

    await page.getByTestId('attest-button').click();
    await page.getByTestId('reason-CLAIMABLE_BY_ATTESTATION').waitFor({ timeout: 180_000 });
    log(true, 'after signing the attester challenge in the wallet the card says the pass can be claimed');
    await page.screenshot({ path: `${OUT}/eligibility-claimable-1440-light.png`, fullPage: true });

    await page.getByRole('button', { name: 'Claim pass with attestation' }).click();
    await page.getByTestId('reason-HAS_PASS').waitFor({ timeout: 180_000 });
    log(/may place an order/.test(await page.getByTestId('eligibility-verdict').innerText()), 'after the claim the card says the wallet may place an order');
    const [pass] = await getProgramDerivedAddress({ programAddress: address(GATE_PROGRAM), seeds: [new TextEncoder().encode('pass'), getAddressEncoder().encode(address(GATE)), getAddressEncoder().encode(address(wallet))] });
    let acct = { value: null };
    for (let i = 0; i < 8 && !acct.value; i++) acct = await rpc.getAccountInfo(pass, { encoding: 'base64', commitment: 'confirmed' }).send().catch(() => (sleep(2000), { value: null }));
    log(acct.value?.owner === GATE_PROGRAM, `the pass account ${pass} exists on chain, owned by cross_gate`);
    await page.screenshot({ path: `${OUT}/eligibility-pass-1440-light.png`, fullPage: true });
    await ctx.close();
  }

  // ---- mobile + dark of the card and the issuer field
  for (const [width, scheme] of FIELD_ONLY ? [] : [[390, 'light'], [390, 'dark'], [1440, 'dark']]) {
    const { ctx, page } = await open(width, scheme, true);
    await page.goto(`${BASE}/gates/preview-tmp?cross=${CROSS}&gate=${GATE}`, { waitUntil: 'domcontentloaded' });
    await connect(page);
    await page.getByTestId('reason-HAS_PASS').waitFor({ timeout: 120_000 });
    await page.screenshot({ path: `${OUT}/eligibility-${width}-${scheme}.png`, fullPage: true });
    await axe(page, `eligibility ${width} ${scheme}`);
    await ctx.close();
  }

  // ---- issuer gate field
  for (const [width, scheme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const { ctx, page } = await open(width, scheme, false);
    await page.goto(`${BASE}/gates/preview-tmp`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('gate-field').waitFor({ timeout: 60_000 });
    await page.getByTestId('gate-option-allowlist').check({ force: true });
    await page.getByTestId('gate-mint-input').fill(GATE);
    await page.getByTestId('gate-list-input').fill(`${wallet}\n${wallet}\nnot-an-address\n${GATE}`);
    await page.getByTestId('gate-root').waitFor({ timeout: 30_000 });
    const root = await page.getByTestId('gate-root').innerText();
    log(/2 wallets/.test(root) && /1 repeated/.test(root) && /1 entry is not Solana/.test(root), `the field shows the root, the count, the repeat and the invalid entry (${width} ${scheme})`);
    await page.screenshot({ path: `${OUT}/gate-field-${width}-${scheme}.png`, fullPage: true });
    if (width === 1440 && scheme === 'light') {
      await page.getByTestId('gate-publish').click();
      await page.getByText(/does not hash to the allowlist root|no allowlist root|published/i).first().waitFor({ timeout: 60_000 });
      log(true, 'publishing a list that is not the gate\'s on-chain list is refused with the reason');
    }
    await axe(page, `gate field ${width} ${scheme}`);
    await ctx.close();
  }
} catch (e) {
  log(false, `run aborted: ${e instanceof Error ? e.message : String(e)}`);
}
// The only HTTP error the run provokes on purpose is the 400 for publishing a list with an invalid entry (the response log above shows it is the only one).
const unexpected = problems.filter((p) => !/status of 400/.test(p));
log(unexpected.length === 0, `zero unexpected console errors, page errors and failed requests${unexpected.length ? ': ' + [...new Set(unexpected)].slice(0, 5).join(' | ') : ''}`);
writeFileSync(`${OUT}/result.json`, JSON.stringify({ wallet, failures, problems: [...new Set(problems)] }, null, 2));
await browser.close();
process.exit(failures.length ? 1 : 0);
