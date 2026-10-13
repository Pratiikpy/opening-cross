// The issue wizard's Rules step against the harness (services/api/test/helpers/issuer-harness.ts): every claim is checked on the
// transactions the wallet signed and the harness recorded, decoded to instructions and accounts.
//
//   FROM=... node e2e/issuer-w3b-wizard.mjs      (see issuer-w3b-lib.mjs for how to start the harness and the app)
import { BASE, OUT, api, connect, failures, find, fixtures, gone, hasAccount, launch, log, person, reset, sent, setMode, settle, shape, signerOf, text, visible, visualPass } from './issuer-w3b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();

async function readMints(page) {
  await page.getByLabel('Token being sold (base mint)').fill(f.baseMint);
  await page.getByLabel('Paid in (quote mint)').fill(f.quoteMint);
  await page.getByRole('button', { name: 'Check mint' }).first().click();
  await page.getByRole('button', { name: 'Check mint' }).nth(1).click();
  await page.getByTestId('autofill').waitFor({ timeout: 20000 });
  await page.getByLabel('Step 1: price').fill('1.20');
  await page.getByLabel('Tokens offered').fill('1000');
}
const open = async (page, id) => {
  const g = page.getByTestId(`rules-group-${id}`);
  if ((await g.getAttribute('open')) === null) await g.locator('summary').click();
};
const field = (page, key) => page.getByTestId(`rule-field-${key}`).locator('input');
const check = (page) => page.getByTestId('rules-check');
const size = (page) => page.getByTestId('rules-size');

