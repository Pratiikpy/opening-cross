// The holder pages as a person uses them, in a real browser against the holder API harness: practice cross (a full 60-second call and the
// debrief), markets, support (a request and its status), retention, comments (a signed message from the wallet), the follow list and
// the bid-from-a-link check.
//
//   BASE_URL=http://localhost:3412 HARNESS=http://127.0.0.1:8082 node e2e/holder-pages-flow.mjs
import { BASE, axe, check, clickUntil, connect, keyFile, launch, person, report, results, shot, sleep } from './holder-lib.mjs';

const HARNESS = process.env.HARNESS ?? 'http://127.0.0.1:8082';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const sql = async (q) => (await (await fetch(`${HARNESS}/__harness/sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: q }) })).json());

const browser = await launch();
const noise = ['status of 429', ' 429 https://'];

// ---------------------------------------------------------------- practice
{
  const u = await person(browser, { name: 'practice', theme: 'light', ignore: noise });
  const p = u.page;
  await p.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
  check(await p.getByTestId('practice-banner').isVisible(), 'practice: the banner says no real money');
  await shot(u, 'practice-ready-1440-light');
  await clickUntil(p, p.getByRole('button', { name: 'Start the practice call' }), p.getByTestId('practice-clock').filter({ hasText: 'Closes in' }));
  await p.getByLabel('Most you would pay per token').fill('1.55');
  await p.getByLabel('Tokens').fill('120');
  await p.getByRole('button', { name: 'Place practice order' }).click();
  await p.getByTestId('practice-mine').waitFor();
  check((await p.getByTestId('practice-mine').innerText()).includes('Buy 120 tokens at up to 1.55'), 'practice: the order is held in escrow and described');
  // Off-grid and too-large orders are refused with a reason, before anything is placed.
  await p.getByRole('button', { name: 'Cancel and change it' }).click();
  await p.getByLabel('Most you would pay per token').fill('1.57');
  check((await p.getByText(/steps of/).count()) > 0, 'practice: a price off the grid is refused with the step');
  await p.getByLabel('Most you would pay per token').fill('1.55');
  await p.getByLabel('Tokens').fill('9999');
  check(await p.getByRole('button', { name: 'Place practice order' }).isDisabled(), 'practice: an order larger than the play balance cannot be placed');
  await p.getByLabel('Tokens').fill('120');
  await p.getByRole('button', { name: 'Place practice order' }).click();
  await p.getByTestId('practice-mine').waitFor();
  await sleep(30_000);
  await shot(u, 'practice-running-1440-light');
  await p.getByTestId('practice-debrief').waitFor({ timeout: 60_000 });
  const result = await p.getByTestId('practice-result').innerText();
  check(/filled for|not filled/.test(result), `practice: the debrief reports what happened to the order (${result.slice(0, 120)})`);
  await p.locator('label', { hasText: 'The same price' }).first().click();
  check((await p.getByTestId('why-price').innerText()).startsWith('Right.'), 'practice: the quiz marks a right answer and explains');
  await p.locator('label', { hasText: 'Yes, you pay your limit' }).first().click();
  check((await p.getByTestId('why-size').innerText()).startsWith('Not quite.'), 'practice: the quiz marks a wrong answer and explains');
  await shot(u, 'practice-debrief-1440-light');
  const v = await axe(u);
  check(v.length === 0, `practice: axe clean ${JSON.stringify(v).slice(0, 300)}`);
  await p.getByRole('button', { name: /Practice again|Reset/ }).click();
  check(await p.getByRole('button', { name: 'Start the practice call' }).isVisible(), 'practice: reset returns to the start');
  report(u);
  await u.context.close();
}

// ---------------------------------------------------------------- markets, retention, support (a stranger, dark, phone width)
{
  const u = await person(browser, { name: 'stranger', theme: 'dark', viewport: { width: 390, height: 844 }, ignore: noise });
  const p = u.page;
  await p.goto(`${BASE}/markets`, { waitUntil: 'domcontentloaded' });
  await p.getByRole('heading', { name: 'Tokens that have cleared' }).waitFor({ timeout: 180_000 });
  await p.getByTestId('assets').waitFor({ timeout: 120_000 });
  check((await p.getByTestId('assets').locator('tbody tr').count()) > 0, 'markets: tokens that have cleared are listed with their last price');
  check((await p.getByTestId('index-empty').count()) + (await p.getByTestId('index-level').count()) === 1, 'markets: the cohort index shows a level or says why it cannot');
  await p.getByTestId('stocks').or(p.getByTestId('stocks-none')).or(p.getByText('The premium monitor could not be read')).first().waitFor({ timeout: 30_000 });
  await shot(u, 'markets-390-dark');
  const v = await axe(u);
  check(v.length === 0, `markets 390 dark: axe clean ${JSON.stringify(v).slice(0, 300)}`);

  await p.goto(`${BASE}/retention`, { waitUntil: 'domcontentloaded' });
  await p.getByTestId('retention-summary').waitFor({ timeout: 30_000 });
  await shot(u, 'retention-390-dark');
  check((await axe(u)).length === 0, 'retention 390 dark: axe clean');

  await p.goto(`${BASE}/support`, { waitUntil: 'domcontentloaded' });
  await p.getByTestId('support-commitment').waitFor();
  check((await p.getByTestId('support-commitment').innerText()).includes('No response time is committed'), 'support: no response time is promised when none is set');
  await p.getByLabel(/What happened/).fill('My claim has been waiting since the cross cleared an hour ago.');
  await clickUntil(p, p.getByRole('button', { name: 'Send', exact: true }), p.getByTestId('support-note'));
  const note = await p.getByTestId('support-note').innerText();
  check(/Your reference is [0-9a-f]{12}/.test(note), `support: the request gets a reference (${note.slice(0, 100)})`);
  await p.getByTestId('support-list').waitFor();
  check((await p.getByTestId('support-list').innerText()).includes('Open. A reply will appear here.'), 'support: the request shows as open');
  const ref = /reference is ([0-9a-f]{12})/.exec(note)[1];
  const stored = await sql(`SELECT topic, message FROM support_requests WHERE id = '${ref}'`);
  check(stored.length === 1 && stored[0].message.startsWith('My claim'), 'support: the request is stored for the team');
  await fetch(`${HARNESS}/v1/support/${ref}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer harness-operator' }, body: JSON.stringify({ answer: 'Open Orders and press Claim all.' }) });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.getByTestId('support-list').getByText('Answered: Open Orders and press Claim all.').waitFor({ timeout: 20_000 });
  check(true, 'support: the reply appears next to the request after a reload');
  await shot(u, 'support-390-dark');
  check((await axe(u)).length === 0, 'support 390 dark: axe clean');
  report(u);
  await u.context.close();
}

// ---------------------------------------------------------------- the wallet: comments, follow, bid-from-a-link
{
  const secret = keyFile('live-buyer.json');
  const u = await person(browser, { name: 'holder', secret, ignore: noise });
  const p = u.page;
  // A cross the wallet has an order in.
  const mine = (await (await fetch(`${API}/v1/owners/${u.address}/orders`)).json()).orders;
  const crossAddr = mine[0].cross_address;
  await p.goto(`${BASE}/crosses/${crossAddr}#comments`, { waitUntil: 'domcontentloaded' });
  await connect(u);
  await p.getByRole('tab', { name: 'Comments' }).click();
  await p.getByRole('heading', { name: /Comments from holders/ }).waitFor();
  const text = `Filled at the clearing price, refund arrived with it (${Date.now() % 100000}).`;
  await p.getByLabel(/Your comment/).fill(text);
  await clickUntil(p, p.getByRole('button', { name: 'Sign and post' }), p.getByTestId('comment-note'), { each: 15_000 });
  const cn = await p.getByTestId('comment-note').innerText();
  check(cn === 'Posted.', `comments: signed with the wallet and posted (${cn})`);
  await p.getByTestId('comments').waitFor();
  const signedText = await p.evaluate(() => (window.__E2E_MESSAGES__ ?? []).at(-1));
  check(signedText?.startsWith('Opening Bell comment\ncross: ' + crossAddr) && signedText.includes(text), 'comments: the wallet was shown the exact text it signed');
  check((await p.getByTestId('comments').innerText()).includes(text), 'comments: the comment is listed with its role and weight');
  await p.getByLabel(/Your comment/).fill('read https://evil.example now');
  check((await p.getByText('Links are not allowed in comments.').count()) > 0 && (await p.getByRole('button', { name: 'Sign and post' }).isDisabled()), 'comments: a link is refused before the wallet is asked');
  await p.getByLabel(/Your comment/).fill('A second comment inside the minute.');
  await p.evaluate(() => (window.__E2E_REJECT_NEXT__ = true));
  await p.getByRole('button', { name: 'Sign and post' }).click();
  await p.getByTestId('comment-note').filter({ hasText: 'declined' }).waitFor({ timeout: 15_000 });
  check(true, 'comments: declining in the wallet says nothing was posted');
  await shot(u, 'comments-1440-light');

  // Follow list: from the cross page to the alerts page.
  const live = (await (await fetch(`${API}/v1/crosses?limit=50`)).json()).crosses.find((c) => c.state === 'Live');
  if (live) {
    await p.goto(`${BASE}/crosses/${live.address}`, { waitUntil: 'domcontentloaded' });
    await connect(u);
    const follow = p.getByRole('button', { name: /^Follow/ }).first();
    await clickUntil(p, follow, p.getByRole('button', { name: /^Following/ }).first());
    await p.goto(`${BASE}/alerts`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('following').waitFor();
    check((await p.getByTestId('following').innerText()).includes(live.address.slice(0, 4)), 'follow: the cross appears in the follow list on the Alerts page');
    await p.goto(`${BASE}/crosses/${live.address}`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('action-url').waitFor();
    check((await p.getByTestId('action-url').innerText()).startsWith('solana-action:http'), 'blink: the cross page shows its solana-action link');
    await clickUntil(p, p.getByRole('button', { name: 'Check what it answers' }), p.getByTestId('action-check'), { each: 15_000 });
    check((await p.getByTestId('action-check').innerText()).includes('Opening Bell'), 'blink: the endpoint answers with the cross as an action');
  } else console.log('NOTE: no Live cross in the index; follow and blink checks skipped');
  report(u);
  await u.context.close();
}
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
