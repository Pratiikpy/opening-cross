// Alerts end to end in a real browser against the holder API harness: a real push subscription through the browser's push service
// (real Chrome), a delivered notification read back from the service worker, and the email double opt-in against a real SMTP
// sandbox (Ethereal) with confirm and unsubscribe from the links in the mails.
//
//   BASE_URL=http://localhost:3412 HARNESS=http://127.0.0.1:8082 node e2e/holder-alerts-flow.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BASE, axe, check, clickUntil, connect, keyFile, persistentPerson, report, results, shot, sleep } from './holder-lib.mjs';

const HARNESS = process.env.HARNESS ?? 'http://127.0.0.1:8082';
const sql = async (q) => (await (await fetch(`${HARNESS}/__harness/sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: q }) })).json());
const mails = async () => (await (await fetch(`${HARNESS}/__harness/mails`)).json());
const CHROME_REAL = process.env.REAL_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const secret = keyFile('live-buyer.json');
const u = await persistentPerson({ name: 'holder alerts', secret, executablePath: CHROME_REAL, dir: mkdtempSync(`${tmpdir()}/ob-push-`) });
const page = u.page;
await page.goto(`${BASE}/alerts`, { waitUntil: 'domcontentloaded' });
await connect(u);
await page.getByRole('heading', { name: 'Where to reach you' }).waitFor();

await sql(`DELETE FROM orders WHERE address = 'HarnessOrder11111111111111111111111111111111'`);
await sql(`DELETE FROM crosses WHERE address = 'HarnessCross1111111111111111111111111111111'`);
await sql('DELETE FROM alert_subscriptions');
// A cross that closes in five minutes, with an order of this wallet in it, put in the index the way the indexer would.
const now = Math.floor(Date.now() / 1000);
const CROSS = 'HarnessCross1111111111111111111111111111111';
await sql(`INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot) VALUES ('${CROSS}', 'Creator', 0, 0, 1, 'B', 'Q', ${now - 600}, ${now + 300}, ${now + 300}, 0, 0, 'Live', 1, 1)`);
await sql(`INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, status, created_slot, updated_slot) VALUES ('${CROSS}', 0, 'HarnessOrder11111111111111111111111111111111', '${u.address}', 0, 1000000, false, 'committed', 1, 1)`);

// ---- the in-app feed shows it without any subscription
await page.reload({ waitUntil: 'domcontentloaded' });
await connect(u);
const feed = page.getByTestId('feed');
await feed.waitFor({ timeout: 20000 });
check((await feed.innerText()).includes('closes in'), 'in-app feed: a cross closing on the wallet\u2019s order is listed with no subscription');
await shot(u, 'alerts-feed-1440-light');

// ---- browser push, through the real push service
await page.getByRole('button', { name: 'Turn on notifications' }).click();
const note = page.getByTestId('push-note');
await note.waitFor({ timeout: 120000 });
const text = await note.innerText();
console.log('LS after on', await page.evaluate(() => localStorage.getItem('opening-bell.alerts.v1')));
check(text.includes('on for this browser'), `push: subscription created through the browser's push service (${text})`);
const rows = await sql("SELECT channel, confirmed, wallet, topics, left(destination, 40) AS dest FROM alert_subscriptions WHERE channel = 'push'");
check(rows.length === 1 && rows[0].confirmed && rows[0].wallet === u.address, `push: the server holds one confirmed subscription for the wallet (${JSON.stringify(rows[0])})`);
// The sender runs every few seconds: the closing reminder goes out through the push service and reaches the service worker.
let shown = [];
for (let i = 0; i < 20 && shown.length === 0; i++) {
  await sleep(2000);
  shown = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('/'))?.getNotifications())?.map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url })) ?? []);
}
check(shown.length === 1 && shown[0].title.includes('closes in') && shown[0].url === `/crosses/${CROSS}`, `push: the notification was delivered to the browser and shown (${JSON.stringify(shown[0] ?? null)})`);
const del = await sql("SELECT status FROM alert_deliveries");
check(del.length === 1 && del[0].status === 'sent', `push: one delivery recorded as sent (${JSON.stringify(del)})`);
await sleep(7000);
check((await sql('SELECT count(*)::int AS n FROM alert_deliveries'))[0].n === 1, 'push: later passes do not send it again');
await shot(u, 'alerts-push-on-1440-light');

