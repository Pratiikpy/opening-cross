// ROADMAP W3: the investor flow, driven as two real users in two isolated browsers against a local
// validator running the current programs. Every transaction is built by the API, signed by a
// Wallet Standard wallet in the page, sent and confirmed on chain. Outcomes are checked against
// the chain itself (token balances), not only the screen.
//
//   SEED=/tmp/oc-e2e.json BASE_URL=http://localhost:3000 OUT=../../docs/evidence/screens/w3 node e2e/investor-flow.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const seed = JSON.parse(readFileSync(process.env.SEED ?? '/tmp/oc-e2e.json', 'utf8'));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.OUT ?? 'e2e/screens/w3';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');
const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function rpc(method, params) {
  const r = await fetch(seed.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}
async function chainNow() {
  return BigInt(await rpc('getBlockTime', [await rpc('getSlot', [])]));
}
async function waitChain(ts) {
  for (;;) {
    if ((await chainNow()) >= BigInt(ts)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
/** Sum of the owner's token balance for a mint, read from chain. */
async function balance(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return (r?.value ?? []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}
async function crossAccount(address) {
  return (await fetch(`http://localhost:8080/v1/crosses/${address}`)).json();
}

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function user(name, key, theme = 'light', viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, acceptDownloads: true, deviceScaleFactor: Number(process.env.DSF ?? 1) });
  await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key.secret, chain: 'solana:localnet' })};`);
  await ctx.addInitScript(WALLET_JS);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  return { ctx, page, problems, name, address: key.address };
}
async function shot(u, label) {
  await u.page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
}
async function connect(u) {
  await u.page.getByRole('button', { name: 'Connect wallet' }).click();
  await u.page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await u.page.getByLabel(`Connected as ${u.address}`).waitFor();
}
async function openCross(u, address) {
  // The cross page streams live updates, so the network never goes idle; wait for the content.
  await u.page.goto(`${BASE}/crosses/${address}`, { waitUntil: 'domcontentloaded' });
  await u.page.getByRole('heading', { level: 1 }).waitFor();
  await u.page.getByTestId('countdown').or(u.page.getByTestId('price')).first().waitFor();
}
// Before a wallet's first order on this device the ticket asks it to accept the risks: one checkbox, once per wallet.
async function acceptRisks(u) {
  const box = u.page.getByRole('checkbox', { name: /understand the risks/ });
  await box.waitFor({ timeout: 4000 }).catch(() => undefined);
  // Accepting replaces the checkbox with a confirmation line, so click it (check() would wait for a state of an element that is gone).
  if (await box.isVisible()) {
    await box.click();
    await u.page.getByText(/You accepted the risks/).waitFor();
  }
}
async function place(u, price, qty) {
  await u.page.getByLabel(/per token/).fill(price);
  await u.page.getByLabel('Tokens').fill(qty);
  await acceptRisks(u);
  await u.page.getByRole('button', { name: /Place (sealed )?order/ }).click();
  await u.page.getByText('Order placed.').waitFor({ timeout: 60_000 });
}
async function orderStatuses(u) {
  await u.page.waitForTimeout(1500);
  return u.page.getByTestId('order-status').allTextContents();
}

const A = await user('buyer', seed.wallets.buyer);
const B = await user('buyer2', seed.wallets.buyer2, 'dark', { width: 390, height: 844 });
try {
  await flow();
} catch (e) {
  log(false, `flow stopped: ${e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : String(e)}`);
  for (const u of [A, B]) await shot(u, `failure-${u.name}`).catch(() => undefined);
  for (const u of [A, B]) {
    const alerts = await u.page.getByRole('alert').allTextContents().catch(() => []);
    if (alerts.length) console.log(`  ${u.name} alerts: ${alerts.join(' | ')}`);
  }
}

async function flow() {
const { open, sealed } = seed.crosses;

// --- discovery
await A.page.goto(`${BASE}/crosses`, { waitUntil: 'networkidle' });
for (let i = 0; i < 30 && (await A.page.getByText('Open for orders').count()) < 2; i++) {
  await A.page.waitForTimeout(2000);
  await A.page.reload({ waitUntil: 'load' });
}
log((await A.page.getByText('Open for orders').count()) === 2, 'both seeded crosses are listed as open for orders');
await shot(A, '01-crosses-list');

// --- open cross: connect, careless input, decline, place
await openCross(A, open);
log(await A.page.getByText('Connect a wallet to place an order').isVisible(), 'disconnected visitor is asked to connect before ordering');
await connect(A);
await A.page.getByLabel(/per token/).fill('1.27');
log(await A.page.getByText(/Prices move in steps of 0.05\. Try 1.25 or 1.3/).isVisible(), 'an off-grid price is refused with the two nearest valid prices');
await A.page.getByLabel(/per token/).fill('9');
log(await A.page.getByText(/must be between 1 and 2.95/).isVisible(), 'a price outside the grid names the valid range');
await A.page.getByLabel('Tokens').fill('abc');
log(await A.page.getByText(/Enter an amount of tokens/).isVisible(), 'a malformed quantity is refused');
log(await A.page.getByRole('button', { name: 'Place order' }).isDisabled(), 'the order button stays disabled while inputs are invalid');
log(await A.page.getByTestId('risk-ack').isVisible(), 'a wallet placing its first order sees the risk acknowledgement');
await A.page.getByLabel(/per token/).fill('1.30');
await A.page.getByLabel('Tokens').fill('600');
log((await A.page.getByTestId('preview').textContent()).includes('Up to 780 is held in escrow'), 'escrow preview shows the exact maximum (600 × 1.30 = 780)');
log(await A.page.getByRole('button', { name: 'Place order' }).isDisabled(), 'valid inputs alone do not enable the order button until the risks are accepted');
await acceptRisks(A);
log(await A.page.getByRole('button', { name: 'Place order' }).isEnabled(), 'accepting the risks enables the order button');
await A.page.evaluate(() => (window.__E2E_REJECT_NEXT__ = true));
await A.page.getByRole('button', { name: 'Place order' }).click();
await A.page.getByText('You declined in your wallet. Nothing was sent.').waitFor();
log(true, 'declining in the wallet sends nothing and says so');
const quoteBefore = await balance(A.address, seed.quoteMint);
await A.page.getByRole('button', { name: 'Place order' }).click();
await A.page.getByText('Order placed.').waitFor({ timeout: 60_000 });
log(quoteBefore - (await balance(A.address, seed.quoteMint)) === 780_000_000n, 'on chain: 780 quote moved into escrow');
log((await orderStatuses(A)).includes('in the book'), "the buyer's order shows in the book");
await A.page.waitForFunction(() => !['—', 'No price yet', 'Sealed', undefined].includes(document.querySelector('[data-testid="price"]')?.textContent?.trim()), null, { timeout: 30_000 });
// The issuer schedule offers 1,000 at 1.20: a lone 600 bid at 1.30 trades 600 at every price from
// 1.20 to 1.30 with the same imbalance, and the rule takes the lowest, 1.20.
log((await A.page.getByTestId('price').textContent()).trim() === '1.2', 'indicative price comes from the live book (1.20: lowest of the tied prices)');
await shot(A, '02-open-cross-after-order');

await openCross(B, open);
await connect(B);
await place(B, '1.25', '800');
await place(B, '1.10', '100');
let st = await orderStatuses(B);
log(st.filter((s) => s === 'in the book').length === 2, 'second buyer has two orders in the book');
const cancelBefore = await balance(B.address, seed.quoteMint);
await B.page.getByRole('button', { name: 'Cancel order' }).last().click();
for (let i = 0; i < 30 && (await balance(B.address, seed.quoteMint)) === cancelBefore; i++) await B.page.waitForTimeout(1000);
log((await balance(B.address, seed.quoteMint)) - cancelBefore === 110_000_000n, 'on chain: cancelling refunds the full 110 escrow');
await shot(B, '03-open-cross-mobile-dark');

// --- sealed cross
await openCross(A, sealed);
await place(A, '1.40', '500');
log((await orderStatuses(A)).includes('sealed'), 'a sealed bid shows as sealed');
const downloadA = A.page.waitForEvent('download');
await A.page.getByRole('button', { name: 'Back up sealed bids' }).click();
log((await (await downloadA).suggestedFilename()).startsWith('sealed-bids-'), 'the reveal backup downloads');
await openCross(B, sealed);
await place(B, '1.20', '700');
const downloadB = B.page.waitForEvent('download');
await B.page.getByRole('button', { name: 'Back up sealed bids' }).click();
const backupPath = `/tmp/oc-buyer2-backup-${Date.now()}.json`; // test data; not evidence
await (await downloadB).saveAs(backupPath);
await B.page.evaluate(() => localStorage.clear()); // the buyer loses this browser's storage
await shot(A, '04-sealed-cross-after-bid');

// --- close; reveal the sealed cross (buyer2 restores from the backup file)
await waitChain(seed.closeTs);
await openCross(A, sealed);
await A.page.getByRole('button', { name: 'Reveal bid' }).click();
await A.page.getByRole('button', { name: 'Reveal bid' }).waitFor({ state: 'detached', timeout: 60_000 });
log(true, 'buyer reveals the sealed bid after the close');
await openCross(B, sealed);
await connect(B);
await B.page.getByLabel('Load reveal backup').setInputFiles(backupPath);
await B.page.getByRole('button', { name: 'Reveal bid' }).click();
await B.page.getByRole('button', { name: 'Reveal bid' }).waitFor({ state: 'detached', timeout: 60_000 });
log(true, 'second buyer restores the bid from the backup file and reveals it');

// --- open cross: settle and claim
await openCross(A, open);
await A.page.getByRole('button', { name: 'Settle this cross' }).click();
await A.page.getByText('Clearing price').waitFor({ timeout: 60_000 });
log((await A.page.getByTestId('price').textContent()).trim() === '1.25', 'open cross clears at 1.25 (computed by hand: 1.20 infeasible, 1.25 trades 1,000)');
const baseOpen = (await crossAccount(open)).baseMint;
await A.page.getByRole('button', { name: 'Claim fill and refund' }).click();
await A.page.getByTestId('fill-report').waitFor({ timeout: 90_000 });
log((await balance(A.address, baseOpen)) === 600_000_000n, 'on chain: buyer at 1.30 received all 600 tokens');
log((await A.page.getByTestId('fill-report').textContent()).includes('600 tokens'), 'fill report shows 600 filled');
await shot(A, '05-open-cross-settled-claimed');
await openCross(B, open);
await B.page.getByRole('button', { name: 'Claim fill and refund' }).click();
await B.page.getByTestId('fill-report').waitFor({ timeout: 90_000 });
log((await balance(B.address, baseOpen)) === 400_000_000n, 'on chain: marginal buyer at 1.25 received 400 of 800 (pro rata)');
await shot(B, '06-open-cross-claimed-mobile-dark');

// --- sealed cross: settle after the reveal window and claim
await waitChain(seed.revealEndTs);
await openCross(B, sealed);
await B.page.getByRole('button', { name: 'Settle this cross' }).click();
await B.page.getByText('Clearing price').waitFor({ timeout: 60_000 });
log((await B.page.getByTestId('price').textContent()).trim() === '1.2', 'sealed cross clears at 1.20');
const baseSealed = (await crossAccount(sealed)).baseMint;
await B.page.getByRole('button', { name: 'Claim fill and refund' }).click();
for (let i = 0; i < 60 && (await balance(B.address, baseSealed)) === 0n; i++) await B.page.waitForTimeout(1000);
log((await balance(B.address, baseSealed)) === 500_000_000n, 'on chain: sealed marginal buyer at 1.20 received 500 of 700');
await B.page.getByTestId('fill-report').waitFor({ timeout: 90_000 });
await openCross(A, sealed);
await A.page.getByRole('button', { name: 'Claim fill and refund' }).click();
await A.page.getByTestId('fill-report').waitFor({ timeout: 90_000 });
log((await balance(A.address, baseSealed)) === 500_000_000n, 'on chain: sealed buyer at 1.40 received all 500');
await A.page.getByText(/Result independently verified|Result did not verify/).waitFor({ timeout: 30_000 }).catch(() => undefined);
await shot(A, '07-sealed-cross-claimed');

}

// --- the orders page lists everything this wallet did, with the results
await A.page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
await A.page.getByTestId('orders-list').waitFor({ timeout: 90_000 });
for (let i = 0; i < 90; i++) {
  const texts = await A.page.getByTestId('order-row').allTextContents();
  if (texts.filter((x) => x.includes('Settled')).length >= 2) break;
  await A.page.waitForTimeout(1000);
}
const orderRows = await A.page.getByTestId('order-row').allTextContents();
log(orderRows.some((x) => x.includes('Settled') && x.includes('Filled600 tokens')), 'orders page: the open-cross buy shows Settled with its 600-token fill');
log(orderRows.some((x) => x.includes('Settled') && x.includes('Filled500 tokens')), 'orders page: the sealed-cross buy shows Settled with its 500-token fill');
log((await A.page.getByRole('link', { name: /^Cross / }).count()) >= 2, 'orders page: each order links to its cross');
await shot(A, '08-my-orders');

for (const u of [A, B]) log(u.problems.length === 0, `${u.name}: zero console and page errors${u.problems.length ? ` (${u.problems.slice(0, 3).join(' | ')})` : ''}`);
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
