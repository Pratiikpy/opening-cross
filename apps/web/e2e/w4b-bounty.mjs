// W4B: the adversarial bounty (X10). The index and a bounty's page (terms, the eleven invariants and what each pays, what has been paid), a hunter checking a cross
// against the invariants and claiming, funding, the arbiter's award with the report's hash as evidence, the sponsor's withdrawal after the expiry, and posting a
// bounty; each judged on the decoded transaction the wallet signed, with the careless states (an honest cross, an invariant the bounty does not pay or has paid, a
// withdrawal before the expiry, a commitment under 30 days, no reward at all, the wrong wallet) and the cluster that does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-bounty.mjs
import { act, clean, ensureConnected, failures, fixtures, go, ixOf, launch, log, person, setMode, signerOf, text } from './w4b-lib.mjs';
import { createHash } from 'node:crypto';

const f = await fixtures();
const browser = await launch();
await setMode('new');
const X = f.bounty;
const P = f.people;
const check = async (p, cross) => {
  await p.page.getByLabel('Cross address').fill(cross);
  await p.page.getByTestId('check-cross').click();
};

try {
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/bounties');
  await v.page.getByTestId('bounties').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('bounties').locator('li').count()) === 3, 'the index lists the three bounties');
  log(/Pool 500 reward tokens/.test(await text(v.page.getByTestId(`bounty-${X.open}`))) && /Pays for 10 of 11 invariants/.test(await text(v.page.getByTestId(`bounty-${X.open}`))), 'each shows its pool and how many invariants it pays for');
  log(/expired on/.test(await text(v.page.getByTestId(`bounty-${X.expired}`))) && /commits its pool until/.test(await text(v.page.getByTestId(`bounty-${X.committed}`))), 'and whether it has expired or still commits its pool');
  await go(v, `/bounties/${X.open}`);
  await v.page.getByTestId('bounty-view').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('invariant-list').locator('li').count()) === 11, 'a bounty lists all eleven invariants');
  log(/not covered/.test(await text(v.page.locator('[data-testid="invariant-list"] li').nth(3))) && /10/.test(await text(v.page.locator('[data-testid="invariant-list"] li').nth(0))), 'with what each pays, and the one it leaves out');
  log(/Eleven invariants are not a proof of correctness/.test(await text(v.page.locator('#invariants'))), 'and says eleven invariants are not a proof of correctness');
  log(await v.page.getByTestId('claim-0').count() === 0, 'nothing can be claimed before a cross is checked');
  await go(v, `/bounties/${X.expired}`);
  await v.page.getByTestId('payouts').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('payouts').locator('li').count()) === 2 && /Arbiter award/.test(await text(v.page.getByTestId('payouts'))) && /report hash abab/.test(await text(v.page.getByTestId('payouts'))), 'an expired bounty lists what it paid, an invariant and an arbiter award with the report hash');
  log(/paid \(10\)/.test(await text(v.page.locator('[data-testid="invariant-list"] li').nth(0))), 'and marks the invariant that was paid');
  log(/nothing can be claimed any more/.test(await text(v.page.getByTestId('claim-expired'))), 'and says nothing can be claimed any more');
  await go(v, `/bounties/${f.settle.mint}`);
  await v.page.getByTestId('bounty-error').waitFor({ timeout: 25000 });
  log(/No bounty exists/.test(await text(v.page.getByTestId('bounty-error'))), 'an address that is not a bounty is said so');
  await go(v, `/bounties/${X.open}`);
  await v.page.getByTestId('bounty-view').waitFor();
  await check(v, X.honest);
  await v.page.getByTestId('check-honest').waitFor({ timeout: 15000 });
  log(/breaks none of the eleven invariants/.test(await text(v.page.getByTestId('check-honest'))) && (await v.page.locator('[data-testid^="claim-"]').count()) === 0, 'an honest cross breaks none, says so, and offers nothing to claim');
  await v.page.screenshot({ path: `${process.env.OUT}/bounty-view.png`, fullPage: true });
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ a hunter claims
  const h = await person(browser, { name: 'hunter', secret: P.hunter.secret });
  await go(h, `/bounties/${X.open}`);
  await ensureConnected(h, P.hunter.address);
  await h.page.getByTestId('bounty-view').waitFor({ timeout: 25000 });
  await check(h, X.broken);
  await h.page.getByTestId('broken-0').waitFor({ timeout: 15000 });
  log(/breaks invariant 1: more orders open than were ever placed/.test(await text(h.page.getByTestId('broken-0'))) && /pays 10 to your wallet/.test(await text(h.page.getByTestId('broken-0'))), 'a cross that breaks invariant 1 says which one and what it pays');
  const r = await act(h, 'claim-0');
  const cl = ixOf(r.tx, 'cross_bounty', 'claim_invariant');
  log(r.done && cl && signerOf(cl, P.hunter.address), `Claim signs claim_invariant by the hunter (${r.shape.join(', ')})`);
  console.log('   claim_invariant:', JSON.stringify(cl?.args));
  log(cl?.args?.invariant === 0, 'for invariant 0, naming the cross account');
  await h.page.screenshot({ path: `${process.env.OUT}/bounty-claim.png`, fullPage: true });
  await check(h, X.broken3);
  await h.page.getByTestId('broken-3').waitFor({ timeout: 15000 });
  log(/does not pay for it/.test(await text(h.page.getByTestId('broken-3'))) && (await h.page.getByTestId('claim-3').isDisabled()), 'an invariant the bounty does not pay is said so, and the claim is off');
  await go(h, `/bounties/${X.expired}`);
  await ensureConnected(h, P.hunter.address);
  await h.page.getByTestId('bounty-view').waitFor();
  await check(h, X.broken);
  await h.page.getByTestId('broken-0').waitFor({ timeout: 15000 });
  log(await h.page.getByTestId('claim-0').isDisabled(), 'an expired bounty’s claim is off');
  await h.page.getByLabel('Cross address').fill('not-an-address');
  log(/not a Solana address/.test(await text(h.page.getByTestId('section-claim'))) && (await h.page.getByTestId('check-cross').isDisabled()), 'a cross address that is not one is named, and the check is off');
  log(clean(h).length === 0, `hunter: no console error or failed request ${clean(h).join(' | ')}`);
  await h.ctx.close();

  // ------------------------------------------------------------------ funding
  const s = await person(browser, { name: 'sponsor', secret: P.sponsor.secret });
  await go(s, `/bounties/${X.open}`);
  await ensureConnected(s, P.sponsor.address);
  await s.page.getByTestId('fund-bounty').waitFor({ timeout: 25000 });
  log(await s.page.getByTestId('fund-bounty').isDisabled(), 'Fund is off until an amount is typed');
  await s.page.getByLabel(/^Amount/).fill('50');
  const fr = await act(s, 'fund-bounty');
  const fx = ixOf(fr.tx, 'cross_bounty', 'fund');
  log(fr.done && fx && signerOf(fx, P.sponsor.address) && String(fx.args?.amount) === '50000000', 'Fund signs fund by any wallet for 50 tokens');
  log((await s.page.getByTestId('withdraw-bounty').count()) === 1 && (await s.page.getByTestId('withdraw-bounty').isDisabled()) && /committed until/.test(await text(s.page.getByTestId('withdraw-bounty-reason'))), 'the sponsor sees Withdraw, off, with the day the pool is committed until');
  await s.ctx.close();

  // ------------------------------------------------------------------ the arbiter
  const a = await person(browser, { name: 'arbiter', secret: P.arbiter.secret });
  await go(a, `/bounties/${X.open}`);
  await ensureConnected(a, P.arbiter.address);
  await a.page.getByTestId('award-box').waitFor({ timeout: 25000 });
  log(await a.page.getByTestId('award').isDisabled(), 'the arbiter’s Award is off until the hunter, the amount and the report are given');
  await a.page.getByLabel('Hunter’s wallet').fill(P.hunter.address);
  await a.page.getByLabel('Amount to award').fill('75');
  await a.page.getByLabel('The report').fill('Reentrancy in the claim path: details attached.');
  const want = createHash('sha256').update('Reentrancy in the claim path: details attached.').digest('hex');
  await a.page.getByText(`SHA-256: ${want}`).waitFor({ timeout: 10000 });
  log(true, 'the report’s SHA-256 is computed in the browser and shown');
  const ar = await act(a, 'award');
  const aw = ixOf(ar.tx, 'cross_bounty', 'award');
  log(ar.done && aw && signerOf(aw, P.arbiter.address) && String(aw.args?.amount) === '75000000', 'Award signs award by the arbiter for 75 tokens');
  log(JSON.stringify(aw?.args).includes(want), 'carrying the report’s hash as evidence');
  await go(a, `/bounties/${X.expired}`);
  await ensureConnected(a, P.arbiter.address);
  await a.page.getByTestId('award-box').waitFor({ timeout: 25000 });
  await a.page.getByLabel('Hunter’s wallet').fill(P.hunter.address);
  await a.page.getByLabel('Amount to award').fill('5');
  await a.page.getByLabel('The report').fill('late');
  await a.page.getByText(/SHA-256: [0-9a-f]{64}/).waitFor();
  log(await a.page.getByTestId('award').isDisabled() && /expired: the arbiter awards only before the expiry/.test(await text(a.page.getByTestId('award-reason'))), 'after the expiry the arbiter’s Award is off, and says why');
  await a.ctx.close();

  // ------------------------------------------------------------------ the sponsor withdraws after the expiry
  const w = await person(browser, { name: 'withdrawer', secret: f.secret });
  await go(w, `/bounties/${X.expired}`);
  await ensureConnected(w, f.wallet);
  await w.page.getByTestId('withdraw-bounty').waitFor({ timeout: 25000 });
  log(await w.page.getByTestId('withdraw-bounty').isEnabled(), 'after the expiry the sponsor can withdraw');
  const wr = await act(w, 'withdraw-bounty');
  const wx = ixOf(wr.tx, 'cross_bounty', 'withdraw');
  log(wr.done && wx && signerOf(wx, f.wallet), 'Withdraw signs withdraw by the sponsor');
  await go(w, `/bounties/${X.open}`);
  await ensureConnected(w, f.wallet);
  await w.page.getByTestId('bounty-view').waitFor();
  log((await w.page.getByTestId('withdraw-bounty').count()) === 0, 'a wallet that is not the sponsor is not offered Withdraw');
  await w.ctx.close();

  // ------------------------------------------------------------------ posting a bounty
  const n = await person(browser, { name: 'poster', secret: P.sponsor.secret });
  await go(n, '/bounties/new');
  await ensureConnected(n, P.sponsor.address);
  await n.page.getByTestId('bounty-form').waitFor({ timeout: 25000 });
  log(await n.page.getByTestId('create-bounty').isDisabled(), 'Post is off until the form is filled');
  await n.page.getByLabel('Reward token').fill(X.rewardMint);
  await n.page.getByLabel('Arbiter', { exact: true }).fill(P.arbiter.address);
  await n.page.getByLabel('Committed for, days').fill('20');
  log(/at least 30 days/.test(await text(n.page.getByTestId('bounty-form'))), 'a commitment under 30 days is named');
  await n.page.getByLabel('Committed for, days').fill('45');
  log(await n.page.getByTestId('create-bounty').isDisabled(), 'with no reward set, Post stays off');
  await n.page.getByLabel(/^1\. more orders open/).fill('25');
  await n.page.getByLabel(/^6\. a fee above/).fill('40');
  const pr = await act(n, 'create-bounty');
  const cb = ixOf(pr.tx, 'cross_bounty', 'create_bounty');
  console.log('   create_bounty:', JSON.stringify(cb?.args));
  log(pr.done && cb && signerOf(cb, P.sponsor.address) && cb.args?.rewards?.[0] === '25000000' && cb.args?.rewards?.[5] === '40000000' && cb.args?.rewards?.[1] === '0', 'Post signs create_bounty with 25 for invariant 1, 40 for invariant 6 and nothing for the rest');
  await n.page.getByTestId('made').waitFor();
  log(/to fund the pool/.test(await text(n.page.getByTestId('made'))), 'and says the pool is still empty: fund it');
  await n.page.screenshot({ path: `${process.env.OUT}/bounty-new.png`, fullPage: true });
  log(clean(n).length === 0, `poster: no console error or failed request ${clean(n).join(' | ')}`);
  await n.ctx.close();

  // ------------------------------------------------------------------ the program is not on the cluster
  await setMode('absent');
  const z = await person(browser, { name: 'absent', secret: P.hunter.secret });
  await go(z, `/bounties/${X.open}`);
  await z.page.getByTestId('bounty-not-deployed').waitFor({ timeout: 25000 });
  const notice = z.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 15000 });
  log(/Built, not on devnet yet/.test(await text(notice)), 'on a cluster without cross_bounty the page says it is built, not on devnet yet');
  await go(z, '/bounties/new');
  await ensureConnected(z, P.hunter.address);
  await z.page.getByLabel('Reward token').fill(X.rewardMint);
  await z.page.getByLabel('Arbiter', { exact: true }).fill(P.arbiter.address);
  await z.page.getByLabel(/^1\. more orders open/).fill('25');
  log(await z.page.getByTestId('create-bounty').isDisabled() && /not on devnet yet/.test(await text(z.page.getByTestId('create-bounty-reason'))), 'posting is off with a valid form, and says why');
  await z.page.screenshot({ path: `${process.env.OUT}/bounty-absent.png`, fullPage: true });
  log(clean(z).length === 0, `absent: no console error or failed request ${clean(z).join(' | ')}`);
  await z.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
