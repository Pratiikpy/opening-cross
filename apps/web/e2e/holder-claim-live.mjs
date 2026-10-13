// The claim center with TWO orders to claim, on real devnet through the browser: one wallet opens an escrow cross from the issuer console,
// places a buy and a sell at the same price so the cross prints, settles it from the cross page, and the claim center on /orders lists both
// orders and pays them out with Claim all (two wallet signatures, one transaction each). Balances are read from the chain before and after.
//
//   BASE_URL=http://localhost:3412 KEY_FILE=live-buyer.json node e2e/holder-claim-live.mjs
//
// Costs about 0.17 SOL of devnet rent for the cross. The key is a Solana CLI keypair file under .keys, read only here and never printed.
import { execFileSync } from 'node:child_process';
import { BASE, axe, check, clickUntil, connect, keyFile, launch, person, report, results, shot, sleep } from './holder-lib.mjs';

const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const BASE_MINT = process.env.BASE_MINT ?? 'HV2P22LJPewKomy7aN4CV1dTd2Dwpsi6Ta76fDAJFXQc';
const QUOTE_MINT = process.env.QUOTE_MINT ?? 'B78M2HhTHtR2wF3oxR4ikkBupc5TgtBbQbukYXwJEizm';

const lastLine = (t) => t.trim().split(String.fromCharCode(10)).pop().trim();
const rpc = async (method, params) => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    return (await r.json()).result;
  }
  throw new Error('rpc kept answering 429');
};
const balance = async (owner, mint) => ((await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value ?? []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);

const browser = await launch();
const u = await person(browser, { name: 'claimant', secret: keyFile(process.env.KEY_FILE ?? 'live-buyer.json'), ignore: ['status of 429', ' 429 https://', '/v1/issuer/protocol', 'status of 404'] });
const page = u.page;
const owner = u.address;
let cross = null;
try {
  // ---- 1. open an escrow cross (built by the API and signed with the wallet's key: the issuer console is not what this run tests)
  cross = process.env.CROSS ?? lastLine(execFileSync('node', ['e2e/holder-create-cross.mjs'], { encoding: 'utf8', env: { ...process.env, KEY_FILE: process.env.KEY_FILE ?? 'live-buyer.json' } }));
  check(cross.length > 30, `cross created on devnet: ${cross}`);
  const detail = await (await fetch(`${API}/v1/crosses/${cross}`)).json();
  const openTs = Number(detail.window.openTs);
  const closeTs = Number(detail.window.closeTs);

  // ---- 2. one buy and one sell at the same price, so the cross prints
  // With SKIP_ORDERS the two orders (3 tokens sold, 3.6 quote bid) are already in escrow, so the balances before them are rebuilt from that.
  const baseBefore = (await balance(owner, BASE_MINT)) + (process.env.SKIP_ORDERS ? 3_000_000n : 0n);
  const quoteBefore = (await balance(owner, QUOTE_MINT)) + (process.env.SKIP_ORDERS ? 3_600_000n : 0n);
  if (!process.env.SKIP_ORDERS) {
  while (Date.now() / 1000 < openTs + 5) await sleep(3000);
  await page.goto(`${BASE}/crosses/${cross}`, { waitUntil: 'domcontentloaded' });
  await connect(u);
  await page.getByLabel(/per token/).waitFor({ timeout: 90_000 });
  const place = async (side) => {
    await page.locator('label').filter({ hasText: new RegExp(`^${side}$`, 'i') }).first().click();
    await page.getByLabel(/per token/).fill('1.20');
    await page.getByRole('textbox', { name: 'Tokens', exact: true }).fill('3');
    const ack = page.getByRole('checkbox', { name: /understand the risks/ });
    const placeBtn = page.getByRole('button', { name: 'Place order' });
    // A tick before the page has hydrated does nothing, as for a person: tick again until the order can be placed.
    for (let i = 0; i < 8 && (await ack.isVisible().catch(() => false)) && !(await placeBtn.isEnabled()); i++) {
      await ack.click({ timeout: 5000 }).catch(() => undefined);
      await sleep(1000);
    }
    await placeBtn.click();
    await page.getByText('Order placed.').waitFor({ timeout: 120_000 });
  };
  await place('buy');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connect(u);
  await page.getByLabel(/per token/).waitFor();
  await place('sell');
  check(true, 'a buy and a sell of 3 tokens at 1.20 were placed from the cross page');

  }
  // ---- 3. the call closes; settle it
  while (Date.now() / 1000 < closeTs + 5) await sleep(3000);
  await page.goto(`${BASE}/crosses/${cross}`, { waitUntil: 'domcontentloaded' });
  await connect(u);
  await page.getByRole('button', { name: 'Settle this cross' }).waitFor({ timeout: 90_000 });
  await clickUntil(page, page.getByRole('button', { name: 'Settle this cross' }), page.getByText(/Settling|Waiting for your wallet|Sending|Confirming/).first(), { tries: 4, each: 8000 });
  let after;
  for (let i = 0; i < 90; i++) {
    after = await (await fetch(`${API}/v1/crosses/${cross}`)).json();
    if (after.state !== 'Live') break;
    await sleep(2000);
  }
  check(after.state === 'Cleared' && after.clearing?.price, `the cross settled and printed (${after.state}, price ${after.clearing?.price}, matched ${after.clearing?.matched})`);

  // ---- 4. the claim center: two orders, Claim all
  await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await connect(u);
  await page.getByTestId('claim-list').waitFor({ timeout: 180_000 });
  const rows = page.getByTestId('claim-row');
  const n = await rows.count();
  check(n >= 2, `the claim center lists ${n} orders to claim`);
  await shot(u, 'claim-center-before-1440-light');
  const sigBefore = await page.evaluate(() => window.__E2E_SIGNED__ ?? 0);
  await page.getByRole('button', { name: /Claim all/ }).click();
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="claim-row"][data-phase="done"]').length >= k, Math.min(n, 2), { timeout: 240_000 });
  const signed = (await page.evaluate(() => window.__E2E_SIGNED__ ?? 0)) - sigBefore;
  check(signed >= 2, `Claim all asked the wallet to sign ${signed} claim transactions, one per order`);
  await shot(u, 'claim-center-after-1440-light');

  // ---- 5. what the chain says
  const detailRows = (await (await fetch(`${API}/v1/crosses/${cross}/orders`)).json()).orders;
  await sleep(2000);
  const baseAfter = await balance(owner, BASE_MINT);
  const quoteAfter = await balance(owner, QUOTE_MINT);
  console.log(`  base before ${baseBefore} after ${baseAfter}; quote before ${quoteBefore} after ${quoteAfter}; orders ${JSON.stringify(detailRows.map((o) => [o.side, o.status]))}`);
  check(baseAfter === baseBefore, 'on chain: the wallet holds the same number of tokens (it bought 3 from itself and sold 3 to itself)');
  check(quoteBefore - quoteAfter >= 0n && quoteBefore - quoteAfter < 100_000n, `on chain: the quote token is down only by the seller fee (${quoteBefore - quoteAfter} atoms)`);
  const v = await axe(u);
  check(v.length === 0, `orders page after claiming: axe clean ${JSON.stringify(v).slice(0, 300)}`);
} catch (e) {
  check(false, `run failed: ${e}`);
  await shot(u, 'claim-error').catch(() => undefined);
}
report(u);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
