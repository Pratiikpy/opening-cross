// W4B: graduation by holder vote (D10, Z0). The Graduation tab of a governed cross (charter, rounds, tallies, quorum, the vote, finalizing, the outcome,
// withdrawing) and the issuer's console (charter, the first and later rounds, the mint-authority warning), each judged on the decoded transaction the
// wallet signed; the careless states (no wallet, an amount above the balance, a venue that is not the one already voted for, a charter out of bounds, the
// wrong wallet, an ungoverned cross) and the cluster that does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-graduation.mjs
import { act, clean, ensureConnected, failures, fixtures, go, hasAccount, ixOf, launch, log, person, refusedBy, reset, sent, setMode, signerOf, text, visible } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const G = f.graduation;
const P = f.people;
const tab = (p, cross) => go(p, `/crosses/${cross}#graduation`).then(() => p.page.getByTestId('graduation-panel').waitFor({ timeout: 25000 }));

try {
  // ------------------------------------------------------------------ a visitor reads a vote in progress
  const v = await person(browser, { name: 'visitor' });
  await tab(v, G.gradVoting);
  log((await v.page.getByTestId('graduation-panel').getAttribute('data-governed')) === 'true', 'a governed cross shows the Graduation tab with its panel');
  log((await v.page.getByTestId('feature-notice').first().getAttribute('data-state')) === 'live', 'the panel says the programs are live on this network');
  const status = await text(v.page.getByTestId('round-0-status'));
  log(/Voting/.test(status) && /Voting is open until/.test(await text(v.page.getByTestId('round-0-line'))), 'round 1 is Voting, with when it closes');
  const dlmm = v.page.getByTestId('round-0-tallies').locator('[data-venue="dlmm"]');
  log((await dlmm.getAttribute('data-locked')) === '180000000' && /180 · 56\.25%/.test(await text(dlmm)), 'each venue shows what is locked behind it and its share (DLMM 180, 56.25%)');
  const facts = await text(v.page.getByTestId('graduation-panel'));
  log(/Quorum needed400 \(40% of the live supply\)/.test(facts.replace(/\s+/g, '').replace('Quorumneeded', 'Quorumneeded')) || /Quorum needed\s*400 \(40% of the live supply\)/.test(facts), 'the quorum needed is 400 tokens, 40% of the live supply');
  log(/Quorum: 320 locked of 400 needed/.test(await text(v.page.getByTestId('round-0-short'))), 'it says what the round is short of: the quorum');
  log(/The charter/.test(facts) && /3 days|7 days per round/.test(facts) && /no volume gate/.test(facts), 'the charter is shown: quorum, 7 days, no volume gate');
  log(await v.page.getByTestId('cast-vote').isDisabled(), 'with no wallet the vote button is off');
  log(/Connect the wallet that holds the token/.test(await text(v.page.getByTestId('vote-box'))), 'and says to connect');
  await v.page.screenshot({ path: `${process.env.OUT}/grad-voting-visitor.png`, fullPage: true });
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ a holder votes
  const h = await person(browser, { name: 'holder', secret: P.voter.secret });
  await tab(h, G.gradVoting);
  await ensureConnected(h, P.voter.address);
  await h.page.getByText('you hold 400').waitFor({ timeout: 15000 });
  log(await h.page.getByTestId('cast-vote').isDisabled(), 'with a wallet but nothing chosen, the vote is off and says what to choose');
  await h.page.getByTestId('venue-dlmm').check();
  await h.page.getByLabel(/Tokens to lock/).fill('1000');
  log(/This wallet holds 400/.test(await text(h.page.getByTestId('vote-box'))) && (await h.page.getByTestId('cast-vote').isDisabled()), 'an amount above the balance is refused in words before anything is built');
  await h.page.getByLabel(/Tokens to lock/).fill('0.0000001');
  log(/at most 6 decimals/.test(await text(h.page.getByTestId('vote-box'))), 'an amount finer than the token is named');
  await h.page.getByLabel(/Tokens to lock/).fill('25');
  let r = await act(h, 'cast-vote');
  const vote = ixOf(r.tx, 'cross_graduate', 'cast_vote');
  log(r.done && vote && signerOf(vote, P.voter.address), 'Lock tokens and vote signs cast_vote by the holder');
  console.log('   cast_vote:', JSON.stringify(vote?.args));
  log(String(vote?.args?.amount) === '25000000' && vote?.args?.venue === 1, 'for 25 tokens (25000000 atoms) behind venue 1 (DLMM)');
  log(hasAccount(vote, G.roundVoting) && hasAccount(vote, G.mints[1]), 'naming the round and the token');
  await h.page.screenshot({ path: `${process.env.OUT}/grad-voting-holder.png`, fullPage: true });
  log(clean(h).length === 0, `holder: no console error or failed request ${clean(h).join(' | ')}`);
  await h.ctx.close();

  // ------------------------------------------------------------------ a holder who already voted cannot change venue
  const lv = await person(browser, { name: 'locked', secret: P.lockedVoter.secret });
  await tab(lv, G.gradVoting);
  await ensureConnected(lv, P.lockedVoter.address);
  await lv.page.getByTestId('my-lock').waitFor({ timeout: 15000 });
  log(/50 locked behind Meteora DLMM/.test(await text(lv.page.getByTestId('my-lock'))) && /cannot change venue/.test(await text(lv.page.getByTestId('my-lock'))), 'a wallet that voted sees its lock and that the venue cannot change');
  log((await lv.page.getByTestId('venue-damm_v2').isDisabled()) && (await lv.page.getByTestId('venue-dlmm').isChecked()), 'only the venue it voted for is offered');
  await lv.page.getByLabel(/Tokens to lock/).fill('10');
  r = await act(lv, 'cast-vote');
  log(r.done && ixOf(r.tx, 'cross_graduate', 'cast_vote')?.args?.venue === 1, 'adding to the stake signs a vote for the same venue');
  await lv.ctx.close();

  // ------------------------------------------------------------------ finalizing and publishing, open to anyone
  const a = await person(browser, { name: 'anyone', secret: P.other.secret });
  await tab(a, G.gradWaiting);
  await ensureConnected(a, P.other.address);
  log(/Waiting to be finalized/.test(await text(a.page.getByTestId('round-0-status'))) && /would pass/.test(await text(a.page.getByTestId('round-0-line'))), 'a closed round waits to be finalized, and says it would pass on the tally');
  r = await act(a, 'finalize-round');
  const fin = ixOf(r.tx, 'cross_graduate', 'finalize_round');
  log(r.done && fin && r.tx[0].feePayer === P.other.address, 'Finalize signs finalize_round, paid for by any wallet (the instruction needs no signer of its own)');
  await tab(a, G.gradPassed);
  log((await a.page.getByTestId('publish-outcome').count()) === 1 && /The round passed and chose Meteora DLMM/.test(await text(a.page.getByTestId('round-0-line'))), 'a passed round names the venue holders chose and offers to publish the outcome');
  r = await act(a, 'publish-outcome');
  const pub = ixOf(r.tx, 'cross_graduate', 'publish_outcome');
  log(r.done && pub && signerOf(pub, P.other.address), 'Publish signs publish_outcome by any wallet');
  console.log('   publish_outcome accounts:', pub?.accounts.length);
  await a.ctx.close();

  // ------------------------------------------------------------------ an outcome, and a failed round whose tokens are still locked
  const o = await person(browser, { name: 'outcome' });
  await tab(o, G.gradDoneFutarchy);
  log((await o.page.getByTestId('graduation-outcome').getAttribute('data-venue')) === 'metadao_futarchy' && /Holders chose MetaDAO futarchy DAO/.test(await text(o.page.getByTestId('graduation-outcome'))), 'a published outcome is shown on the cross page with the venue');
  log(/creator still has to supply the liquidity/.test(await text(o.page.getByTestId('graduation-outcome'))), 'and says the vote chooses the venue, not the amount');
  await tab(o, G.gradDoneDamm);
  log((await o.page.getByTestId('round-0-status').textContent()) === 'Failed' && (await o.page.getByTestId('round-1-status').textContent()) === 'Passed', 'a second round that passed after a failed first round shows both');
  await tab(o, G.gradNoCharter);
  log(/has not set the charter/.test(await text(o.page.getByTestId('no-charter'))), 'a governed cross with no charter says no vote can run');
  await go(o, `/crosses/${G.crossPlain}`);
  await o.page.getByRole('tab', { name: 'Rules' }).waitFor();
  log((await o.page.getByRole('tab', { name: 'Graduation' }).count()) === 0, 'a cross without the rule has no Graduation tab');
  await o.ctx.close();
  const w = await person(browser, { name: 'withdrawer', secret: P.voter.secret });
  await tab(w, G.gradFailed);
  await ensureConnected(w, P.voter.address);
  await w.page.getByTestId('withdraw-vote').waitFor({ timeout: 15000 });
  log(/The round failed/.test(await text(w.page.getByTestId('round-0-line'))), 'a failed round says the market has no venue until the creator opens another');
  log(/The token still has a mint authority/.test(await text(w.page.getByTestId('mint-authority-warning'))), 'a token that can still be minted is flagged: the supply, and so the quorum, can grow');
  r = await act(w, 'withdraw-vote');
  const wd = ixOf(r.tx, 'cross_graduate', 'withdraw_vote');
  log(r.done && wd && signerOf(wd, P.voter.address), 'Take my tokens back signs withdraw_vote by the voter');
  await w.ctx.close();

  // ------------------------------------------------------------------ the volume attester
  const at = await person(browser, { name: 'attester', secret: P.attester.secret });
  await tab(at, G.gradVolume);
  await ensureConnected(at, P.attester.address);
  await at.page.getByTestId('volume-box').waitFor({ timeout: 15000 });
  log(/1,200 of 5,000 required/.test(await text(at.page.getByTestId('graduation-panel'))) && /Organic volume: the attested figure is below the charter/.test(await text(at.page.getByTestId('round-0-short'))), 'a volume gate shows the attested figure against the minimum and that it is short');
  await at.page.getByLabel(/Organic volume to state/).fill('6000');
  r = await act(at, 'post-volume');
  const pv = ixOf(r.tx, 'cross_graduate', 'post_volume');
  log(r.done && pv && signerOf(pv, P.attester.address) && String(pv.args?.volumeQuote) === '6000000000', 'Post the volume signs post_volume by the attester for 6000 quote tokens');
  await at.ctx.close();

  // ------------------------------------------------------------------ the issuer console
  const c = await person(browser, { name: 'issuer', secret: f.secret });
  await go(c, `/issuer/graduation?cross=${G.gradNew}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('charter-form').waitFor({ timeout: 25000 });
  log(await c.page.getByTestId('init-charter').isEnabled(), 'the creator of a governed cross with no orders can set the charter (defaults: 25%, 7 days)');
  await c.page.getByLabel('Quorum, % of the live supply').fill('9');
  log(/10 to 100 percent/.test(await text(c.page.getByTestId('charter-form'))) && (await c.page.getByTestId('init-charter').isDisabled()), 'a quorum below 10% is named and the button is off');
  await c.page.getByLabel('Quorum, % of the live supply').fill('30');
  await c.page.getByLabel('Voting window, days').fill('2');
  log(/3 to 30/.test(await text(c.page.getByTestId('charter-form'))), 'a window under 3 days is named');
  await c.page.getByLabel('Voting window, days').fill('10');
  await c.page.getByLabel('Minimum organic volume, in quote tokens (optional)').fill('2500');
  log(/needs someone to attest/.test(await text(c.page.getByTestId('charter-form'))) && (await c.page.getByTestId('init-charter').isDisabled()), 'a volume minimum without an attester is refused in words');
  await c.page.getByLabel('Volume attester (optional)').fill(P.attester.address);
  r = await act(c, 'init-charter');
  const ch = ixOf(r.tx, 'cross_graduate', 'init_charter');
  log(r.done && ch && signerOf(ch, f.wallet), 'Set the charter signs init_charter by the creator');
  console.log('   init_charter:', JSON.stringify(ch?.args));
  log(ch?.args?.quorumBps === 3000 && String(ch?.args?.windowSecs) === String(10 * 86400) && String(ch?.args?.minVolume) === '2500000000', 'with 3000 bps, a 10 day window and a 2500 token volume minimum');
  await c.page.screenshot({ path: `${process.env.OUT}/grad-console-charter.png`, fullPage: true });
  // a cross that already took orders cannot get a charter
  await go(c, `/issuer/graduation?cross=${G.gradNoCharter}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('charter-form').waitFor({ timeout: 25000 });
  log(/before the first order/.test(await text(c.page.getByTestId('charter-too-late'))) && (await c.page.getByTestId('init-charter').isDisabled()), 'a cross that is no longer live cannot get a charter, and the page says the program would refuse it');
  // starting a round
  await go(c, `/issuer/graduation?cross=${G.gradFailed}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('start-round').waitFor({ timeout: 25000 });
  log(/Open round 2/.test(await text(c.page.locator('#start-h'))) && /mint authority/.test(await text(c.page.getByTestId('start-mint-authority-warning'))), 'after a failed round the creator opens round 2, with the mint-authority warning');
  r = await act(c, 'start-round');
  const sr = ixOf(r.tx, 'cross_graduate', 'start_round');
  log(r.done && sr && signerOf(sr, f.wallet), 'Open the round signs start_round by the creator');
  await go(c, `/issuer/graduation?cross=${G.gradDoneFutarchy}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('vote-passed').waitFor({ timeout: 25000 });
  log(/holders chose MetaDAO futarchy DAO/.test(await text(c.page.getByTestId('vote-passed'))) && (await c.page.getByRole('link', { name: 'Open the market' }).count()) >= 1, 'a passed vote with an outcome links to the settle page');
  await go(c, `/issuer/graduation?cross=${G.crossPlain}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('not-governed').waitFor({ timeout: 25000 });
  log(/did not set the governed-graduation rule/.test(await text(c.page.getByTestId('not-governed'))), 'an ungoverned cross says it has no vote');
  await c.page.screenshot({ path: `${process.env.OUT}/grad-console-ungoverned.png`, fullPage: true });
  log(clean(c, ['404']).length === 0, `issuer: no console error or failed request ${clean(c, ['404']).join(' | ')}`);
  await c.ctx.close();
  const s = await person(browser, { name: 'stranger', secret: P.other.secret });
  await go(s, `/issuer/graduation?cross=${G.gradNew}`);
  await ensureConnected(s, P.other.address);
  await s.page.getByTestId('not-creator').waitFor({ timeout: 25000 });
  log(/did not create this cross/.test(await text(s.page.getByTestId('not-creator'))) && (await s.page.getByTestId('init-charter').count()) === 0, 'a wallet that did not create the cross is told so and offered no charter');
  await s.ctx.close();

  // ------------------------------------------------------------------ the cluster has not got the programs
  await setMode('absent');
  const n = await person(browser, { name: 'absent', secret: P.voter.secret });
  await tab(n, G.gradVoting);
  await ensureConnected(n, P.voter.address);
  const notice = n.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 15000 });
  log(/Built, not on devnet yet/.test(await text(notice)) && /H27, H43/.test(await text(notice)), 'on a cluster without cross_graduate the panel says it is built, not on devnet yet, and why');
  log(/not deployed/.test(await text(n.page.getByTestId('graduation-note'))), 'the API’s own note is shown');
  log((await n.page.getByTestId('cast-vote').count()) === 0 && (await n.page.getByTestId('round-0-status').count()) === 0, 'no vote is offered, and no round is invented');
  await n.page.screenshot({ path: `${process.env.OUT}/grad-absent.png`, fullPage: true });
  log(clean(n).length === 0, `absent: no console error or failed request ${clean(n).join(' | ')}`);
  await n.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
void sent;
void visible;
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