// ---- email double opt-in against the SMTP sandbox
const base = (await mails()).length;
await page.getByLabel('Email address').fill('holder.test@example.com');
await page.getByRole('button', { name: 'Send confirmation link' }).click();
await page.getByTestId('email-note').waitFor();
check((await page.getByTestId('email-note').innerText()).includes('confirmation link is on its way'), 'email: the form answers that a link is on its way, not whether the address was known');
let m = [];
for (let i = 0; i < 10 && m.length === 0; i++) {
  m = (await mails()).slice(base);
  if (!m.length) await sleep(1000);
}
check(m.length === 1 && m[0].subject === 'Confirm your Opening Bell alerts', `email: the SMTP sandbox accepted a confirmation mail (${m[0]?.subject})`);
const link = /(http:\/\/localhost:\d+\/alerts\/confirm\?id=[0-9a-f]{24}&token=[A-Za-z0-9_-]+)/.exec(m[0].text)[1];
check((await sql("SELECT confirmed FROM alert_subscriptions WHERE channel = 'email'"))[0].confirmed === false, 'email: nothing is active before the link is opened');
await sleep(7000);
check((await mails()).length - base === 1, 'email: no alert mail is sent to an unconfirmed address, though a cross is closing');

const mailPage = await u.context.newPage();
await mailPage.goto(link, { waitUntil: 'domcontentloaded' });
await mailPage.getByRole('button', { name: 'Confirm' }).waitFor();
check((await sql("SELECT confirmed FROM alert_subscriptions WHERE channel = 'email'"))[0].confirmed === false, 'email: opening the link alone confirms nothing (a mail scanner cannot confirm)');
await clickUntil(mailPage, mailPage.getByRole('button', { name: 'Confirm' }), mailPage.getByTestId('manage-result'));
check((await mailPage.getByTestId('manage-result').innerText()).startsWith('Confirmed.'), 'email: the Confirm button confirms');
let all = [];
for (let i = 0; i < 15 && all.length < 2; i++) {
  all = (await mails()).slice(base);
  if (all.length < 2) await sleep(1000);
}
check(all.length === 2 && all[1].subject.includes('closes in'), `email: the closing reminder arrived once confirmed (${all[1]?.subject})`);
const out = /(http:\/\/localhost:\d+\/alerts\/unsubscribe\?id=[0-9a-f]{24}&token=[A-Za-z0-9_-]+)/.exec(all[1].text)[1];
await shot(u, 'alerts-email-confirmed-1440-light');
await mailPage.goto(out, { waitUntil: 'domcontentloaded' });
await clickUntil(mailPage, mailPage.getByRole('button', { name: 'Stop emails' }), mailPage.getByTestId('manage-result'));
check((await sql("SELECT count(*)::int AS n FROM alert_subscriptions WHERE channel = 'email'"))[0].n === 0, 'email: the unsubscribe link in the alert mail deletes the subscription');
await mailPage.goto(out, { waitUntil: 'domcontentloaded' });
await clickUntil(mailPage, mailPage.getByRole('button', { name: 'Stop emails' }), mailPage.getByTestId('manage-result'));
check((await mailPage.getByTestId('manage-result').innerText()).includes('not subscribed any more'), 'email: using the link a second time says so');
await mailPage.close();

// ---- turning push off deletes the subscription
console.log('LS before reload', await page.evaluate(() => localStorage.getItem('opening-bell.alerts.v1')));
await page.reload({ waitUntil: 'domcontentloaded' });
await connect(u);
console.log('LS', await page.evaluate(() => localStorage.getItem('opening-bell.alerts.v1')), (await page.locator('main').innerText()).slice(-700));
await clickUntil(page, page.getByRole('button', { name: 'Turn off' }), page.getByTestId('push-note'));
check((await sql("SELECT count(*)::int AS n FROM alert_subscriptions"))[0].n === 0, 'push: Turn off deletes the subscription from the server');
const v = await axe(u);
check(v.length === 0, `alerts page after the flow: axe clean ${JSON.stringify(v).slice(0, 300)}`);
report(u);
await u.context.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
