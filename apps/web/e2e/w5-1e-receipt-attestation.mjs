// Signed and anchored receipts in a real browser against a production build (row S2, ADR-0941): the panel under the receipt in every state a reader can meet it in, light and dark,
// desktop and phone, the checks it repeats, a tampered attestation, and the receipt image route (a Next production server, not `next dev`).
//
//   services/api: FUNDER_KEYPAIR=... WEB_URL=http://localhost:3451 pnpm exec tsx test/receipt-harness.ts        (attests and anchors for real, see its header)
//   apps/web:     NEXT_PUBLIC_API_URL=http://127.0.0.1:8083 NEXT_DIST_DIR=node_modules/.cache/next-1e next build, then the same with `next start -p 3451`
//   BASE_URL=http://localhost:3451 HARNESS=http://127.0.0.1:8083 OUT=docs/evidence/screens/w5-1e node e2e/w5-1e-receipt-attestation.mjs
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BASE, OUT, axe, check, launch, person, report, results, shot } from './holder-lib.mjs';

const HARNESS = process.env.HARNESS ?? 'http://127.0.0.1:8083';
const sql = async (q) => (await (await fetch(`${HARNESS}/__harness/sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: q }) })).json());

const [printed] = await sql("SELECT cross_address AS a FROM receipt_attestations WHERE state = 'Finalized' ORDER BY recorded_at, id LIMIT 1");
const [noPrint] = await sql("SELECT cross_address AS a FROM receipt_attestations WHERE state = 'NoPrint' ORDER BY recorded_at, id LIMIT 1");
const [pending] = await sql('SELECT address AS a FROM crosses WHERE address NOT IN (SELECT cross_address FROM receipt_attestations) LIMIT 1');
const tamperRows = await sql("SELECT cross_address AS a FROM receipt_attestations WHERE state = 'Finalized' ORDER BY recorded_at DESC, id LIMIT 1");
const live = (await (await fetch(`${process.env.LIVE_API ?? 'https://98-87-59-136.sslip.io'}/v1/crosses?limit=200`)).json()).crosses.find((c) => c.state === 'Live');
const owner = (await (await fetch(`${process.env.LIVE_API ?? 'https://98-87-59-136.sslip.io'}/v1/crosses/${printed.a}/orders`)).json()).orders?.[0]?.owner;
console.log({ printed: printed?.a, noPrint: noPrint?.a, pending: pending?.a, tamper: tamperRows[0]?.a, live: live?.address, owner });

const browser = await launch();
const panel = (u) => u.page.getByTestId('attestation-state');
const verdicts = async (u) => Object.fromEntries(await u.page.locator('[data-check]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-check'), e.getAttribute('data-verdict')])));

// ---- the anchored state, in four renderings
for (const [theme, viewport, tag] of [
  ['light', { width: 1440, height: 900 }, '1440-light'],
  ['dark', { width: 1440, height: 900 }, '1440-dark'],
  ['light', { width: 390, height: 844 }, '390-light'],
  ['dark', { width: 390, height: 844 }, '390-dark'],
]) {
  const u = await person(browser, { name: `receipt ${tag}`, theme, viewport });
  await u.page.goto(`${BASE}/receipt/${printed.a}`, { waitUntil: 'domcontentloaded' });
  await panel(u).waitFor({ timeout: 60000 });
  check((await panel(u).getAttribute('data-state')) === 'anchored', `${tag}: the panel says signed and anchored`);
  check((await u.page.getByTestId('attestation-headline').innerText()).startsWith('Signed by Opening Cross and anchored on chain'), `${tag}: the headline says so in words`);
  const v = await verdicts(u);
  check(JSON.stringify(v) === JSON.stringify({ id: 'pass', signature: 'pass', signer: 'pass', receipt: 'pass', merkle: 'pass', chain: 'pass' }), `${tag}: all six checks pass (${JSON.stringify(v)})`);
  check((await u.page.locator('a[href*="explorer.solana.com/tx/"]').count()) >= 3, `${tag}: the anchor transaction links to the explorer beside the clear and finalize transactions`);
  const overflow = await u.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${tag}: no horizontal overflow (${overflow}px)`);
  if (tag === '1440-light') {
    const bad = (await axe(u)).filter((x) => x.impact === 'serious' || x.impact === 'critical');
    check(bad.length === 0, `${tag}: axe finds no serious or critical violation${bad.length ? ` ${JSON.stringify(bad)}` : ''}`);
    await u.page.getByTestId('attestation').locator('summary').click();
    check((await u.page.getByTestId('attestation').locator('details li').count()) === 3, `${tag}: "Check it yourself" lists three steps`);
  }
  await shot(u, `receipt-attested-${tag}`);
  report(u);
  await u.context.close();
}

// ---- the other states
if (noPrint) {
  const u = await person(browser, { name: 'receipt without a print' });
  await u.page.goto(`${BASE}/receipt/${noPrint.a}`, { waitUntil: 'domcontentloaded' });
  await panel(u).waitFor({ timeout: 60000 });
  check((await panel(u).getAttribute('data-state')) === 'anchored', 'a cross that did not print is signed and anchored too');
  await shot(u, 'receipt-attested-no-print-1440-light');
  report(u);
  await u.context.close();
}
{
  const u = await person(browser, { name: 'receipt not yet signed' });
  await u.page.goto(`${BASE}/receipt/${pending.a}`, { waitUntil: 'domcontentloaded' });
  await panel(u).waitFor({ timeout: 60000 });
  check((await panel(u).getAttribute('data-state')) === 'none', 'a settled cross with no attestation yet says "Not signed yet"');
  check((await panel(u).innerText()).includes('bound to its content by a hash and nothing more'), 'and says what the receipt is until then');
  check((await u.page.locator('[data-check]').count()) === 0, 'and shows no check it did not make');
  await shot(u, 'receipt-not-signed-1440-light');
  report(u);
  await u.context.close();
}
{
  const u = await person(browser, { name: 'receipt of a live cross' });
  await u.page.goto(`${BASE}/receipt/${live.address}`, { waitUntil: 'domcontentloaded' });
  await panel(u).waitFor({ timeout: 60000 });
  check((await panel(u).getAttribute('data-state')) === 'none', 'a cross still live has nothing signed');
  report(u);
  await u.context.close();
}
if (owner) {
  const u = await person(browser, { name: 'wallet receipt' });
  await u.page.goto(`${BASE}/receipt/${printed.a}/${owner}`, { waitUntil: 'domcontentloaded' });
  await u.page.getByTestId('attestation').waitFor({ timeout: 60000 });
  check((await u.page.getByTestId('attestation').innerText()).includes('carries no signature of its own'), 'a wallet receipt says its own order list carries no signature, and points to the signed cross receipt');
  check((await u.page.getByTestId('attestation').locator('a[href^="/receipt/"]').count()) === 1, 'with a link to the cross receipt');
  await shot(u, 'receipt-wallet-1440-light');
  report(u);
  await u.context.close();
}

// ---- a tampered attestation: the page repeats the checks and fails it, instead of trusting the API
{
  const a = tamperRows[0].a;
  const before = await sql(`SELECT body FROM receipt_attestations WHERE cross_address = '${a}'`);
  await sql(`UPDATE receipt_attestations SET body = jsonb_set(body, '{receiptSha256}', '"${'0'.repeat(64)}"') WHERE cross_address = '${a}'`);
  const u = await person(browser, { name: 'tampered attestation' });
  await u.page.goto(`${BASE}/receipt/${a}`, { waitUntil: 'domcontentloaded' });
  await panel(u).waitFor({ timeout: 60000 });
  check((await panel(u).getAttribute('data-state')) === 'failed', 'a changed attestation is shown as failed');
  check((await u.page.getByTestId('attestation-headline').innerText()).startsWith('Do not rely on this attestation'), 'with the instruction not to rely on it');
  const v = await verdicts(u);
  check(v.id === 'fail' && v.receipt === 'fail', `the id and the receipt-hash checks fail (${JSON.stringify(v)})`);
  await shot(u, 'receipt-tampered-1440-light');
  const json = await (await fetch(`${BASE}/receipt/${a}/attestation`)).json();
  check(json.summary.failed === true && json.checks.some((c) => c.id === 'id' && c.verdict === 'fail'), 'the JSON route reports the same failure');
  report(u);
  await u.context.close();
  await sql(`UPDATE receipt_attestations SET body = '${JSON.stringify(before[0].body)}'::jsonb WHERE cross_address = '${a}'`);
}

// ---- the JSON and image routes of a production server
{
  const a = printed.a;
  const j = await fetch(`${BASE}/receipt/${a}/json`);
  const text = await j.text();
  const hash = createHash('sha256').update(text).digest('hex');
  check(j.status === 200 && j.headers.get('x-receipt-sha256') === hash, `the receipt JSON hashes to its header (${hash.slice(0, 16)}…)`);
  const att = await fetch(`${BASE}/receipt/${a}/attestation`);
  const attJson = await att.json();
  check(att.status === 200 && attJson.attestation.body.receiptSha256 === hash, 'the attested hash is the hash of those bytes');
  check((await fetch(`${BASE}/receipt/${pending.a}/attestation`)).status === 404, 'a cross with no attestation answers 404 on the JSON route');
  check((await fetch(`${BASE}/receipt/not-an-address/attestation`)).status === 404, 'a junk address answers 404');

  const png = async (path, name) => {
    const r = await fetch(`${BASE}${path}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const isPng = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const dims = isPng ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null;
    if (isPng && name) writeFileSync(`${OUT}/${name}.raw.png`, buf);
    return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), bytes: buf.length, dims };
  };
  const img = await png(`/receipt/${a}/image`, 'receipt-image-printed');
  check(img.status === 200 && img.type === 'image/png' && img.dims?.[0] === 1200 && img.dims?.[1] === 630, `production build: the cross image is a 1200 by 630 PNG (${JSON.stringify(img)})`);
  if (noPrint) {
    const imgNp = await png(`/receipt/${noPrint.a}/image`, 'receipt-image-no-print');
    check(imgNp.status === 200 && imgNp.dims?.[0] === 1200, `production build: the no-print image renders (${JSON.stringify(imgNp)})`);
  } else console.log('NOT RUN: this cluster has no settled cross without a print, so that state was not seen in a browser or as an image');
  if (owner) {
    const imgW = await png(`/receipt/${a}/${owner}/image`, 'receipt-image-wallet');
    check(imgW.status === 200 && imgW.dims?.[1] === 630, `production build: the wallet image renders (${JSON.stringify(imgW)})`);
  }
  const imgLive = await png(`/receipt/${live.address}/image`, 'receipt-image-not-settled');
  check(imgLive.status === 200 && imgLive.dims?.[1] === 630, `production build: an unsettled cross gets the "Not settled yet" notice image (${JSON.stringify(imgLive)})`);
  const junk = await fetch(`${BASE}/receipt/not-an-address/image`);
  check(junk.status === 404, 'production build: a junk address answers 404 on the image route');
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
