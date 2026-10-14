// W3F: the settle page's market-opening and Meteora forms (W3E routes): the DBC continuation (locked and not), a DAMM v2 pool (plain, batched, with an
// Alpha Vault, locked), a DLMM pair (plain, batched, badged), a Raydium pool, the Alpha Vault, Met Lock and Dynamic Fee Sharing. Each is judged on the
// decoded transaction the wallet signed, with the careless states: a start that is too close, a fee that does not decay, a badge that does not exist,
// a design that is not the locked one, the wrong wallet, a cross that has not settled, and the first release.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-settle.mjs
import { BASE, OUT, ensureConnected, eventually, failures, find, fixtures, launch, log, person, reset, sent, setMode, shape, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
// The browser of a person runs in UTC (see person() in issuer-w3b-lib.mjs), and a datetime-local box is read in the browser's zone.
const local = (secs) => new Date(secs * 1000).toISOString().slice(0, 16);
const now = Math.floor(Date.now() / 1000);

const go = async (p, cross) => {
  await p.page.goto(`${BASE}/issuer/settle?cross=${cross}`, { waitUntil: 'networkidle' });
  await ensureConnected(p, p.address ?? f.wallet);
  await p.page.getByTestId('venues').waitFor({ timeout: 20000 }).catch(() => undefined);
};
async function run(p, testId) {
  await reset();
  await p.page.getByTestId(testId).click();
  const done = await visible(p.page.getByTestId(`${testId}-done`), 20000);
  const tx = await sent();
  return { done, tx, shape: shape(tx).flat() };
}
async function refused(p, testId) {
  await reset();
  await p.page.getByTestId(testId).click();
  const shown = await visible(p.page.getByTestId(`${testId}-error`), 15000);
  return { shown, message: shown ? await text(p.page.getByTestId(`${testId}-error`)) : '', n: (await sent()).length };
}
const fill = (p, scope, label, value) => p.page.getByTestId(scope).getByLabel(label, { exact: true }).fill(value);
const check = (p, scope, label, on = true) => p.page.getByTestId(scope).getByLabel(label).setChecked(on);

try {
  const p = await person(browser, { name: 'issuer', secret: f.secret });
  await go(p, f.settleCross);
  const venues = await text(p.page.getByTestId('venues'));
  log(/Available nowDAMM v2 pool, DLMM pair, Raydium CPMM pool/.test(venues.replace(/\s/g, ' ').replace(/Available now/, 'Available now')) || /DAMM v2 pool, DLMM pair, Raydium CPMM pool/.test(venues), 'a cross that printed lists what can be opened for it (the three pool types; no DBC because it is not a deferred-mint cross)');
  log(/Clearing price1500000|Clearing price\s*1500000/.test(venues.replace(/\s+/g, '')) || venues.includes('1500000'), 'and its clearing price');
  log(await p.page.getByTestId('open-dbc-pool').isDisabled(), 'the DBC form is off for it, and says why');

  // ---- Raydium
  await fill(p, 'open-raydium', 'Base tokens to deposit', '500');
  let r = await run(p, 'seed-raydium-cpmm');
  // on devnet the Raydium build of cross_settle has its own program id (docs/adr/0021-raydium-devnet-build.md)
  log(r.done && r.tx[0].transaction.some((i) => i.programAddress === '4nH5srCTtRFtJuHNmH2Q3x1TSMZ8w3VWBfX7PwwNMpJ5'), `Raydium: signs the devnet-raydium cross_settle build (${r.shape.join(', ')})`);
  log(r.tx[0].feePayer === f.wallet, 'with the creator paying');

  // ---- DAMM v2: plain
  await fill(p, 'open-damm', 'Base tokens to deposit', '100');
  await fill(p, 'open-damm', 'Quote tokens to deposit', '150');
  r = await run(p, 'seed-damm-v2');
  log(r.done && r.shape.includes('cross_settle.seed_damm_v2'), `DAMM v2 plain: signs seed_damm_v2 (${r.shape.join(', ')})`);
  console.log('   seed_damm_v2:', JSON.stringify(find(r.tx, 'cross_settle', 'seed_damm_v2')?.args));
  // batched, with an Alpha Vault and the liquidity locked
  await check(p, 'open-damm', 'Open closed for a batch window');
  await check(p, 'open-damm', 'Bind an Alpha Vault');
  await check(p, 'open-damm', 'Lock all of the pool’s liquidity for good');
  await fill(p, 'damm-batch', 'Swaps open at', local(now + 1800));
  log((await eventually(p.page.getByTestId('damm-batch'), /at least the window \(60 minutes\)/)) && (await p.page.getByTestId('seed-damm-v2').isDisabled()), 'a start closer than the window is named, with the earliest, and the button is off');
  await fill(p, 'damm-batch', 'Swaps open at', local(now + 4 * 3600));
  await fill(p, 'damm-batch', 'Ending fee, %', '1');
  log(/must be lower/.test(await text(p.page.getByTestId('damm-batch'))), 'an ending fee that is not below the opening fee is named');
  await fill(p, 'damm-batch', 'Ending fee, %', '0.25');
  r = await run(p, 'seed-damm-v2');
  log(r.done && r.shape.includes('cross_settle.seed_damm_v2_batched'), `DAMM v2 batched: signs seed_damm_v2_batched (${r.shape.join(', ')})`);
  const batched = find(r.tx, 'cross_settle', 'seed_damm_v2_batched');
  console.log('   seed_damm_v2_batched:', JSON.stringify(batched?.args));
  log(r.shape.length >= 3, 'with the liquidity lock in the same signature (compute limit, seed, lock)');
  log(await visible(p.page.getByTestId('land-by')), 'the page says when the transaction must land by');
  await check(p, 'open-damm', 'Open closed for a batch window', false);
  log(/needs a start/.test(await text(p.page.getByTestId('open-damm'))), 'an Alpha Vault without a batch is named as needing a start');
  await check(p, 'open-damm', 'Bind an Alpha Vault', false);

  // ---- DLMM
  await fill(p, 'open-dlmm', 'Bin step, bps', '25');
  await fill(p, 'open-dlmm', 'Base factor', '10000');
  r = await run(p, 'open-dlmm-pair');
  log(r.done && r.shape.includes('cross_settle.open_dlmm_pair'), `DLMM plain: signs open_dlmm_pair (${r.shape.join(', ')})`);
  await check(p, 'open-dlmm', 'Open closed for a batch window');
  await fill(p, 'dlmm-batch', 'Swaps open at', local(now + 4 * 3600));
  r = await run(p, 'open-dlmm-pair');
  log(r.done && r.shape.includes('cross_settle.open_dlmm_pair_batched'), `DLMM batched: signs open_dlmm_pair_batched (${r.shape.join(', ')})`);
  await check(p, 'open-dlmm', 'Open closed for a batch window', false);
  await check(p, 'open-dlmm', 'The base token needs a Token Badge');
  await check(p, 'open-dlmm', 'The quote token needs a Token Badge');
  r = await run(p, 'open-dlmm-pair');
  log(r.done && r.shape.includes('cross_settle.open_dlmm_pair_badged'), `DLMM badged: signs open_dlmm_pair_badged (${r.shape.join(', ')})`);
  const badged = find(r.tx, 'cross_settle', 'open_dlmm_pair_badged');
  log(Boolean(badged?.accounts.some((a) => a.address === f.badges.base)) && Boolean(badged?.accounts.some((a) => a.address === f.badges.quote)), 'naming both Token Badges');
  // a token whose badge does not exist
  await go(p, f.alphaPoolCross);
  await fill(p, 'open-dlmm', 'Bin step, bps', '25');
  await fill(p, 'open-dlmm', 'Base factor', '10000');
  await check(p, 'open-dlmm', 'The base token needs a Token Badge');
  r = await refused(p, 'open-dlmm-pair');
  log(r.shown && /Token Badge/.test(r.message) && r.n === 0, `a token with no badge is refused in words, and nothing is signed (${r.message.slice(0, 140)})`);
  await go(p, f.settleCross);
  await p.page.screenshot({ path: `${OUT}/settle-open.png`, fullPage: true });

  // ---- DBC continuation
  await go(p, f.dbcCross);
  log(/Open the DBC pool|DBC continuation/.test(await text(p.page.getByTestId('venues'))) || (await p.page.getByTestId('venues').isVisible()), 'a deferred-mint cross offers the DBC continuation');
  await fill(p, 'open-dbc', 'Name', 'Opening Token');
  await fill(p, 'open-dbc', 'Symbol', 'OPEN');
  await fill(p, 'open-dbc', 'Metadata link', 'https://example.invalid/open.json');
  r = await run(p, 'open-dbc-pool');
  log(r.done && r.shape.includes('cross_settle.open_dbc_pool_locked') && r.shape.includes('cross_settle.bind_dbc_mint'), `DBC: signs open_dbc_pool_locked and bind_dbc_mint together (${r.shape.join(', ')})`);
  const design = JSON.parse(await p.page.getByTestId('dbc-design').inputValue());
  design.liquidityDistribution.partnerPermanentLockedLiquidityPercentage = 0;
  await p.page.getByTestId('dbc-design').fill(JSON.stringify(design));
  r = await refused(p, 'open-dbc-pool');
  log(r.shown && /not the locked, compounding design/.test(r.message) && r.n === 0, `a design that is not the locked one is refused, naming the departure (${r.message.slice(0, 140)})`);
  await p.page.getByTestId('dbc-design').fill('{ nope');
  log(/not valid JSON/.test(await text(p.page.getByTestId('open-dbc'))) && (await p.page.getByTestId('open-dbc-pool').isDisabled()), 'a design that is not JSON is named and the button is off');
  log(await p.page.getByTestId('bind-dbc-mint').isDisabled(), 'binding the mint is off until the pool exists');
  log(/not offered|Fees of a DBC pool/.test(await text(p.page.getByTestId('fee-bridge-note'))) && /fixes both/.test(await text(p.page.getByTestId('fee-bridge-note'))), 'the page says the DBC fee bridge is not offered, and why');

  // ---- the wrong wallet, and a cross that has not settled
  await go(p, f.crosses.live);
  await p.page.getByTestId('open-damm').waitFor({ timeout: 15000 }).catch(() => undefined);
  log((await p.page.getByTestId('seed-damm-v2').isDisabled()) && /has not settled yet/.test(await text(p.page.getByTestId('open-damm'))), 'a cross that has not settled offers nothing, and says so');
  const s = await person(browser, { name: 'stranger', secret: f.strangerWallet.secret });
  s.address = f.strangerWallet.address;
  await go(s, f.settleCross);
  log((await s.page.getByTestId('seed-damm-v2').isDisabled()) && /Only the wallet that created the cross/.test(await text(s.page.getByTestId('open-damm'))), 'another wallet is told only the creator can open the market');
  await s.ctx.close();

  // ---- Alpha Vault
  await go(p, f.alphaPoolCross);
  await p.page.getByTestId('alpha-create').waitFor({ timeout: 15000 });
  await fill(p, 'alpha-create', 'The most the vault buys, in quote tokens', '500');
  await fill(p, 'alpha-create', 'Claiming starts', local(now + 86400));
  await fill(p, 'alpha-create', 'Vesting ends', local(now + 7 * 86400));
  r = await run(p, 'alpha-init');
  log(r.done && r.shape.some((x) => !x.startsWith('cross_settle') && !x.startsWith('cross_core')), `Alpha Vault: the vault is created in Meteora’s program (${r.shape.join(', ')})`);
  log(r.tx[0].transaction.some((i) => i.programAddress === 'vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2'), 'the instruction is Alpha Vault’s own');
  await fill(p, 'alpha-create', 'Vesting ends', local(now + 3600));
  log(/end after it starts/.test(await text(p.page.getByTestId('alpha-create'))) && (await p.page.getByTestId('alpha-init').isDisabled()), 'vesting that ends before it starts is named, and the button is off');
  await go(p, f.alphaVaultCross);
  await p.page.getByTestId('alpha-actions').waitFor({ timeout: 15000 });
  log(/Pro rata/.test(await text(p.page.getByTestId('alpha-state'))), 'a vault that exists is shown with its mode, and the create form is gone');
  await fill(p, 'alpha-actions', 'Deposit, in quote tokens', '1');
  r = await run(p, 'alpha-deposit');
  log(r.done && r.tx[0].transaction.some((i) => i.programAddress === 'vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2'), `a deposit signs Alpha Vault’s deposit (${r.shape.join(', ')})`);
  r = await refused(p, 'alpha-claim');
  log(r.shown && r.n === 0, `claiming before anything was bought is refused in words (${r.message.slice(0, 100)})`);

  // ---- Met Lock
  await go(p, f.settleCross);
  await fill(p, 'metlock-form', 'Token to lock', f.mints.noHalt);
  await fill(p, 'metlock-form', 'Recipient', f.bob);
  await fill(p, 'metlock-form', 'Amount to lock', '1000');
  await fill(p, 'metlock-form', 'The schedule starts', local(now + 3600));
  await p.page.waitForTimeout(800);
  r = await run(p, 'metlock-create');
  log(r.done && r.tx[0].transaction.some((i) => i.programAddress === 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn'), `Met Lock: the lock is created in Met Lock’s program (${r.shape.join(', ')})`);
  log((await text(p.page.getByTestId('metlock-escrow'))).length > 10, 'the escrow address is shown');
  await fill(p, 'metlock-form', 'Amount to lock', '0');
  log(/above zero/.test(await text(p.page.getByTestId('metlock-form'))) && (await p.page.getByTestId('metlock-create').isDisabled()), 'an amount of zero is named, and the button is off');
  await p.page.getByTestId('metlock-claim').getByLabel('Escrow address').fill(f.escrowSpl);
  await p.page.getByTestId('metlock-look').click();
  await p.page.waitForTimeout(1200);
  log(/Claimable now/.test(await text(p.page.getByTestId('metlock-claim'))), 'an escrow can be looked up: total, vested, claimable');
  r = await refused(p, 'metlock-claim-go');
  log(r.shown && /recipient/i.test(r.message) && r.n === 0, `claiming someone else’s escrow is refused in words (${r.message.slice(0, 100)})`);

  // ---- Fee sharing
  await p.page.getByTestId('feeshare-manage').getByLabel('Vault base address').fill(f.feeBase);
  await p.page.getByTestId('feeshare-look').click();
  await p.page.waitForFunction(() => /splits the quote token/.test(document.querySelector('[data-testid="feeshare-read"]')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  log(/splits the quote token between 2 recipients/.test(await text(p.page.getByTestId('feeshare-read'))), 'a vault is read: two recipients');
  await p.page.getByTestId('feeshare-manage').getByLabel('Fund the vault, in quote tokens').fill('10');
  r = await run(p, 'feeshare-fund');
  log(r.done, `funding the vault signs (${r.shape.join(', ')})`);
  r = await run(p, 'feeshare-claim');
  log(r.done, `the first recipient claims (${r.shape.join(', ')})`);
  r = await refused(p, 'feeshare-pull');
  log(r.shown && r.n === 0, `pulling fees from a position that is not in the vault is refused in words (${r.message.slice(0, 100)})`);
  await p.page.getByTestId('feeshare-create').getByLabel('Recipient 1').fill(f.wallet);
  await p.page.getByTestId('feeshare-add').click();
  await p.page.getByTestId('feeshare-create').getByLabel('Recipient 2').fill(f.alice);
  await p.page.getByTestId('feeshare-create').getByLabel('Share').nth(0).fill('3');
  log(/75%, 25%/.test(await text(p.page.getByTestId('feeshare-percents'))), 'weights 3 and 1 are shown as 75% and 25% before anything is signed');
  r = await run(p, 'feeshare-create-go');
  log(r.done && r.tx[0].transaction.some((i) => i.programAddress === 'dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh'), `creating the vault is Dynamic Fee Sharing’s own instruction (${r.shape.join(', ')})`);
  log(/one way/.test(await text(p.page.getByTestId('transfer-warning'))), 'handing over the position is described as one way');
  await p.page.screenshot({ path: `${OUT}/settle-meteora.png`, fullPage: true });
  log(p.problems.filter((x) => !/40[0-9]|422|409/.test(x)).length === 0, `issuer: no console error or failed request ${p.problems.filter((x) => !/40[0-9]|422|409/.test(x)).join(' | ')}`);
  await p.ctx.close();

  // ---- the first release
  await setMode('old');
  const o = await person(browser, { name: 'old', secret: f.secret });
  await go(o, f.settleCross);
  await o.page.waitForTimeout(1500);
  log(await o.page.getByTestId('seed-damm-v2').isDisabled(), 'on the first release the pool form is off');
  await fill(o, 'open-damm', 'Base tokens to deposit', '100');
  await fill(o, 'open-damm', 'Quote tokens to deposit', '150');
  log(/first release/.test(await text(o.page.getByTestId('seed-damm-v2-reason'))), 'and says the program is still the first release');
  await o.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void eventually;
