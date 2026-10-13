// The settle page against the harness: the live-today table, partner payouts, the fees of protected liquidity and the greenshoe, each checked on the
// decoded transaction; the careless states (a cross that has not settled, a budget too small, levels still open); and the first release.
import { BASE, OUT, api, connect, failures, find, fixtures, hasAccount, launch, log, person, reset, sent, setMode, settle, signerOf, text, visible } from './issuer-w3b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const C = f.crosses;
const picks = (p, cross) => p.page.getByTestId(`pick-${cross}`).click();
async function act(p, id, program, instruction) {
  await reset();
  await p.page.getByTestId(id).click();
  const done = await visible(p.page.getByTestId(`${id}-done`), 20000);
  const tx = await sent();
  return { done, ix: find(tx, program, instruction), tx };
}
const err = async (p, id) => {
  await reset();
  await p.page.getByTestId(id).click();
  const shown = await visible(p.page.getByTestId(`${id}-error`), 15000);
  return { shown, message: shown ? await text(p.page.getByTestId(`${id}-error`)) : '', n: (await sent()).length };
};

try {
  const s = await person(browser, { name: 'settle', secret: f.secret });
  const P = s.page;
  await P.goto(`${BASE}/issuer/settle`, { waitUntil: 'networkidle' });
  log(await visible(P.getByTestId('live-table')), 'the page opens with what is live today and what waits for the upgrade');
  const table = await text(P.getByTestId('live-table'));
  log(/Not available/.test(table) && /Live \(first release of cross_settle\)/.test(table) && /Greenshoe/.test(table) && /Alpha Vault/.test(table), 'it names the pool-opening instructions as live and the payouts, greenshoe, Alpha Vault and Met Lock as waiting');
  log(await visible(P.getByTestId('connect-for-list')), 'with no wallet it asks for one to list crosses, or for an address');
  await connect(s, f.wallet);
  log(await visible(P.getByTestId('my-crosses')), 'the wallet’s crosses are listed');
  log((await P.getByTestId('my-crosses').locator('li').count()) === 4, 'all four');
  log(await visible(P.locator('[data-testid="program-notice"][data-release="unknown"]')) && /does not report/.test(await text(P.getByTestId('program-notice'))), 'the page says the API does not report cross_settle’s release, and that each action is simulated first');

  // a cross that has not settled
  await picks(s, C.live);
  await P.getByTestId('claim-partner-fee').waitFor();
  log(await P.getByTestId('claim-partner-fee').isDisabled() && /has not settled/.test(await text(P.getByTestId('claim-partner-fee-reason'))), 'a live cross cannot be paid out, and says why');

  // partner payouts
  await picks(s, C.fresh);
  await P.getByTestId('settlement-record').waitFor();
  log(/Meteora DBC continuation/.test(await text(P.getByTestId('settlement-record'))) && /25 quote in 2 claims/.test(await text(P.getByTestId('settlement-record'))), 'the record shows the venue and what was claimed');
  let r = await act(s, 'claim-partner-fee', 'cross_settle', 'claim_partner_fee');
  log(r.done && hasAccount(r.ix, C.fresh) && r.tx[0].feePayer === f.wallet, 'Claim the partner’s trading fees signs claim_partner_fee for the cross');
  log((await text(P.getByTestId('payout-destination'))).includes(f.feeRecipient), 'and names the fee recipient the cross fixed as the destination');
  for (const [id, ix] of [['withdraw-partner-surplus', 'withdraw_partner_surplus'], ['withdraw-partner-migration-fee', 'withdraw_partner_migration_fee'], ['claim-partner-pool-creation-fee', 'claim_partner_pool_creation_fee']]) {
    r = await act(s, id, 'cross_settle', ix);
    log(r.done && Boolean(r.ix), `${id} signs ${ix}`);
  }
  const pol = P.getByTestId('pol-form');
  log(await P.getByTestId('claim-pol-fees').isDisabled(), 'the protected-liquidity claim is off until its seven addresses are given');
  const addrs = [f.alice, f.bob, f.stranger, f.credential, f.schema, f.attester, f.recovery];
  for (const [i, label] of ['Pool', 'Position', 'Position NFT account', 'Token A mint', 'Token B mint', 'Token A vault', 'Token B vault'].entries()) await pol.getByLabel(label, { exact: true }).fill(addrs[i]);
  r = await act(s, 'claim-pol-fees', 'cross_settle', 'claim_pol_fees');
  log(r.done && hasAccount(r.ix, f.alice), 'then claim_pol_fees is signed with the pool the issuer named');

  // greenshoe: create
  const create = P.getByTestId('greenshoe-create');
  await create.getByLabel('Budget, in quote tokens').fill('100');
  await create.getByLabel('The bids start').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await create.getByLabel('Most to place in a period, in quote tokens').fill('300');
  r = await err(s, 'create-greenshoe');
  log(r.shown && /at least 10%/.test(r.message) && r.n === 0, 'a budget under 10% of what buyers paid is refused by the program’s rule, with the minimum, before signing');
  console.log('  ', r.message);
  await create.getByLabel('Budget, in quote tokens').fill('300');
  r = await act(s, 'create-greenshoe', 'cross_settle', 'create_greenshoe');
  log(r.done && r.ix?.args?.budget === '300000000' && r.ix.args.periodSecs === '86400' && signerOf(r.ix, f.wallet), 'a sufficient budget signs create_greenshoe with the budget in atoms and the period in seconds');
  await s.page.screenshot({ path: `${OUT}/settle-fresh.png`, fullPage: true });

  // greenshoe: bids standing
  await picks(s, C.bids);
  await P.getByTestId('greenshoe-state').waitFor();
  log(/Bidsplaced1/.test((await text(P.getByTestId('greenshoe-state'))).replace(/\s/g, '')), 'a greenshoe shows its budget, what is placed and the window');
  log((await P.getByTestId('gs-level-0').textContent())?.includes('Placed'), 'level 1 is placed');
  const lvl = P.getByTestId('gs-level-1');
  await lvl.getByLabel('Amount, in quote tokens').fill('200');
  r = await err(s, 'deploy-bid-1');
  log(r.shown && /at most/.test(r.message) && r.n === 0, 'a level above a third of the budget is refused in words before signing');
  await lvl.getByLabel('Amount, in quote tokens').fill('100');
  r = await act(s, 'deploy-bid-1', 'cross_settle', 'deploy_greenshoe_bid');
  log(r.done && r.ix?.args?.amount === '100000000' && r.ix.args.level === 1, 'a level within it signs deploy_greenshoe_bid');
  const signers = r.ix?.accounts.filter((a) => a.signer).map((a) => a.address) ?? [];
  log(signers.length === 2 && signers.includes(f.wallet), 'with two signers: the wallet and the fresh limit-order account (the harness verified both signatures)');

  // greenshoe: the week is over
  await picks(s, C.over);
  await P.getByTestId('settle-level-0').waitFor();
  log(await P.getByTestId('finish-greenshoe').isVisible(), 'when the week is over the page offers to finish it');
  r = await err(s, 'finish-greenshoe');
  log(r.shown && /still to be settled/.test(r.message) && r.n === 0, 'finishing with a level unsettled is refused in words');
  r = await act(s, 'settle-level-0', 'cross_settle', 'settle_greenshoe_level');
  log(r.done && Boolean(r.ix), 'settling the level signs settle_greenshoe_level');
  await s.ctx.close();

  // the first release: each button is simulated and refused by the cluster
  await setMode('old');
  const o = await person(browser, { name: 'settle-old', secret: f.secret });
  await o.page.goto(`${BASE}/issuer/settle?cross=${C.fresh}`, { waitUntil: 'networkidle' });
  await connect(o, f.wallet);
  await o.page.getByTestId('claim-partner-fee').waitFor();
  r = await err(o, 'claim-partner-fee');
  log(r.shown && /cross_settle does not have this instruction yet/.test(r.message) && /H27/.test(r.message) && r.n === 0, 'on the first release a payout is refused by the cluster’s dry run, in words, and nothing is signed');
  await o.page.screenshot({ path: `${OUT}/settle-first-release.png`, fullPage: false });
  await o.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void api; void settle;
