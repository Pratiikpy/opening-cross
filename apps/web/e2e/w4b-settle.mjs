// W4B: the settle page's two batch 2 steps, the fixed-price tranche at the clearing price (B4) and the MetaDAO futarchy DAO (X3), and what a governed cross's
// vote allows. Each is judged on the decoded transaction the wallet signed (the instruction, the price pin, the fresh account that signs next to the wallet),
// with the careless states: a supply the wallet does not hold, a sale that ends before it starts, a Token-2022 token MetaDAO refuses, the wrong wallet, a
// cross whose vote chose another venue or has not passed, and the cluster that does not have the batch 2 build.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-settle.mjs
import { act, clean, ensureConnected, failures, fixtures, go, ixOf, launch, log, person, refusedBy, reset, setMode, text, visible } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const G = f.graduation;
const local = (secs) => new Date(secs * 1000).toISOString().slice(0, 16);
const now = Math.floor(Date.now() / 1000);
const open = async (p, cross, address) => {
  await go(p, `/issuer/settle?cross=${cross}`);
  await ensureConnected(p, address ?? f.wallet);
  await p.page.getByTestId('tranche-steps').waitFor({ timeout: 25000 });
  await p.page.getByTestId('venues').waitFor({ timeout: 25000 });
};
const fill = (p, scope, label, value) => p.page.getByTestId(scope).getByLabel(label, { exact: true }).fill(value);
const fillPresale = async (p, o = {}) => {
  await fill(p, 'presale-form', 'Tokens in the tranche', o.supply ?? '100');
  await fill(p, 'presale-form', 'Most it may raise, quote tokens', o.max ?? '150');
  await fill(p, 'presale-form', 'Least it needs, quote tokens', o.min ?? '50');
  await fill(p, 'presale-form', 'Smallest deposit, quote tokens', '1');
  await fill(p, 'presale-form', 'Largest deposit per buyer, quote tokens', '100');
  await fill(p, 'presale-form', 'Opens at', o.start ?? local(now + 3600));
  await fill(p, 'presale-form', 'Closes at', o.end ?? local(now + 3 * 86400));
};

