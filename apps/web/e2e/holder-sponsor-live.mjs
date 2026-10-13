// A wallet with tokens and NO SOL places an order on real devnet because Opening Bell sponsors the fee and the order deposit, and the
// holder-side views of an open cross are read as they would be by a person: the readiness checklist, the coarse final window, the
// order's price on the chart from the chain, and the bid-from-a-link transaction.
//
//   BASE_URL=http://localhost:3412 HARNESS=http://127.0.0.1:8082 node e2e/holder-sponsor-live.mjs
// Needs: the harness started with SPONSOR_KEYPAIR (.keys/holder-sponsor.json), .keys/holder-nosol.json holding quote tokens and no SOL,
// and live-buyer.json holding SOL and the base token (it opens the cross and sells into it).
import { execFileSync } from 'node:child_process';
import { BASE, axe, check, clickUntil, connect, keyFile, launch, person, report, results, shot, sleep } from './holder-lib.mjs';

const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const HARNESS = process.env.HARNESS ?? 'http://127.0.0.1:8082';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const QUOTE_MINT = 'B78M2HhTHtR2wF3oxR4ikkBupc5TgtBbQbukYXwJEizm';
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
const lamports = async (a) => BigInt((await rpc('getBalance', [a, { commitment: 'confirmed' }])).value);
const quote = async (a) => ((await rpc('getTokenAccountsByOwner', [a, { mint: QUOTE_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value ?? []).reduce((s, x) => s + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);

const sponsorInfo = await (await fetch(`${HARNESS}/v1/sponsor`)).json();
check(sponsorInfo.enabled === true, `the sponsor is on (${sponsorInfo.sponsor})`);

const cross = process.env.CROSS ?? lastLine(execFileSync('node', ['e2e/holder-create-cross.mjs'], { encoding: 'utf8', env: { ...process.env, KEY_FILE: 'live-buyer.json', OPEN_IN: '45', OPEN_FOR: '780' } }));
check(cross.length > 30, `cross open on devnet: ${cross}`);
const detail = await (await fetch(`${API}/v1/crosses/${cross}`)).json();
const openTs = Number(detail.window.openTs);
const closeTs = Number(detail.window.closeTs);

const browser = await launch();
const noise = ['status of 429', ' 429 https://', '/v1/issuer/protocol'];
const nosol = await person(browser, { name: 'wallet without SOL', secret: keyFile('holder-nosol.json'), ignore: noise });
const buyer = await person(browser, { name: 'seller', secret: keyFile('live-buyer.json'), theme: 'dark', viewport: { width: 390, height: 844 }, ignore: noise });
try {
  while (Date.now() / 1000 < openTs + 5) await sleep(3000);
  const solBefore = await lamports(nosol.address);
  const sponsorBefore = await lamports(sponsorInfo.sponsor);
  const quoteBefore = await quote(nosol.address);
  check(solBefore === 0n && quoteBefore >= 2_400_000n, `before: ${solBefore} lamports and ${quoteBefore} quote atoms in the wallet`);

  // ---- the wallet without SOL: readiness, then a sponsored order
  const p = nosol.page;
  await p.goto(`${BASE}/crosses/${cross}`, { waitUntil: 'domcontentloaded' });
  await connect(nosol);
  await p.getByTestId('readiness').waitFor({ timeout: 90_000 });
  await p.getByTestId('readiness').getByText(/Opening Bell can pay the network fee/).waitFor({ timeout: 60_000 });
  check(true, 'readiness: no SOL is reported, with the sponsor offered as the way through');
  await p.getByTestId('readiness').getByText(/You hold [\d.]+ of the quote token/).first().waitFor({ timeout: 60_000 });
  check(true, 'readiness: the quote token balance is read from the chain');
  await shot(nosol, 'readiness-sponsor-1440-light');
  await p.getByTestId('sponsor-choice').waitFor({ timeout: 60_000 });
  check((await p.getByTestId('sponsor-choice').innerText()).includes('Let Opening Bell pay the fee'), 'ticket: the sponsor choice is shown and on');
  await p.getByLabel(/per token/).fill('1.20');
  await p.getByRole('textbox', { name: 'Tokens', exact: true }).fill('2');
  const ack = p.getByRole('checkbox', { name: /understand the risks/ });
  const place = p.getByRole('button', { name: 'Place order' });
  for (let i = 0; i < 8 && (await ack.isVisible().catch(() => false)) && !(await place.isEnabled()); i++) {
    await ack.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(1000);
  }
  await place.click();
  await p.getByText('Order placed.').waitFor({ timeout: 120_000 });
  check(true, 'a wallet with no SOL placed an order; the wallet signed a transaction the sponsor had already signed as fee payer');
  await sleep(3000);
  const solAfter = await lamports(nosol.address);
  const sponsorAfter = await lamports(sponsorInfo.sponsor);
  const quoteAfter = await quote(nosol.address);
  console.log(`  wallet SOL ${solBefore} -> ${solAfter}; sponsor ${sponsorBefore} -> ${sponsorAfter}; wallet quote ${quoteBefore} -> ${quoteAfter}`);
  check(quoteBefore - quoteAfter === 2_400_000n, 'on chain: 2.4 quote moved into escrow from the wallet');
  check(sponsorBefore - sponsorAfter >= 1_000_000n, `on chain: the sponsor paid (${sponsorBefore - sponsorAfter} lamports: the order deposit and the fee)`);
  check(solAfter < 1_000_000n, `on chain: the wallet kept nothing it did not need (${solAfter} lamports after the deposit)`);
  const dec = await (await fetch(`${HARNESS}/v1/sponsor`)).json();
  check(BigInt(dec.spentTodayLamports) >= 1_000_000n, 'the sponsor reports what it spent today');

  // ---- the seller makes the book cross; the final window turns coarse; the order's price is on the chart from the chain
  const b = buyer.page;
  await b.goto(`${BASE}/crosses/${cross}`, { waitUntil: 'domcontentloaded' });
  await connect(buyer);
  await b.getByLabel(/per token/).waitFor({ timeout: 90_000 });
  await b.locator('label').filter({ hasText: /^sell$/i }).first().click();
  await b.getByLabel(/per token/).fill('1.20');
  await b.getByRole('textbox', { name: 'Tokens', exact: true }).fill('2');
  const ack2 = b.getByRole('checkbox', { name: /understand the risks/ });
  const place2 = b.getByRole('button', { name: 'Place order' });
  for (let i = 0; i < 8 && (await ack2.isVisible().catch(() => false)) && !(await place2.isEnabled()); i++) {
    await ack2.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(1000);
  }
  await place2.click();
  await b.getByText('Order placed.').waitFor({ timeout: 120_000 });
  check(true, 'the seller placed 2 tokens at 1.20, so the book crosses');

  await p.reload({ waitUntil: 'domcontentloaded' });
  await connect(nosol);
  await p.getByRole('tab', { name: 'Book' }).click();
  await p.locator('[data-mine]').first().waitFor({ timeout: 60_000 });
  check((await p.locator('[data-mine]').first().innerText()).includes('1.2'), 'the chart marks the wallet’s own order at 1.2, its price read from the chain');
  await shot(nosol, 'book-own-order-1440-light');

  while (Date.now() / 1000 < closeTs - 185) await sleep(3000);
  await p.getByRole('tab', { name: 'Overview' }).click();
  await p.getByTestId('coarse-price').waitFor({ timeout: 90_000 });
  const coarse = await p.getByTestId('coarse-price').innerText();
  check(/about 1\.\d+ to 1\.\d+/.test(coarse), `final window: the price is shown as a range (${coarse})`);
  check((await p.getByTestId('final-window').innerText()).includes('display choice only'), 'final window: the notice says this is display only');
  await shot(nosol, 'final-window-coarse-1440-light');
  await clickUntil(p, p.getByRole('button', { name: 'Show exact figures' }), p.getByRole('button', { name: 'Round the figures' }));
  check((await p.getByTestId('price').innerText()).trim() === '1.2', 'final window: Show exact figures gives the exact price');
  check((await axe(nosol)).length === 0, 'cross page in its final window: axe clean');
  await shot(buyer, 'cross-390-dark');
  // The same cross as a blink: the endpoint builds the order transaction for any wallet.
  const r = await fetch(`${HARNESS}/v1/actions/crosses/${cross}/bid?price=1.30&quantity=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: nosol.address }) });
  const body = await r.json();
  check(r.status === 200 && body.type === 'transaction' && /Bid for 1 tokens at up to 1.3/.test(body.message), `blink: the action endpoint built a bid transaction (${body.message?.slice(0, 60)})`);
} catch (e) {
  check(false, `run failed: ${e}`);
  await shot(nosol, 'sponsor-error').catch(() => undefined);
}
report(nosol);
report(buyer);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
