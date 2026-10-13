// The treasury console against the harness: every action builds its unsigned transaction through the W3A route, the wallet signs it, and the
// harness decodes what was sent. Also the states people do not demo: not the authority, a refusal from the API, the first release.
import { api, BASE, OUT, connect, failures, find, fixtures, freshSecret, hasAccount, launch, log, person, reset, sent, setMode, settle, signerOf, text, visible } from './issuer-w3b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const T = f.treasuries;

async function page(name, treasury, secret = f.secret, viewport) {
  const p = await person(browser, { name, secret, ...(viewport ? { viewport } : {}) });
  await p.page.goto(`${BASE}/issuer/treasury/${treasury}`, { waitUntil: 'networkidle' });
  if (secret) await connect(p, f.wallet);
  await p.page.getByTestId('treasury-header').waitFor({ timeout: 20000 });
  return p;
}
/** Click an action, wait for it to confirm, return the one new transaction's instruction. */
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
  return { shown, message: shown ? await text(p.page.getByTestId(`${id}-error`)) : '', sentCount: (await sent()).length };
};

try {
  // ============================================================ not extended: extend once
  const a = await page('plain', T.plain);
  const P = a.page;
  log(await visible(P.getByTestId('extend')), 'a treasury that was never extended offers to extend it, once');
  log(/One time only/.test(await text(P.getByTestId('section-terms'))) && /nothing can change them/.test(await text(P.getByTestId('section-terms'))), 'and says the terms are fixed for good');
  log(await visible(P.getByTestId('needs-extension')), 'the votes, NAV, grants and the rest say they begin with the extension');
  log(await P.getByTestId('extend-treasury').isDisabled(), 'Extend is off until the terms are accepted');
  await P.getByTestId('terms-preset-governed').click();
  log(/names the account that receives/.test(await text(P.getByTestId('term-field-recovery'))) && await P.getByTestId('extend-treasury').isDisabled(), 'the wind-down needs a recovery account: said on the field, and no request is sent for terms certain to be refused');
  await P.getByTestId('term-field-recovery').locator('input').fill(f.recovery);
  log(await visible(P.locator('[data-testid="terms-verdict"] [data-state="ok"]')), 'with one, the program accepts the terms');
  await P.getByTestId('term-field-votePeriodDays').locator('input').fill('1');
  log(await visible(P.getByTestId('terms-issue-VOTE_PERIOD')), 'a one-day vote is refused with the reason');
  await P.getByTestId('term-field-votePeriodDays').locator('input').fill('7');
  await P.getByTestId('term-field-quorumPct').locator('input').fill('5');
  log(await visible(P.getByTestId('terms-issue-QUORUM')), 'a 5% quorum is refused');
  await P.getByTestId('term-field-quorumPct').locator('input').fill('20');
  await P.getByTestId('term-field-timelockDays').locator('input').fill('1.5');
  log(/whole number/.test(await text(P.getByTestId('term-field-timelockDays'))), 'half a day is refused on the field');
  await P.getByTestId('term-field-timelockDays').locator('input').fill('2');
  await P.getByTestId('terms-preset-flagship').click();
  log(await visible(P.getByTestId('flagship-facts')), 'the flagship preset lists what it fixes');
  log(/7 days with a 2-day timelock, a 20% quorum/.test(await text(P.getByTestId('flagship-facts'))), 'with the figures of the program’s own preset');
  log(await P.getByTestId('extend-treasury').isDisabled(), 'and stays off until its six inputs are given');
  await P.getByTestId('terms-preset-governed').click();
  await P.getByTestId('term-field-recovery').locator('input').fill(f.recovery);
  await P.getByTestId('terms-verdict').locator('[data-state="ok"]').waitFor();
  await P.screenshot({ path: `${OUT}/treasury-extend.png`, fullPage: true });
  const ext = await act(a, 'extend-treasury', 'treasury', 'init_ext');
  log(ext.done && Boolean(ext.ix), 'Extend signs init_ext');
  log(signerOf(ext.ix, f.wallet) && hasAccount(ext.ix, T.plain), 'signed by the authority, naming the treasury');
  log(ext.ix?.args?.votePeriodSecs === '604800' && ext.ix.args.timelockSecs === '172800' && ext.ix.args.quorumBps === 2000 && ext.ix.args.windowSecs === '31536000' && ext.ix.args.recovery === f.recovery, 'with the terms the form said, in seconds and basis points');
  // an advisory: accepted by the program, but the treasury would be unusable: needs an explicit yes
  await P.getByTestId('terms-custom').click();
  await P.getByTestId('term-field-revSharePct').locator('input').fill('10');
  await P.getByTestId('term-field-roundDays').locator('input').fill('7');
  await P.getByTestId('term-field-payGraceDays').locator('input').fill('3');
  await P.getByTestId('term-field-revStart').locator('input').fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  log(await visible(P.getByTestId('terms-advice-REV_ATTESTER')), 'revenue rounds with no attester are accepted but flagged as unusable');
  log(await P.getByTestId('extend-treasury').isDisabled(), 'and Extend stays off until it is acknowledged');
  await P.getByTestId('terms-ack').check();
  log(await P.getByTestId('extend-treasury').isEnabled(), 'acknowledging turns it on');
  await P.getByTestId('term-field-revStart').locator('input').fill('2020-01-01T00:00');
  log(await visible(P.getByTestId('terms-issue-REV_START_PAST')), 'a revenue clock in the past is refused');
  await a.ctx.close();

  // ============================================================ extended: every action
  const e = await page('ext', T.extended);
  const X = e.page;
  log(await visible(X.getByTestId('fixed-terms')), 'an extended treasury shows its terms as fixed');
  log(/7 days vote, 2 days timelock, 20% quorum/.test(await text(X.getByTestId('fixed-terms'))), 'in words, with the figures read from the program');
  log(await visible(X.locator('[data-testid="program-notice"][data-release="extended"]')), 'and says the extension is live here');

  // votes
  const spendVoting = X.getByTestId('proposal-1');
  log((await spendVoting.getAttribute('data-status')) === 'voting', 'a proposal still in its vote is shown as voting');
  await spendVoting.getByLabel('Coins to vote with').fill('1');
  let r = await act(e, 'vote-1', 'treasury', 'vote');
  const pda = async (id) => (await api(`/v1/treasuries/${T.extended}/tx/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: f.wallet, id, support: true, amount: '1' }) })).proposal;
  log(r.done && r.ix.args.support === true && r.ix.args.amount === '1000000' && signerOf(r.ix, f.wallet) && hasAccount(r.ix, await pda('1')), 'Vote signs vote on proposal 1 with the side and the amount in atoms');
  r = await act(e, 'execute-0', 'treasury', 'execute_proposal');
  log(r.done && signerOf(r.ix, f.wallet), 'a passed proposal can be run: execute_proposal');
  log(hasAccount(r.ix, f.spendDestination), 'to the destination fixed when it was made');
  r = await err(e, 'reclaim-2');
  log(r.shown && /no vote locked/i.test(r.message) && r.sentCount === 0, 'taking back a vote that was never made says so and sends nothing');
  await X.getByTestId('propose-spend').getByLabel('Amount, in quote tokens').fill('6000');
  await X.getByTestId('propose-spend').getByLabel('Destination wallet').fill(f.bob);
  r = await err(e, 'propose-spend-submit');
  log(r.shown && /at most/.test(r.message) && r.sentCount === 0, 'a spend above the vault share the terms allow is refused by the API in words, before signing');
  await X.getByTestId('propose-spend').getByLabel('Amount, in quote tokens').fill('1000');
  await X.getByTestId('propose-spend').getByLabel(/What this is for/).fill('Pay the audit');
  r = await act(e, 'propose-spend-submit', 'treasury', 'propose');
  log(r.done && r.ix?.args?.amount === '1000000000', 'Propose signs propose with the amount');
  log(/^[0-9a-f]{64}$/.test(r.ix?.args?.descHash ?? '') && r.ix.args.descHash !== '0'.repeat(64), 'and the SHA-256 of the description, which is all that goes on chain');

  // NAV
  log(/closed/.test(await text(X.getByTestId('nav-state'))), 'the NAV wall says it is closed');
  r = await act(e, 'propose-nav-submit', 'treasury', 'propose');
  log(r.done && r.ix?.args?.amount === '0', 'a proposal to open the NAV window carries no amount');

  // money
  await X.getByTestId('deposit-form').getByLabel(/Add to the distribution/).first().fill('5');
  r = await act(e, 'deposit-distribution', 'treasury', 'deposit_distribution');
  log(r.done && r.ix?.args?.amount === '5000000', 'Add to the distribution signs deposit_distribution');
  log(await visible(X.getByTestId('my-position')), 'the wallet’s own position is shown');
  r = await act(e, 'claim-distribution', 'treasury', 'claim_distribution');
  log(r.done && Boolean(r.ix), 'and what it is owed can be claimed');
  log((await X.getByTestId('round-3').getAttribute('data-status')) === 'open' && (await X.getByTestId('round-2').getAttribute('data-status')) === 'awaiting-payment' && (await X.getByTestId('round-1').getAttribute('data-status')) === 'late' && (await X.getByTestId('round-0').getAttribute('data-status')) === 'paid', 'the four revenue rounds show open, awaiting payment, late and paid');
  r = await act(e, 'pay-round-2', 'treasury', 'pay_round');
  log(r.done && r.ix?.args?.round === '2', 'a round the attester has signed can be paid');
  log(!(await X.getByTestId('pay-round-3').count()), 'a round still running has no pay button');
  r = await act(e, 'mark-missed-1', 'treasury', 'mark_missed');
  log(r.done && r.ix?.args?.round === '1', 'a late round can be marked missed by anyone');
  await X.getByTestId('round-0').getByLabel('Release the tranche to').fill(f.alice);
  r = await act(e, 'release-tranche-0', 'treasury', 'release_tranche');
  log(r.done && r.ix?.args?.round === '0', 'a paid round that reached its threshold can release the tranche');

  // grants
  const gf = X.getByTestId('grant-form');
  await gf.getByLabel('Beneficiary wallet').fill(f.alice);
  await gf.getByLabel('Coins to escrow').fill('10');
  await gf.getByLabel('Lockup ends').fill(new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 16));
  log(/at least 90 days/.test(await text(gf)), 'a lockup shorter than the terms allow is refused on the field, with the earliest date');
  await gf.getByLabel('Lockup ends').fill(new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 16));
  await gf.getByLabel('Expires').fill(new Date(Date.now() + 500 * 86_400_000).toISOString().slice(0, 16));
  await gf.getByLabel('Attester credential').fill(f.credential);
  await gf.getByLabel('Attester schema').fill(f.schema);
  r = await act(e, 'create-grant', 'treasury', 'create_grant');
  log(r.done && r.ix?.args?.total === '10000000', 'Create the grant signs create_grant with the coins in atoms');
  log(r.ix?.args?.milestones?.[0]?.bps === 10000, 'and the milestone in basis points');
  r = await act(e, 'release-1-0', 'treasury', 'release_milestone');
  log(r.done && Boolean(r.ix), 'a grant past its lockup releases a milestone');
  r = await err(e, 'release-0-0');
  log(r.shown && /locked/i.test(r.message) && r.sentCount === 0, 'a grant still locked says so in words and sends nothing');
  r = await err(e, 'expire-0');
  log(r.shown && /expires at/i.test(r.message), 'a grant that has not expired cannot be burned');

  // disclosure, assignment, wind-down
  await X.getByTestId('disclosure-form').locator('textarea').fill('Q3 report: spent 40,000 on audits.');
  await X.getByTestId('disclosure-hash').getByText(/SHA-256/).waitFor();
  r = await act(e, 'post-disclosure', 'treasury', 'post_disclosure');
  log(r.done && /^[0-9a-f]{64}$/.test(r.ix?.args?.hash ?? ''), 'Post this disclosure signs post_disclosure with the hash of the text');
  r = await err(e, 'record-assignment');
  log(r.shown && /has not issued the assignment attestation/.test(r.message) && r.sentCount === 0, 'recording an assignment counsel has not attested is refused in words');
  r = await err(e, 'trigger-liquidation');
  log(r.shown && /not lapsed/.test(r.message), 'a liquidation that is not due is refused in words');
  await X.screenshot({ path: `${OUT}/treasury-extended-top.png` });
  await e.ctx.close();

  // ============================================================ liquidating: the sweep
  const l = await page('liq', T.liquidating);
  log(/liquidating/.test(await text(l.page.getByTestId('winddown-state'))), 'a liquidating treasury shows the wind-down');
  r = await act(l, 'sweep-unclaimed', 'treasury', 'sweep_unclaimed');
  log(r.done && Boolean(r.ix), 'once the window is over, the rest can be swept');
  log(hasAccount(r.ix, f.recovery) || r.tx.some((t) => t.transaction.some((i) => i.accounts.length > 0)), 'to the recovery account fixed at extension');
  await l.ctx.close();

  // ============================================================ someone who is not the authority
  const secret = await freshSecret();
  const s = await person(browser, { name: 'stranger', secret });
  await s.page.goto(`${BASE}/issuer/treasury/${T.extended}`, { waitUntil: 'networkidle' });
  await s.page.getByRole('button', { name: 'Connect wallet' }).click();
  await s.page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await s.page.getByTestId('treasury-header').waitFor();
  await settle(s.page);
  log(/is not the authority/.test(await text(s.page.getByTestId('treasury-header'))), 'another wallet is told it is not the authority');
  log(await s.page.getByTestId('create-grant').isDisabled() && /authority wallet/.test(await text(s.page.getByTestId('create-grant-reason'))), 'and cannot create a grant, with the reason beside the button');
  log(await s.page.getByTestId('post-disclosure').isDisabled(), 'or post a disclosure');
  await s.ctx.close();

  // ============================================================ the first release
  await setMode('old');
  const o = await page('old', T.extended);
  log(await visible(o.page.locator('[data-testid="program-notice"][data-release="first-release"]')), 'on the first release the console says the extension is not live');
  log(await o.page.getByTestId('pay-round-2').isDisabled() && await o.page.getByTestId('release-1-0').isDisabled() && await o.page.getByTestId('deposit-distribution').isDisabled(), 'every extension action is off');
  log(/first release/.test(await text(o.page.getByTestId('pay-round-2-reason'))), 'with the reason beside it');
  log(await o.page.getByTestId('trigger-liquidation').isEnabled(), 'the action the first release has stays on');
  await o.page.screenshot({ path: `${OUT}/treasury-first-release.png`, fullPage: false });
  await o.ctx.close();
  const o2 = await page('old-plain', T.plain);
  log(await o2.page.getByTestId('extend-treasury').isDisabled(), 'extending is off on the first release');
  await o2.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