try {
  // ------------------------------------------------------------------ the fixed-price tranche
  const p = await person(browser, { name: 'issuer', secret: f.secret });
  await open(p, f.settle.settleCross);
  log((await p.page.getByTestId('feature-notice').first().getAttribute('data-state')) === 'live', 'the steps say the batch 2 build is live on this network');
  log(await p.page.getByTestId('open-fixed-price-presale').isDisabled(), 'the tranche button is off until the form is filled');
  await fillPresale(p, { supply: '5000' });
  let r = await refusedBy(p, 'open-fixed-price-presale');
  log(r.shown && /holds 800000000 of the base token|holds 800/.test(r.message) && r.n === 0, `a supply above what the wallet holds is refused in the API's words and nothing is signed (${r.message.slice(0, 90)})`);
  await fillPresale(p, { end: local(now + 1800) });
  log(/must close after it opens/.test(await text(p.page.getByTestId('presale-form'))) && (await p.page.getByTestId('open-fixed-price-presale').isDisabled()), 'a sale that closes before it opens is named, and the button goes off');
  await fillPresale(p, { min: '200' });
  log(/minimum raise cannot be above the maximum/.test(await text(p.page.getByTestId('presale-form'))), 'a minimum above the maximum is named');
  await fillPresale(p);
  log(/Selling every token at the clearing price brings in 150/.test(await text(p.page.getByTestId('presale-form'))), 'the form says what selling every token at the clearing price brings in (100 x 1.5 = 150)');
  r = await act(p, 'open-fixed-price-presale');
  const ps = ixOf(r.tx, 'cross_settle', 'open_fixed_price_presale');
  log(r.done && ps, `Open the tranche signs open_fixed_price_presale (${r.shape.join(', ')})`);
  console.log('   open_fixed_price_presale:', JSON.stringify(ps?.args)?.slice(0, 400));
  const q = ((1_500_000n << 64n) / 1_000_000n).toString();
  log(String(ps?.args?.qPrice) === q, `the price is pinned to the clearing price: q_price = floor(P* x 2^64 / scale) = ${q}`);
  log(ps?.accounts.filter((a) => a.signer).length === 2 && ps.accounts.some((a) => a.signer && a.address === f.wallet), 'two accounts sign: the creator and the fresh account of the sale');
  log(r.tx[0].transaction[0].program === 'ComputeBudget111111111111111111111111111111' || r.tx[0].transaction[0].programAddress === 'ComputeBudget111111111111111111111111111111', 'after the compute budget the heavy instruction needs');
  await p.page.getByTestId('presale-address').waitFor();
  log(/Presale: /.test(await text(p.page.getByTestId('presale-address'))), 'the sale’s address is shown once built');
  await p.page.screenshot({ path: `${process.env.OUT}/settle-tranche.png`, fullPage: true });

  // ------------------------------------------------------------------ the MetaDAO DAO
  log(await p.page.getByTestId('seed-futarchy-dao').isDisabled(), 'the DAO button is off until a base amount is entered');
  await fill(p, 'futarchy-form', 'Base tokens to deposit', '100');
  log(/100 base tokens go in with 150 quote tokens/.test(await text(p.page.getByTestId('futarchy-form'))), 'the quote deposit is not typed: it is derived from the price and shown (100 base with 150 quote)');
  r = await act(p, 'seed-futarchy-dao');
  const dao = ixOf(r.tx, 'cross_settle', 'seed_futarchy_dao');
  log(r.done && dao, `Open the DAO signs seed_futarchy_dao (${r.shape.join(', ')})`);
  console.log('   seed_futarchy_dao:', JSON.stringify(dao?.args)?.slice(0, 400));
  log(String(dao?.args?.baseAmount) === '100000000' && String(dao?.args?.quoteAmount) === '150000000', 'for 100 base and 150 quote atoms-of-a-token (100000000 and 150000000)');
  await p.page.getByText('MetaDAO settings (optional)').click();
  await fill(p, 'open-futarchy', 'Pass threshold, %', '120');
  log(/0 to 100/.test(await text(p.page.getByTestId('open-futarchy'))) && (await p.page.getByTestId('seed-futarchy-dao').isDisabled()), 'a pass threshold above 100% is named');
  await fill(p, 'open-futarchy', 'Pass threshold, %', '3');
  await fill(p, 'open-futarchy', 'Proposal length, days', '3');
  r = await act(p, 'seed-futarchy-dao');
  log(r.done && ixOf(r.tx, 'cross_settle', 'seed_futarchy_dao'), 'with MetaDAO settings the DAO is still opened (pass threshold 3%, proposals of 3 days)');
  await p.page.screenshot({ path: `${process.env.OUT}/settle-dao.png`, fullPage: true });

  // ------------------------------------------------------------------ MetaDAO takes legacy tokens only
  await open(p, f.settle.settleBlockedCross);
  await p.page.getByTestId('futarchy-blocker').waitFor({ timeout: 15000 });
  log(/legacy SPL Token mints only/.test(await text(p.page.getByTestId('futarchy-blocker'))) && (await p.page.getByTestId('seed-futarchy-dao').isDisabled()), 'a Token-2022 cross gets the legacy-token explanation and no DAO button');

  // ------------------------------------------------------------------ a governed cross: the vote decides the venue
  await open(p, G.gradDoneFutarchy);
  log((await p.page.getByTestId('governed-note').getAttribute('data-outcome')) === 'metadao_futarchy' && /Holders chose MetaDAO futarchy DAO/.test(await text(p.page.getByTestId('governed-note'))), 'a governed cross whose vote chose MetaDAO says so at the top of the page');
  log(await p.page.getByTestId('seed-damm-v2').isDisabled() && (await p.page.getByTestId('open-dlmm-pair').isDisabled()) && (await p.page.getByTestId('seed-raydium-cpmm').isDisabled()), 'the other graduation venues are off');
  log(/Holders voted for MetaDAO futarchy DAO, not Meteora DAMM v2/.test(await text(p.page.getByTestId('seed-damm-v2-reason'))), 'and each says the holders voted for MetaDAO, not that venue');
  await fill(p, 'futarchy-form', 'Base tokens to deposit', '100');
  log(await p.page.getByTestId('seed-futarchy-dao').isEnabled(), 'the DAO step is on: it is the venue the holders chose');
  r = await act(p, 'seed-futarchy-dao');
  const gd = ixOf(r.tx, 'cross_settle', 'seed_futarchy_dao');
  log(r.done && gd && gd.accounts.length > 0 && gd.accounts[gd.accounts.length - 1].address === (await (await fetch(`${process.env.API_URL}/v1/crosses/${G.gradDoneFutarchy}/graduation`)).json()).outcomeAccount, 'and the transaction names the Outcome account as its last account, which the settlement program requires');
  await open(p, G.gradDoneDamm);
  await fill(p, 'open-damm', 'Base tokens to deposit', '100');
  await fill(p, 'open-damm', 'Quote tokens to deposit', '150');
  log(await p.page.getByTestId('seed-damm-v2').isEnabled() && (await p.page.getByTestId('open-dlmm-pair').isDisabled()) && (await p.page.getByTestId('seed-futarchy-dao').isDisabled()), 'a vote for DAMM v2 turns on DAMM v2 and turns DLMM and the DAO off');
  r = await act(p, 'seed-damm-v2');
  const dm = ixOf(r.tx, 'cross_settle', 'seed_damm_v2');
  log(r.done && dm, 'and DAMM v2 seeds');
  await open(p, G.gradVoting);
  log((await p.page.getByTestId('governed-note').getAttribute('data-outcome')) === 'none' && (await p.page.getByTestId('seed-damm-v2').isDisabled()), 'a governed cross whose vote has not passed has every graduation venue off');
  log(/no vote has passed/.test(await text(p.page.getByTestId('seed-raydium-cpmm-reason'))), 'with the reason');
  await fillPresale(p);
  log(await p.page.getByTestId('open-fixed-price-presale').isEnabled(), 'the fixed-price tranche is not a graduation venue, so the vote does not gate it');
  await p.page.screenshot({ path: `${process.env.OUT}/settle-governed.png`, fullPage: true });
  log(clean(p, ['400', '409', '422']).length === 0, `issuer: no console error or failed request ${clean(p, ['400', '409', '422']).join(' | ')}`);
  await p.ctx.close();

  // ------------------------------------------------------------------ not the creator
  const s = await person(browser, { name: 'other', secret: f.people.other.secret });
  await open(s, f.settle.settleCross, f.people.other.address);
  log(/Only the wallet that created the cross/.test(await text(s.page.getByTestId('open-fixed-price-presale-reason'))) && (await s.page.getByTestId('seed-futarchy-dao').isDisabled()), 'a wallet that did not create the cross is told only its creator can open the market');
  await s.ctx.close();

  // ------------------------------------------------------------------ the batch 2 build is not on the cluster
  await setMode('absent');
  const n = await person(browser, { name: 'absent', secret: f.secret });
  await open(n, f.settle.settleCross);
  const notice = n.page.locator('[data-testid="open-presale"] [data-testid="feature-notice"]');
  await notice.waitFor({ timeout: 15000 });
  log((await notice.getAttribute('data-state')) === 'not-deployed' && /Built, not on devnet yet/.test(await text(notice)), 'on a cluster without the batch 2 build the tranche says it is built, not on devnet yet');
  await fillPresale(n);
  log(await n.page.getByTestId('open-fixed-price-presale').isDisabled() && /not on devnet yet/.test(await text(n.page.getByTestId('open-fixed-price-presale-reason'))), 'the tranche button stays off even with a valid form, and says why');
  await fill(n, 'futarchy-form', 'Base tokens to deposit', '100');
  log(await n.page.getByTestId('seed-futarchy-dao').isDisabled(), 'and so does the DAO button');
  await n.page.screenshot({ path: `${process.env.OUT}/settle-absent.png`, fullPage: true });
  log(clean(n, ['400', '409', '422']).length === 0, `absent: no console error or failed request ${clean(n, ['400', '409', '422']).join(' | ')}`);
  await n.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
void visible;
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