try {
  // ============================================================ explore: the rules step without a wallet
  const a = await person(browser, { name: 'explorer' });
  await a.page.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  log(await visible(a.page.locator('#rules')), 'the wizard has a Rules step');
  log(/created exactly as it is today/.test(await text(a.page.locator('#rules'))), 'it says that leaving every rule empty creates the cross as it is today');
  log((await a.page.getByTestId('rule-presets').getByRole('button').count()) >= 7, 'presets are offered');
  log(/No rule is set/.test(await text(check(a.page))), 'with no rule, there is nothing to check and it says so');
  log(await a.page.getByTestId('step-rules').getAttribute('data-status') === 'optional', 'the checklist lists the rules step as optional');
  log(/Live on devnet/.test(await text(a.page.getByTestId('program-notice').first())) || (await a.page.getByTestId('program-notice').first().getAttribute('data-release')) === 'extended', 'on a network with the extension, the page says it is live');

  await readMints(a.page);
  await a.page.getByTestId('rule-preset-hard-to-game-ending').click();
  log((await field(a.page, 'endingMins').inputValue()) === '30' && (await field(a.page, 'buckets').inputValue()) === '6', 'the ending preset fills 30 minutes and 6 buckets');
  log(await a.page.getByTestId('rule-drawnEnd').isChecked(), 'and switches the drawn end on');
  log(/conventions of this product/.test(await text(a.page.getByTestId('rule-preset-note'))), 'the preset says its values are conventions and editable');
  log(await visible(check(a.page).locator('[data-state="ok"]')), 'the rules are accepted by the API (the SDK check), without a wallet');
  log(/Connect a wallet to measure/.test(await text(size(a.page))), 'the size is measured only for a wallet, and says so');
  log(await visible(a.page.getByTestId('view-ending')), 'a "what bidders will see" card for the ending appears');
  log(/draws which bucket is the last one counted/.test(await text(a.page.getByTestId('view-ending'))), 'it says the cluster draws the last counted bucket');
  log(/before the close/.test(await text(a.page.getByTestId('view-cancel'))), 'and when cancels close');
  log(await a.page.getByTestId('step-rules').getAttribute('data-status') === 'done', 'the checklist marks the rules step done');

  // a refused rule: the SDK's sentence beside the field, Create stays off
  await field(a.page, 'buckets').fill('1');
  log(await visible(a.page.getByTestId('rule-issue-ENDING_DRAW')), 'a drawn end with one bucket is refused with the program’s reason');
  log(/at least two buckets/.test(await text(a.page.getByTestId('rule-field-buckets'))) || /at least two buckets/.test(await text(a.page.getByTestId('rule-issue-ENDING_DRAW'))), 'the reason is on the field');
  log(await a.page.getByTestId('step-rules').getAttribute('data-status') === 'blocked', 'the checklist marks the rules step blocked');
  await field(a.page, 'buckets').fill('6');
  await field(a.page, 'endingMins').fill('1.5');
  log(/whole number/.test(await text(a.page.getByTestId('rule-field-endingMins'))), 'a half minute is refused on the field before anything is asked of the API');
  await field(a.page, 'endingMins').fill('300');
  log(await visible(a.page.getByTestId('rule-issue-ENDING')), 'an ending period longer than the call is refused');
  await field(a.page, 'endingMins').fill('30');

  // identity limits need a gate
  await open(a.page, 'identity');
  await field(a.page, 'identityMaxOrders').fill('1');
  log(await visible(a.page.getByTestId('rule-issue-IDENTITY_NEEDS_GATE')), 'a limit per identity without a gate is refused with the reason');
  await a.page.screenshot({ path: `${OUT}/wizard-explore-refused.png`, fullPage: false });

  // ============================================================ with a wallet: size, create, the transactions
  const w = await person(browser, { name: 'issuer', secret: f.secret });
  const p = w.page;
  await p.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  await connect(w, f.wallet);
  await readMints(p);
  await p.getByTestId('rule-preset-hard-to-game-ending').click();
  await visible(size(p).locator('[data-state="one"]'), 20000);
  log(await visible(size(p).locator('[data-state="one"]')), 'the creation, the quote account and the rules fit one transaction, and the page says how many bytes of 1232');
  log(/of the 1232 bytes/.test(await text(size(p))), 'the sentence names the limit');
  log(await visible(p.getByTestId('check-rules-size').locator('visible=true')) || (await p.getByTestId('check-rules-size').getAttribute('data-status')) === 'pass', 'the readiness list carries the size check');
  log((await p.getByTestId('check-rules-program').getAttribute('data-status')) === 'pass', 'and the check that the network can create a cross with rules');

  await p.getByLabel('Orders open').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await settle(p);
  await p.screenshot({ path: `${OUT}/wizard-wallet-ready.png`, fullPage: true });
  const create = p.getByTestId('create-ruled');
  await create.waitFor({ timeout: 10000 });
  log(await create.isEnabled(), 'with everything ready, Create the cross with its rules is on');
  await reset();
  await create.click();
  log(await visible(p.getByTestId('created-cross'), 60000), 'the cross is created');
  const tx = await sent();
  const created = shape(tx);
  console.log('sent:', JSON.stringify(created));
  const cc = find(tx, 'cross_core', 'create_cross');
  const sr = find(tx, 'cross_core', 'set_rules');
  log(Boolean(cc) && Boolean(sr), 'the wallet signed create_cross and set_rules');
  log(cc?.signature === sr?.signature, 'both are in the same transaction (the rules are accepted only in the creating slot)');
  log(signerOf(cc, f.wallet) && hasAccount(cc, f.baseMint) && hasAccount(cc, f.quoteMint), 'create_cross is signed by the issuer and names the two mints');
  log(sr?.args?.ending?.endingSecs === 1800 && sr?.args?.ending?.buckets === 6 && sr?.args?.ending?.randomEnd === true && sr?.args?.ending?.cancelCutoffSecs === 1800, 'set_rules carries exactly the ending the form said');
  log(sr?.args?.flags === 0 && sr?.args?.guards?.minRaiseQuote === '0', 'and nothing else is on');
  log(tx.length >= 4 && tx.slice(1).every((t) => t.transaction.length === 1 && t.transaction[0].instruction === 'init_shard'), 'the shards follow, one transaction each');
  await w.ctx.close();

  // ============================================================ the two-transaction fallback and the one that cannot fit
  const g = await person(browser, { name: 'issuer-size', secret: f.secret });
  const q = g.page;
  await q.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  await connect(g, f.wallet);
  await readMints(q);
  // a gate and an oracle guard, as in the measurement that found where the limit is
  await q.getByTestId('gate-option-attested-wallet').check({ force: true });
  await q.getByTestId('gate-mint-input').fill(f.gateMint);
  await q.getByTestId('gate-credential-input').fill(f.credential);
  await q.getByTestId('gate-schema-input').fill(f.schema);
  await q.getByText('Add an oracle guard').click();
  await q.getByLabel('Pyth feed id (64 hex characters)').fill('ab'.repeat(32));
  await q.getByLabel('Largest allowed difference, %').fill('2');
  await q.getByTestId('rule-preset-declared-insiders').click();
  await open(q, 'neutrality');
  await field(q, 'bond').fill('1');
  await field(q, 'challengeDays').fill('1');
  const insiders = [f.alice, f.bob, f.stranger, f.attester, f.recovery, f.credential, f.schema, f.feeRecipient];
  let twoAt = null;
  let tooLargeAt = null;
  for (let n = 1; n <= 8; n++) {
    await q.getByTestId('add-insiders').click();
    await q.getByLabel(`Insider wallet ${n}`, { exact: true }).fill(insiders[n - 1]);
    const state = await q.waitForFunction(() => { const s = document.querySelector('[data-testid="rules-size"] [data-state]'); return s ? s.getAttribute('data-state') : null; }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
    await sleep(700);
    const now = await q.locator('[data-testid="rules-size"] [data-state]').first().getAttribute('data-state').catch(() => null);
    if (now === 'two' && twoAt === null) twoAt = n;
    if (now === 'too-large' && tooLargeAt === null) tooLargeAt = n;
    void state;
  }
  console.log('two transactions from', twoAt, 'insiders; too large at', tooLargeAt);
  log(twoAt !== null && twoAt >= 4 && twoAt <= 7, `with ${twoAt} insiders the page switches to two opening transactions`);
  log(tooLargeAt === 8, `with 8 insiders the creation and the rules no longer fit one transaction and the page says so (${tooLargeAt})`);
  log(/Name fewer insiders/.test(await text(size(q))) || /over the 1232/.test(await text(size(q))), 'the refusal names the way out');
  log(await q.getByTestId('create-ruled').isDisabled(), 'Create stays off when the rules cannot fit');
  log((await q.getByTestId('check-rules-size').getAttribute('data-status')) === 'fail', 'the readiness list fails the size check');
  await q.screenshot({ path: `${OUT}/wizard-too-large.png`, fullPage: true });

  // ---- six insiders: two opening transactions, in order
  await q.getByLabel('Remove insider wallet 8').click();
  await q.getByLabel('Remove insider wallet 7').click();
  await q.waitForFunction(() => document.querySelector('[data-testid="rules-size"] [data-state]')?.getAttribute('data-state') === 'two', null, { timeout: 20000 });
  log(/sent as two, in order/.test(await text(size(q))), 'the page says exactly why it is two transactions and in what order');
  log(/accepts them only in the slot the cross is created in/.test(await text(size(q))), 'and why the rules cannot move out of the creation transaction');
  await q.screenshot({ path: `${OUT}/wizard-two-transactions.png`, fullPage: true });
  await reset();
  await q.getByLabel('Orders open').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await q.getByTestId('create-ruled').click();
  log(await visible(q.getByTestId('created-cross'), 60000), 'the two-transaction creation completes');
  const two = await sent();
  const sh = shape(two);
  log(sh[0].length === 2 && !sh[0].some((x) => x.startsWith('cross_core')), 'the first transaction holds the quote account and the handover of the mint authority, and nothing of the cross');
  log(sh[1].join() === 'cross_core.create_cross,cross_core.set_rules', 'the second holds create_cross and set_rules together');
  const sr6 = find(two, 'cross_core', 'set_rules');
  log(sr6?.args?.neutrality?.insiders?.length === 6 && sr6.args.neutrality.insiders.includes(f.alice) && sr6.args.neutrality.insiders.includes(f.recovery), 'set_rules names the six insiders the form listed');
  log(sr6?.args?.neutrality?.bondQuote === '1000000' && sr6?.args?.neutrality?.challengeSecs === 86400, 'with the bond and the challenge window');
  await g.ctx.close();

  // ---- a half-landed creation: the first transaction lands, the second does not; finishing sends only the rest
  const h = await person(browser, { name: 'issuer-resume', secret: f.secret });
  const r = h.page;
  await r.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  await connect(h, f.wallet);
  await readMints(r);
  await r.getByTestId('gate-option-attested-wallet').check({ force: true });
  await r.getByTestId('gate-mint-input').fill(f.gateMint);
  await r.getByTestId('gate-credential-input').fill(f.credential);
  await r.getByTestId('gate-schema-input').fill(f.schema);
  await r.getByText('Add an oracle guard').click();
  await r.getByLabel('Pyth feed id (64 hex characters)').fill('ab'.repeat(32));
  await r.getByLabel('Largest allowed difference, %').fill('2');
  await r.getByTestId('rule-preset-declared-insiders').click();
  await open(r, 'neutrality');
  await field(r, 'bond').fill('1');
  await field(r, 'challengeDays').fill('1');
  for (let n = 1; n <= 6; n++) {
    await r.getByTestId('add-insiders').click();
    await r.getByLabel(`Insider wallet ${n}`, { exact: true }).fill(insiders[n - 1]);
  }
  await r.waitForFunction(() => document.querySelector('[data-testid="rules-size"] [data-state]')?.getAttribute('data-state') === 'two', null, { timeout: 20000 });
  await r.getByLabel('Orders open').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await reset();
  await api('/__fail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ in: 2 }) });
  await r.getByTestId('create-ruled').click();
  log(await visible(r.getByTestId('unfinished-creation'), 30000), 'when the second transaction fails the page says the cross was not created and what landed');
  log(/1 of \d+ transactions landed/.test(await text(r.getByTestId('unfinished-creation'))), 'it counts what landed');
  const half = await sent();
  log(half.length === 1 && !half[0].transaction.some((x) => x.program === 'cross_core'), 'only the quote account and handover transaction landed');
  await r.screenshot({ path: `${OUT}/wizard-half-landed.png`, fullPage: true });
  await r.getByTestId('resume-creation').click();
  log(await visible(r.getByTestId('created-cross'), 60000), 'finishing creates the cross');
  const after = await sent();
  const rest = shape(after.slice(1));
  log(rest[0].join() === 'cross_core.create_cross,cross_core.set_rules', 'finishing sends the creation next, not the first transaction again');
  console.log('after the creation:', JSON.stringify(rest.slice(1)));
  log(rest.slice(1).length > 0 && rest.slice(1).every((x) => /^cross_core.init_(shard|lock_vault|class_book)$/.test(x.join())), 'and then the shards, and the lock vault the insiders need');
  await h.ctx.close();

  // ---- no rules: the cross is created by the route it always was, with no rules tail
  const n0 = await person(browser, { name: 'issuer-plain', secret: f.secret });
  const t = n0.page;
  await t.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  await connect(n0, f.wallet);
  await readMints(t);
  await t.getByLabel('Orders open').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await reset();
  await t.getByRole('button', { name: 'Create the cross', exact: true }).click();
  log(await visible(t.getByTestId('created-cross'), 60000), 'a cross with no rules is created as it always was');
  const plain = await sent();
  log(Boolean(find(plain, 'cross_core', 'create_cross')) && !find(plain, 'cross_core', 'set_rules'), 'with create_cross and no set_rules');
  // the draft, with its rules, survives a reload
  await t.getByRole('button', { name: 'Start a new draft' }).click();
  await readMints(t);
  await t.getByTestId('rule-preset-anti-flip').click();
  await sleep(900);
  await t.reload({ waitUntil: 'networkidle' });
  log(await visible(t.getByTestId('restored-note')), 'a reload restores the draft');
  await open(t, 'alloc');
  log((await field(t, 'minLockDays').inputValue()) === '90' && (await field(t, 'reserveLockedPct').inputValue()) === '30', 'with the rules it held');
  await n0.ctx.close();

  // ============================================================ the first release: nothing the program cannot do is offered
  await setMode('old');
  const o = await person(browser, { name: 'issuer-old', secret: f.secret });
  const u = o.page;
  await u.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  await connect(o, f.wallet);
  await readMints(u);
  await u.getByTestId('rule-preset-hard-to-game-ending').click();
  log(await visible(u.locator('[data-testid="program-notice"][data-release="first-release"]')), 'on the first release the page says the rules are not live on this network');
  log(/H27/.test(await text(u.locator('[data-testid="program-notice"][data-release="first-release"]'))), 'and which step makes them live');
  log((await u.getByTestId('check-rules-program').getAttribute('data-status')) === 'fail', 'the readiness list fails the network check');
  log(await u.getByTestId('create-ruled').isDisabled(), 'creating with rules is off');
  log(/first release/.test(await text(u.getByTestId('create-ruled-reason'))), 'and says why in plain words');
  log((await u.getByTestId('step-rules').getAttribute('data-status')) === 'blocked', 'the checklist marks the rules step blocked');
  await u.screenshot({ path: `${OUT}/wizard-first-release.png`, fullPage: true });
  await reset();
  await u.getByTestId('rules-clear').click();
  await sleep(500);
  log(await u.getByRole('button', { name: 'Create the cross', exact: true }).isEnabled(), 'clearing the rules brings back the plain Create, which the first release can do');
  await o.ctx.close();

  // the API cannot say which release is deployed: the creation is simulated on the cluster first, and the cluster refuses it
  const x = await person(browser, { name: 'issuer-unknown', secret: f.secret });
  await x.page.route('**/v1/programs', (route) => route.abort());
  await x.page.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  await connect(x, f.wallet);
  await readMints(x.page);
  await x.page.getByTestId('rule-preset-hard-to-game-ending').click();
  log(await visible(x.page.locator('[data-testid="program-notice"][data-release="unknown"]')), 'with no answer about the release, the page says it is not confirmed');
  await x.page.getByLabel('Orders open').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await visible(size(x.page).locator('[data-state]'), 20000);
  await reset();
  const go = x.page.getByTestId('create-ruled');
  await sleep(600);
  log(await go.isEnabled(), 'Create stays on, because nothing says it would fail');
  await go.click();
  log(await visible(x.page.getByTestId('create-ruled-error'), 20000), 'but the dry run on the cluster refuses it');
  log(/does not have this instruction yet/.test(await text(x.page.getByTestId('create-ruled-error'))), 'in words that name the first release');
  log((await sent()).length === 0, 'and nothing was signed or sent');
  await x.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
void visualPass;
void gone;
void api;
void OUT;
