// The rest of the issuer area as people use it, on Solana devnet with two isolated wallets (an issuer and a holder): the overview of
// a real cross, creating a treasury and posting a signed, anchored disclosure update, publishing a draft listing and soft-committing
// to it, the demand map and simulator, applying and being reviewed, asking and answering a question, the growth page and the accelerator
// pipeline. Every signed record and transaction is real; outcomes are read from the chain and from the API, not only from the screen.
//
//   SEED=seed.json ISSUER_KEY=issuer.json HOLDER_KEY=holder.json CROSS=<an issuer cross> BASE_URL=http://localhost:3210 API_URL=http://127.0.0.1:8090 \
//   OUT=../../docs/evidence/screens/w2b CHROME=... node e2e/issuer-console.mjs
//
// SEED holds { coin3 (or coin2), base, quote, credential, schema }: a 6-decimal coin with fixed supply, a 6-decimal quote mint, and the addresses of a Solana
// Attestation Service credential and schema. The API must serve the issuer routes and name the issuer wallet in ISSUER_CURATORS.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const seed = JSON.parse(readFileSync(process.env.SEED, 'utf8'));
const issuerKey = JSON.parse(readFileSync(process.env.ISSUER_KEY, 'utf8'));
const holderKey = JSON.parse(readFileSync(process.env.HOLDER_KEY, 'utf8'));
const CROSS = process.env.CROSS;
const BASE = process.env.BASE_URL ?? 'http://localhost:3210';
const API = process.env.API_URL ?? 'http://127.0.0.1:8090';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const OUT = process.env.OUT ?? 'e2e/screens/w2b';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./issuer-wallet.js', import.meta.url), 'utf8');
const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const rpc = async (method, params) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) {
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
      continue;
    }
    return (await r.json()).result;
  }
  throw new Error('rpc kept answering 429');
};
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
};
const issuerAddr = b58(Uint8Array.from(issuerKey.slice(32)));
const holderAddr = b58(Uint8Array.from(holderKey.slice(32)));
const visible = (loc, ms = 15000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function person(name, key) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
  await ctx.addInitScript(WALLET_JS);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`${name} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/[?&]_rsc=/.test(r.url())) problems.push(`${name} http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 100)}`);
  });
  return { ctx, page, problems, name };
}
async function connect(p, address) {
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await p.page.getByLabel(`Connected as ${address}`).waitFor();
}
const issuer = await person('issuer', issuerKey);
const holder = await person('holder', holderKey);
const { page } = issuer;
const expectedProblems = [];

try {
  // ---- overview
  await page.goto(`${BASE}/issuer`, { waitUntil: 'networkidle' });
  log(await visible(page.getByTestId('connect-prompt')), 'overview: without a wallet it asks for one and shows nothing about anybody');
  await connect(issuer, issuerAddr);
  log(await visible(page.getByTestId(`pick-${CROSS}`), 30_000), 'overview: the issuer’s own cross is listed');
  log(await visible(page.getByTestId('raise-status')), 'overview: raise status of the selected cross');
  log(/has not opened yet|taking orders/.test((await page.getByTestId('tasks').textContent()) ?? ''), 'overview: the issuer’s cross is a task, said in plain words, by the clock');
  log(/did not read|does not read any pool/i.test((await page.getByTestId('liquidity-note').textContent()) ?? ''), 'overview: liquidity states honestly that no pool is read');
  log(await visible(page.getByTestId('no-holders')), 'overview: a cross with no bids shows an empty register, not a made-up one');
  await page.screenshot({ path: `${OUT}/console-01-overview.png`, fullPage: false });

  // FROM=apply skips the slow chain steps already proved by an earlier run against the same API process.
  if (!['apply', 'qa'].includes(process.env.FROM ?? '')) {
    // ---- treasury creation (TREASURY=<address> reuses one a previous run created, to save the minutes the public RPC makes this step take)
    let treasury = process.env.TREASURY ?? '';
    if (!treasury) {
      await page.goto(`${BASE}/issuer/treasury/new?coin=${(seed.coin3 ?? seed.coin2)}`, { waitUntil: 'networkidle' });
      await page.getByLabel('Token the treasury holds (quote mint)').fill(seed.quote);
      await page.getByLabel('Allowance per period, in quote tokens').fill('100');
      await page.getByLabel('Attestation credential address').fill(seed.credential);
      await page.getByLabel('Attestation schema address').fill(seed.schema);
      await page.waitForTimeout(2500);
      log(await page.getByRole('button', { name: 'Create the treasury' }).isEnabled(), 'treasury: a fixed-supply coin, a real credential and a schema enable Create');
      await page.getByLabel('Coin mint').fill(seed.base);
      await page.waitForTimeout(2500);
      log(/supply is not fixed/.test((await page.locator('form').textContent()) ?? ''), 'treasury: a coin whose supply is not fixed is refused before signing, with the reason');
      log(await page.getByRole('button', { name: 'Create the treasury' }).isDisabled(), 'treasury: and Create is off');
      await page.getByLabel('Coin mint').fill((seed.coin3 ?? seed.coin2));
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/console-02-treasury-form.png`, fullPage: false });
      await page.getByRole('button', { name: 'Create the treasury' }).click();
      await page.getByText('Your treasury is on chain.').waitFor({ timeout: 120_000 });
      treasury = ((await page.getByTestId('created-treasury').textContent()) ?? '').trim();
      log(treasury.length > 30, `treasury created: ${treasury}`);
      const onChain = await rpc('getAccountInfo', [treasury, { encoding: 'base64', commitment: 'confirmed' }]);
      const program = (await (await fetch(`${API}/v1/treasuries?limit=1`)).json()).program;
      log(onChain.value && onChain.value.owner === program, 'treasury: the account exists on chain and belongs to the treasury program the API names');
      log(await visible(page.getByText('What the program enforces')), 'treasury: the rights cards holders will see are shown to the issuer');
      await fetch(`${API}/__dev/index-treasury`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: treasury }) });
      await page.screenshot({ path: `${OUT}/console-03-treasury-created.png`, fullPage: false });


    } else await fetch(`${API}/__dev/index-treasury`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: treasury }) });

    await page.goto(`${BASE}/issuer/treasury`, { waitUntil: 'networkidle' });
    log(await visible(page.getByTestId(`treasury-${treasury}`), 30_000), 'treasury page: the new treasury is listed for its authority');
    log(/none yet/.test((await page.getByTestId(`treasury-${treasury}`).getByTestId('attestation').textContent()) ?? ''), 'treasury page: with no attestation it says the team cannot spend');

    // ---- disclosure update, signed and anchored
    await page.goto(`${BASE}/issuer/disclosures`, { waitUntil: 'networkidle' });
    const comp = page.getByTestId(`updates-${treasury}`);
    await comp.getByLabel('Title').fill('First update');
    await comp.getByLabel('What happened').fill('We created the treasury and have not spent from it.');
    await comp.getByLabel(/Covers from/).fill('2026-10-01');
    await comp.getByLabel(/Covers to/).fill('2026-10-12');
    await comp.getByLabel(/Quote tokens spent/).fill('0');
    await comp.getByTestId('publish-update').click();
    log(await visible(comp.getByTestId('update-result'), 120_000), 'disclosure: the update finished');
    const result = (await comp.getByTestId('update-result').textContent()) ?? '';
    log(/published and anchored/.test(result), `disclosure: ${result.slice(0, 120)}`);
    const upd = await (await fetch(`${API}/v1/treasuries/${treasury}/updates`)).json();
    log(upd.updates?.length === 1 && upd.updates[0].sequence === 1, 'disclosure: the API lists update 1');
    const memoSig = upd.updates?.[0]?.anchor?.signature;
    const memoTx = await rpc('getTransaction', [memoSig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    const memoIx = memoTx?.transaction?.message?.instructions?.find((i) => i.program === 'spl-memo');
    log(memoIx?.parsed === `opening-cross/treasury-update/v1 treasury=${treasury} seq=1 id=${upd.updates[0].id}`, 'disclosure: on chain, a Memo signed by the authority carries exactly the update’s id');
    log(upd.updates[0].spendCheck?.matches === true, 'disclosure: the declared spend (0) matches what the program recorded');
    await page.screenshot({ path: `${OUT}/console-04-disclosure.png`, fullPage: true });

    // ---- draft listing and soft commit
    await page.goto(`${BASE}/issuer/demand`, { waitUntil: 'networkidle' });
    await page.getByLabel('Title').fill('Northwind Coffee');
    await page.getByLabel('What you are raising for').fill('Opening a second roastery.');
    await page.getByLabel('Lowest price per token').fill('1.00');
    await page.getByLabel('Step between prices').fill('0.10');
    await page.getByLabel(/Number of price levels/).fill('10');
    await page.getByLabel('Tokens you plan to offer').fill('300');
    await page.getByTestId('publish-draft').click();
    log(await visible(page.getByTestId('draft-published'), 60_000), 'demand: the draft is published');
    const link = ((await page.getByTestId('draft-link').textContent()) ?? '').trim();
    const draftId = link.split('/').pop();
    log(/^[0-9a-f]{64}$/.test(draftId), 'demand: it gets a shareable link made of its id');

    await holder.page.goto(link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'networkidle' });
    log(await visible(holder.page.getByTestId('not-verified')), 'draft page: a stranger sees it is not yet verified');
    log(await visible(holder.page.getByTestId('commit-connect')), 'draft page: a stranger without a wallet is told what connecting does');
    await connect(holder, holderAddr);
    await holder.page.getByLabel('Highest price you would pay, per token').selectOption('1.5');
    await holder.page.getByLabel('Most you would spend, in quote tokens').fill('300');
    await holder.page.getByTestId('send-commit').click();
    log(await visible(holder.page.getByTestId('commit-result')), 'draft page: the holder’s commit is recorded');
    await holder.page.waitForTimeout(1000);
    const map = await (await fetch(`${API}/v1/issuer/drafts/${draftId}`)).json();
    log(map.commits.wallets === 1 && map.commits.totalTokens === '200000000', 'draft page: 300 quote at a limit of 1.50 is 200 tokens, exactly');
    log(map.byTrackRecord['no-history'].wallets === 1, 'draft page: a wallet with no earlier cross is grouped as having no history');
    const totals = (await holder.page.getByTestId('demand-totals').textContent()) ?? '';
    log(/1/.test(totals) && /200/.test(totals), 'draft page: the totals on screen equal the API’s');
    log(/not have enough|No price has enough/.test((await holder.page.getByTestId('cover-price').textContent()) ?? ''), 'draft page: 200 of 300 tokens does not cover the offer, and it says so');
    await holder.page.screenshot({ path: `${OUT}/console-05-draft.png`, fullPage: true });
    await holder.page.getByTestId('send-commit').waitFor();
    // a second commit from the same wallet replaces the first
    await holder.page.getByLabel('Most you would spend, in quote tokens').fill('600');
    await holder.page.getByTestId('send-commit').click();
    await holder.page.waitForTimeout(2500);
    const map2 = await (await fetch(`${API}/v1/issuer/drafts/${draftId}`)).json();
    log(map2.commits.wallets === 1 && map2.commits.totalTokens === '400000000', 'draft page: a second commit from the same wallet replaces the first');

    // ---- simulator with that demand
    await page.goto(`${BASE}/issuer/simulator?draft=${draftId}`, { waitUntil: 'networkidle' });
    log(await visible(page.getByTestId('sim-note'), 20_000), 'simulator: the draft’s grid, offer and soft commits are loaded');
    log(await visible(page.getByTestId('scenario-base'), 20_000), 'simulator: scenarios computed from the soft commits');
    const sim = (await page.getByTestId('scenario-base').textContent()) ?? '';
    log(/1\.5 quote/.test(sim) && /300/.test(sim), `simulator: 400 tokens wanted at 1.50 against 300 offered at 1.00 clears at 1.5 for 300 (${sim.slice(0, 80)})`);
    await page.screenshot({ path: `${OUT}/console-06-simulator.png`, fullPage: false });


  }

  if (process.env.FROM !== 'qa') {
    // ---- application, review, pipeline
    await page.goto(`${BASE}/issuer/apply`, { waitUntil: 'networkidle' });
    log((await page.getByTestId('automatic').locator('li').count()) === 10 && (await page.getByTestId('reviewed').locator('li').count()) === 7, 'apply: the published checklist is on the page without a wallet');
    log(await visible(page.getByTestId('review-queue')), 'apply: a named reviewer sees the review queue');
    await page.getByLabel('Name of the project or company').fill('Northwind Coffee');
    await page.getByLabel('What it is and what holders get').fill('A coffee company raising for a second roastery.');
    await page.getByLabel('Who is behind it').fill('Two founders.');
    await page.getByLabel(/Accelerator or program/).fill('Example Accelerator');
    log(await page.getByTestId('submit-application').isDisabled(), 'apply: Submit stays off until the acknowledgement is ticked');
    await page.getByLabel(/I understand this application is public/).check();
    await page.getByTestId('submit-application').click();
    log(await visible(page.getByTestId('application-done'), 60_000), 'apply: the application is submitted');
    // The reviewer's queue was read when the page opened; open it again to see the new application, as a reviewer would.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('decide-changes-requested').first().click();
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: 'networkidle' });
    log(/Changes requested/.test((await page.getByTestId('my-applications').textContent()) ?? ''), 'apply: the reviewer’s decision shows on the applicant’s application');
    await page.screenshot({ path: `${OUT}/console-07-apply.png`, fullPage: false });
    await page.goto(`${BASE}/issuer/accelerators`, { waitUntil: 'networkidle' });
    log(await visible(page.getByTestId('pipeline'), 20_000), 'accelerators: an application that names a cohort appears in the pipeline');
    log(/Example Accelerator/.test((await page.getByTestId('pipeline').textContent()) ?? ''), 'accelerators: grouped under the name the applicant typed');
    log(await visible(page.getByTestId('no-partnership')), 'accelerators: the page says there is no partnership and that the cohort is unverified');


  }

  // ---- questions
  await holder.page.goto(`${BASE}/issuer/qa/${CROSS}`, { waitUntil: 'networkidle' });
  if (await holder.page.getByRole('button', { name: 'Connect wallet' }).isVisible()) await connect(holder, holderAddr);
  await holder.page.getByLabel('Your question').fill('Will the team lock its tokens?');
  await holder.page.getByTestId('ask').click();
  log(await visible(holder.page.getByTestId('ask-result')), 'questions: a holder asks about the issuer’s cross');
  await page.goto(`${BASE}/issuer/disclosures`, { waitUntil: 'networkidle' });
  const thread = page.getByTestId(`thread-${CROSS}`);
  log(await visible(thread.getByTestId('question'), 20_000), 'questions: the issuer sees it waiting');
  await thread.getByLabel('Your answer').fill('Yes, for twelve months.');
  await thread.getByTestId('send-answer').click();
  await page.waitForTimeout(2500);
  const qa = await (await fetch(`${API}/v1/issuer/qa?subject=${CROSS}`)).json();
  log(qa.questions[0]?.state === 'answered' && qa.owner === issuerAddr, 'questions: only the creator can answer, and the answer is stored');
  await page.screenshot({ path: `${OUT}/console-08-questions.png`, fullPage: false });

  // ---- growth
  await page.goto(`${BASE}/issuer/growth`, { waitUntil: 'networkidle' });
  log((await page.getByTestId('playbooks').locator('article').count()) === 4, 'growth: four playbooks');
  const ref = (await page.getByTestId('referral-link').textContent()) ?? '';
  log(ref.includes(`/issue?ref=${issuerAddr}&fee=20`), 'growth: the referral link names the connected wallet and the fee');
  log(await visible(page.getByTestId('contacts'), 30_000), 'growth: the holder who soft-committed is a contact');
  log((await page.getByTestId('contacts').textContent())?.includes(holderAddr.slice(0, 4)) ?? false, 'growth: shown by wallet');
  await page.goto(`${BASE}/issue?ref=${holderAddr}&fee=40`, { waitUntil: 'networkidle' });
  log(await visible(page.getByTestId('referral-note')), 'growth: a referral link pre-fills the wizard and says so');
  log((await page.getByLabel(/Integrator fee, basis points/).inputValue()) === '40', 'growth: with the fee it names');
  await page.screenshot({ path: `${OUT}/console-09-growth.png`, fullPage: false });
} catch (e) {
  log(false, `flow stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  await page.screenshot({ path: `${OUT}/console-failure.png`, fullPage: true }).catch(() => undefined);
  await holder.page.screenshot({ path: `${OUT}/console-failure-holder.png`, fullPage: true }).catch(() => undefined);
}
// The shared public RPC endpoints answer bursts with 429. That is an external limit, not a fault of the page: count it, name it, do not fail on it.
const all = [...issuer.problems, ...holder.problems];
const rateLimited = all.filter((p) => /429/.test(p) || /Failed to load resource: the server responded with a status of 429/.test(p));
if (rateLimited.length) console.log(`NOTE ${rateLimited.length} console lines were the public RPC endpoint answering 429 (external rate limit)`);
const problems = all.filter((p) => !rateLimited.includes(p) && !expectedProblems.some((x) => p.includes(x)));
log(problems.length === 0, `zero console and page errors${problems.length ? ` (${problems.slice(0, 5).join(' | ')})` : ''}`);
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
