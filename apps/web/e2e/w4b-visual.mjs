// W4B: every new page and state in light and dark at 1440 and 390: a full-page screenshot to read, axe (WCAG 2.1 A and AA), no horizontal overflow, and no
// console error, page error or failed request.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-visual.mjs [name-filter]
import { OUT, ensureConnected, failures, fixtures, launch, log, setMode, sleep, visualPass } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
const filter = process.argv[2];
const G = f.graduation;
const wait = (id) => (p) => p.page.getByTestId(id).waitFor({ timeout: 25000 });
const as = (address, id, extra) => async (p) => {
  await ensureConnected(p, address);
  await p.page.getByTestId(id).waitFor({ timeout: 25000 });
  if (extra) await extra(p);
  await sleep(600);
};

const states = [
  // graduation
  { name: 'grad-voting', route: `/crosses/${G.gradVoting}#graduation`, setup: wait('graduation-panel') },
  { name: 'grad-voting-holder', route: `/crosses/${G.gradVoting}#graduation`, secret: f.people.voter.secret, setup: as(f.people.voter.address, 'vote-box', async (p) => {
    await p.page.getByTestId('venue-dlmm').check();
    await p.page.getByLabel(/Tokens to lock/).fill('25');
  }) },
  { name: 'grad-outcome', route: `/crosses/${G.gradDoneDamm}#graduation`, setup: wait('graduation-outcome') },
  { name: 'grad-failed', route: `/crosses/${G.gradFailed}#graduation`, secret: f.people.voter.secret, setup: as(f.people.voter.address, 'withdraw-vote') },
  { name: 'grad-console', route: `/issuer/graduation?cross=${G.gradNew}`, secret: f.secret, setup: as(f.wallet, 'charter-form') },
  { name: 'grad-console-round', route: `/issuer/graduation?cross=${G.gradFailed}`, secret: f.secret, setup: as(f.wallet, 'start-round') },
  // settle: the tranche and the DAO
  { name: 'settle-tranche', route: `/issuer/settle?cross=${f.settle.settleCross}`, secret: f.secret, setup: as(f.wallet, 'tranche-steps') },
  { name: 'settle-governed', route: `/issuer/settle?cross=${G.gradDoneDamm}`, secret: f.secret, setup: as(f.wallet, 'governed-note') },
  // listing
  { name: 'listing-index', route: '/listing', setup: wait('venues') },
  { name: 'listing-venue', route: `/listing/${f.listing.venueMain}`, secret: f.people.lister.secret, setup: as(f.people.lister.address, 'bond-line', async (p) => { await p.page.waitForFunction(() => /Your bond: /.test(document.querySelector('[data-testid="bond-line"]')?.textContent ?? ''), null, { timeout: 25000 }); }) },
  { name: 'listing-console', route: '/issuer/listing', secret: f.secret, setup: as(f.wallet, 'venue-form') },
  { name: 'cross-listed', route: `/crosses/${f.listing.listWaiting}`, setup: wait('listing-badge-open') },
  // backing
  { name: 'backing-stale', route: `/backing/${f.backing.stale}`, setup: wait('backing-badge') },
  { name: 'backing-backed', route: `/backing/${f.backing.backed}`, setup: wait('backing-badge') },
  { name: 'backing-index', route: '/backing', setup: wait('policies') },
  { name: 'backing-console', route: `/issuer/backing?mint=${f.backing.noPolicy}`, secret: f.secret, setup: as(f.wallet, 'policy-form') },
  { name: 'cross-backing-banner', route: `/crosses/${f.backing.crosses.stale}`, setup: wait('backing-banner') },
  // bounty
  { name: 'bounty-index', route: '/bounties', setup: wait('bounties') },
  { name: 'bounty-view', route: `/bounties/${f.bounty.open}`, setup: wait('bounty-view') },
  { name: 'bounty-claim', route: `/bounties/${f.bounty.open}`, secret: f.people.hunter.secret, setup: as(f.people.hunter.address, 'bounty-view', async (p) => {
    await p.page.getByLabel('Cross address').fill(f.bounty.broken);
    await p.page.getByTestId('check-cross').click();
    await p.page.getByTestId('broken-0').waitFor({ timeout: 15000 });
  }) },
  { name: 'bounty-new', route: '/bounties/new', secret: f.people.sponsor.secret, setup: as(f.people.sponsor.address, 'bounty-form') },
  // mandates and agents
  { name: 'mandate-view', route: `/mandates/${f.mandate.active}`, setup: wait('mandate-view') },
  { name: 'mandate-owner', route: `/mandates/${f.mandate.active}`, secret: f.secret, setup: as(f.wallet, 'revoke-box') },
  { name: 'mandate-agent', route: `/mandates/${f.mandate.active}`, secret: f.people.agent.secret, setup: as(f.people.agent.address, 'order-box') },
  { name: 'mandates-home', route: '/mandates', secret: f.secret, setup: as(f.wallet, 'owned-list') },
  { name: 'agents', route: '/agents', setup: wait('guard-input') },
  // conviction and baskets
  { name: 'conviction', route: '/conviction', secret: f.people.voter.secret, setup: as(f.people.voter.address, 'locks') },
  { name: 'basket-view', route: `/baskets/${f.basket.main}`, setup: async (p) => {
    await p.page.getByTestId('basket-view').waitFor({ timeout: 25000 });
    await p.page.getByRole('textbox', { name: 'Shares' }).fill('1.5');
    await p.page.getByTestId('quote').waitFor({ timeout: 15000 });
    await sleep(600);
  } },
  { name: 'basket-index', route: '/baskets', setup: wait('baskets') },
  { name: 'basket-new', route: '/baskets/new', secret: f.people.voter.secret, setup: as(f.people.voter.address, 'basket-form') },
];

for (const s of states) {
  if (filter && !s.name.includes(filter)) continue;
  try {
    await visualPass(browser, { ...s, ignore: [] });
  } catch (e) {
    log(false, `${s.name}: ${e.stack ?? e}`);
  }
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void OUT;
