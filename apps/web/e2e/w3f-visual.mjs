// W3F: every new page and state in light and dark at 1440 and 390: a full-page screenshot to read, axe (WCAG 2.1 A and AA), no horizontal overflow,
// and no console error, page error or failed request.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-visual.mjs [name-filter]
import { OUT, ensureConnected, failures, fixtures, launch, log, setMode, sleep, visualPass } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
const filter = process.argv[2];
const S = f.series;
const wait = (id) => (p) => p.page.getByTestId(id).waitFor({ timeout: 20000 });
const as = (address, id, extra) => async (p) => {
  await ensureConnected(p, address);
  await p.page.getByTestId(id).waitFor({ timeout: 20000 });
  if (extra) await extra(p);
  await sleep(600);
};

const states = [
  { name: 'series-list', route: '/series', setup: wait('series-list') },
  { name: 'series-due', route: `/series/${S.due}`, setup: wait('spawn-verdict') },
  { name: 'series-early', route: `/series/${S.early}`, setup: wait('spawn-reason') },
  { name: 'series-authority', route: `/series/${S.due}`, secret: f.secret, setup: as(f.wallet, 'withdraw') },
  { name: 'series-console', route: '/issuer/series', secret: f.secret, setup: as(f.wallet, 'my-series', async (p) => {
    await p.page.getByTestId(`pick-${S.paused}`).click();
    await p.page.getByTestId('selected-series').waitFor();
    const form = p.page.getByTestId('series-form');
    await form.getByLabel('Token', { exact: true }).fill(f.baseMint);
    await form.getByLabel('Quote token').fill(f.quoteMint);
    await form.getByLabel('First slot closes').fill('2026-12-01T12:00');
    await form.getByLabel('First centre price, per token').fill('1.5');
    await form.getByLabel('Series number').fill('9');
    await p.page.getByTestId('series-summary').waitFor();
  }) },
  { name: 'halt-halted', route: `/halts/${f.mints.halted}`, setup: wait('halt-status') },
  { name: 'halt-clear', route: `/halts/${f.mints.clear}`, setup: wait('halt-status') },
  { name: 'halt-console', route: `/issuer/halts?mint=${f.mints.halted}`, secret: f.secret, setup: as(f.wallet, 'role-line') },
  { name: 'arbiter-visitor', route: '/arbiter', setup: wait(`cross-${f.challengeCross}`) },
  { name: 'arbiter-ruling', route: '/arbiter', secret: f.arbiter.secret, setup: as(f.arbiter.address, `ruling-${f.challengeCross}-0`, async (p) => {
    await p.page.getByTestId(`decision-uphold-${f.challengeCross}-1`).check();
    await p.page.getByTestId(`ruling-${f.challengeCross}-1`).getByLabel('Slash from the bond, in quote tokens').fill('30');
  }) },
  { name: 'winddown-redeeming', route: `/treasury/${f.windDown.redeeming}`, secret: f.secret, setup: as(f.wallet, 'winddown-steps', async (p) => { await p.page.getByTestId('entitlement').waitFor({ timeout: 15000 }); }) },
  { name: 'winddown-swept', route: `/treasury/${f.windDown.swept}`, setup: wait('winddown-steps') },
  { name: 'winddown-lapsing', route: `/treasury/${f.windDown.lapsing}`, setup: wait('winddown-steps') },
  { name: 'treasury-holder', route: `/treasury/${f.treasuries.extended}`, secret: f.secret, setup: as(f.wallet, 'propose') },
  { name: 'cross-refunds', route: `/crosses/${f.refundCross}`, secret: f.strangerWallet.secret, setup: as(f.strangerWallet.address, 'refund-panel') },
  { name: 'cross-halted', route: `/crosses/${f.haltedCross}`, setup: wait('halt-banner') },
  { name: 'calendar-series', route: '/calendar', setup: wait('series-list') },
  { name: 'dashboard', route: '/dashboard', setup: wait('programs-table') },
  { name: 'orders-sell-release', route: '/orders', secret: f.secret, setup: as(f.wallet, 'sell-release') },
  { name: 'settle-open', route: `/issuer/settle?cross=${f.settleCross}`, secret: f.secret, setup: as(f.wallet, 'venues', async (p) => {
    await p.page.getByTestId('open-damm').getByLabel('Open closed for a batch window').check();
    await p.page.getByTestId('open-dlmm').getByLabel('The base token needs a Token Badge').check();
  }) },
  { name: 'settle-meteora', route: `/issuer/settle?cross=${f.alphaVaultCross}`, secret: f.secret, setup: as(f.wallet, 'alpha-actions') },
  { name: 'settle-dbc', route: `/issuer/settle?cross=${f.dbcCross}`, secret: f.secret, setup: as(f.wallet, 'venues') },
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
