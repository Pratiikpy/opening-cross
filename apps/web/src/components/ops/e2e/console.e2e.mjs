// The operations console in a real browser, against the real service, a real Postgres and the real API, with one isolated browser
// context per person (a viewer, two reviewers and an admin). Every outcome is read back from the service afterwards (its own
// routes and the audit log), not trusted from the page. Screenshots are taken in light and dark, on desktop and on a phone, and every
// page is scanned against WCAG 2.2 AA. Zero console errors, page errors, failed requests and HTTP errors is part of passing.
//
//   BASE_URL=http://127.0.0.1:3921 OPS_URL=http://127.0.0.1:8792 TOKENS_FILE=<json {tokens:{vera,alice,bob,root}}> \
//   PG_EXEC='wsl -e docker exec oc-1h-pg psql -U postgres -d oc1h -tA -c' OUT=<screenshot dir> node console.e2e.mjs
//
// The tamper step edits one audit-log row in the database to show that the console finds it, then puts the row back.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
process.env.OUT ??= 'docs/evidence/screens/w5-1h';
const lib = await import('../../../../e2e/holder-lib.mjs');
const { launch, person, shot, axe, check, report, results, sleep } = lib;

const WEB = need('BASE_URL');
const OPS = need('OPS_URL');
const T = JSON.parse(readFileSync(need('TOKENS_FILE'), 'utf8')).tokens;
const HOOK = need('OPS_WEBHOOK_SECRET');
const pgExec = (sql) => {
  const [cmd, ...args] = need('PG_EXEC').split(' ');
  return execFileSync(cmd, [...args, sql], { encoding: 'utf8' }).trim();
};

// The mint is Circle's devnet USDC: a real token the real API can read, and one whose holder data the API cannot produce here, so one
// evidence source fails honestly and the acknowledgement path is exercised for real.
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const WALLET = 'FzE4sQWkBzz5Mq5xUJD3p7TQDGZRvkjVfRB8Hq6uZ4pK';

/** The service as a program sees it: the source of truth the page is checked against. */
async function service(who, path, init = {}) {
  const res = await fetch(`${OPS}/v1/ops${path}`, { ...init, headers: { authorization: `Bearer ${T[who]}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const browser = await launch();
const ignore = ['Failed to load resource']; // the page's own deliberate refusals (a wrong token is a 401) are asserted below, not hidden

/** Opens the console and signs in, unless this tab's session already holds a token. */
async function signIn(u, name) {
  await u.page.goto(`${WEB}/ops`);
  const form = u.page.getByTestId('ops-token');
  const who = u.page.getByTestId('ops-who');
  await form.or(who).first().waitFor();
  if (await who.count()) return;
  await form.fill(T[name]);
  await u.page.getByTestId('ops-sign-in').click();
  await who.waitFor();
}

const people = {};
// Expected refusals, named: alice asks the service about a malformed cross address (400) and later presents a token it does not know (401);
// root's requests are cut on purpose to see the page's message.
const allowed = { vera: [], alice: ['/review/cross/nope', ' 401 ', '401 '], bob: [], root: ['ERR_CONNECTION_REFUSED'] };
for (const name of ['vera', 'alice', 'bob', 'root']) people[name] = await person(browser, { name, ignore: [...ignore, ...allowed[name]] });
const { vera, alice, bob, root } = people;
// A person who types a wrong token gets a 401 from the service; that is the expected response, not a fault.
// (Chrome also asks for /favicon.ico when it opens a bare JSON response, and the site has none at that path: that 404 is the browser's, not the page's.)
const stranger = await person(browser, { name: 'stranger', ignore: ['401', 'Failed to load resource'] });

// ------------------------------------------------------------------------------------------------------------ signed out
await stranger.page.goto(`${WEB}/ops`);
await stranger.page.getByTestId('ops-token').waitFor();
await shot(stranger, 'ops-signin-desktop-light');
check((await axe(stranger)).length === 0, 'sign-in page has no WCAG 2.2 AA violations');
check((await stranger.page.getByTestId('ops-sign-in').isDisabled()), 'the sign-in button is disabled until a token is typed');
await stranger.page.getByTestId('ops-token').fill('not-a-real-token-not-a-real-token');
await stranger.page.getByTestId('ops-sign-in').click();
await stranger.page.getByTestId('ops-sign-in-error').waitFor();
check(/not accepted/.test(await stranger.page.getByTestId('ops-sign-in-error').innerText()), 'a wrong token is refused with a message, and the person stays signed out');
check((await stranger.page.evaluate(() => window.sessionStorage.length)) === 0, 'a refused token is not kept in session storage');
check((await stranger.page.getByTestId('ops-who').count()) === 0, 'nothing of the console shows to someone who is not signed in');
await stranger.page.goto(`${WEB}/ops/api/v1/ops/log`);
check((await stranger.page.locator('body').innerText()).includes('a valid bearer token is required'), 'the API route itself refuses a request with no token (401 from the service, passed through)');
const hookViaWeb = await stranger.page.request.post(`${WEB}/ops/api/v1/ops/hooks/monitor/${HOOK}`, { data: { kind: 'incident', body: { event: 'forged' } } });
check(hookViaWeb.status() === 404, 'the monitor webhook cannot be reached through the web app, even with the right secret');
const getOnly = await stranger.page.request.fetch(`${WEB}/ops/api/v1/ops/me`, { method: 'DELETE' });
check(getOnly.status() === 405, 'other methods are refused by the API route');

// ------------------------------------------------------------------------------------------------------------ the viewer
await signIn(vera, 'vera');
check((await vera.page.getByTestId('ops-who').innerText()).includes('vera') && (await vera.page.getByTestId('ops-who').innerText()).toLowerCase().includes('viewer'), 'vera signs in and the page names her and her role');
check((await vera.page.getByTestId('open-submit').count()) === 0, 'a viewer is not offered the open-a-review form');
check((await vera.page.getByText('Your role is viewer').count()) > 0, 'a viewer is told why');
check((await vera.page.evaluate(() => window.sessionStorage.length)) === 1 && (await vera.page.evaluate(() => window.localStorage.length)) === 0, 'the token is in session storage only, never local storage');
check((await vera.context.cookies()).length === 0, 'the console sets no cookie');

// ------------------------------------------------------------------------------------------------------------ a listing review
await signIn(alice, 'alice');
await alice.page.getByTestId('open-submit').click();
check((await alice.page.getByText('Give a mint, a cross, or both.').count()) > 0, 'an empty review form says what is missing, without sending anything');
await alice.page.getByTestId('open-mint').fill('not-an-address');
await alice.page.getByTestId('open-note').fill('Issuer asked for a listing of the devnet USDC mint');
await alice.page.getByTestId('open-submit').click();
check((await alice.page.getByText('The mint must be a base58 address.').count()) > 0, 'a malformed mint is refused before sending');
await alice.page.getByTestId('open-mint').fill(MINT);
await alice.page.getByTestId('open-submit').click();
await alice.page.getByTestId('open-done').waitFor({ timeout: 120_000 });
const openedText = await alice.page.getByTestId('open-done').innerText();
check(/Evidence could not be gathered for holders/.test(openedText), `opening a review gathers real evidence and names the source that failed: "${openedText}"`);
await alice.page.getByTestId('listing-detail').waitFor();
check((await alice.page.getByTestId('evidence-safety').innerText()).toLowerCase().includes('gathered'), 'the safety evidence was gathered from the real API');
check((await alice.page.getByTestId('evidence-holders').innerText()).toLowerCase().includes('failed'), 'the holders evidence is shown as failed, with its error');
check((await alice.page.getByTestId('own-review').count()) === 1, 'the person who opened the review is told that someone else decides it');
check((await alice.page.getByTestId('decision-submit').count()) === 0, 'and is not offered the decision form');
await shot(alice, 'ops-listing-detail-desktop-light');
const listed = (await service('alice', '/listings?status=pending')).body.listings;
const review = listed.find((l) => l.mint === MINT);
check(Boolean(review) && review.requested_by === 'alice' && review.evidence_failed.includes('holders'), 'the service holds the review, opened by alice, with holders marked failed');
check((await service('alice', `/listings/${review.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approve', reason: 'alice approving her own review', acknowledgeMissingEvidence: true }) })).status === 403, 'and the service itself refuses alice deciding her own review');

await signIn(bob, 'bob');
await bob.page.getByTestId(`listing-${review.id}`).click();
await bob.page.getByTestId('listing-detail').waitFor();
check((await bob.page.getByTestId('evidence-holders').innerText()).toLowerCase().includes('failed'), 'bob reads the same evidence alice gathered, including the failed source');
await bob.page.getByTestId('decision-approve').check();
await bob.page.getByTestId('decision-reason').fill('too short');
await bob.page.getByTestId('decision-submit').click();
check((await bob.page.getByText('Give a reason of at least 10 characters').count()) > 0, 'a short reason is refused before sending');
await bob.page.getByTestId('decision-reason').fill('Safety and supply read fine; holders unavailable on devnet, approving knowingly.');
await bob.page.getByTestId('decision-submit').click();
check((await bob.page.getByText(/Evidence could not be gathered for holders/).count()) > 0, 'approving with a failed source needs the acknowledgement');
check((await service('bob', `/listings/${review.id}`)).body.status === 'pending', 'and nothing was recorded yet');
await bob.page.getByTestId('decision-ack').check();
await bob.page.getByTestId('decision-submit').click();
await bob.page.getByTestId('decision-done').waitFor();
const after = (await service('bob', `/listings/${review.id}`)).body;
check(after.status === 'approved' && after.decided_by === 'bob' && /approving knowingly/.test(after.reason), 'the decision is in the service: approved by bob, with his reason');
const log1 = (await service('vera', '/log?order=desc&limit=20')).body.entries;
const approve = log1.find((e) => e.action === 'listing.approve' && e.subject === review.id);
check(approve?.actor === 'bob' && JSON.stringify(approve.detail.missingEvidenceAcknowledged) === '["holders"]', 'the audit log records bob, the approval and the acknowledged missing source');
await bob.page.getByTestId('listing-detail').getByText('This review is approved').waitFor();
check(true, 'the page now says the review is decided and offers no second decision');
await bob.page.getByTestId('listing-status').selectOption('approved');
await bob.page.getByTestId(`listing-${review.id}`).waitFor();
check(true, 'the status filter lists the approved review');

// a cross lookup, and a bad address
await alice.page.getByTestId('lookup-address').fill('nope');
await alice.page.getByTestId('lookup-submit').click();
await alice.page.getByTestId('lookup-error').waitFor();
check(/base58/.test(await alice.page.getByTestId('lookup-error').innerText()), 'a bad cross address in the lookup is refused by the service and the message is shown');

// ------------------------------------------------------------------------------------------------------------ incidents
const hook = await fetch(`${OPS}/v1/ops/hooks/monitor/${HOOK}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'incident', at: new Date().toISOString(), body: { event: 'protocol paused by the monitor', signature: `sig-${Date.now()}`, reason: 'upgrade authority moved' } }) });
const hooked = await hook.json();
check(hook.status === 200 && hooked.fresh === true, 'the monitor opens an incident through its webhook');
await alice.page.getByTestId('ops-tab-incidents').click();
await alice.page.getByTestId(`incident-${hooked.incident}`).waitFor();
check((await alice.page.getByTestId(`incident-${hooked.incident}`).innerText()).includes('protocol paused by the monitor'), 'the incident shows in alice\'s console');
await alice.page.getByTestId('inc-title').fill('x');
await alice.page.getByTestId('inc-submit').click();
check((await alice.page.getByText('The title must be 3 to 200 characters.').count()) > 0, 'a one-character title is refused before sending');
await alice.page.getByTestId('inc-title').fill('Manual: a holder reports a wrong fee on their receipt');
await alice.page.getByTestId('inc-note').fill('Seen on one receipt; fee shows 31 bps.');
await alice.page.getByTestId('inc-submit').click();
await alice.page.getByTestId('inc-done').waitFor();
await alice.page.getByTestId(`ack-${hooked.incident}`).click();
await alice.page.getByTestId(`incident-${hooked.incident}`).getByText('acknowledged', { exact: true }).first().waitFor();
const inc1 = (await service('alice', '/incidents')).body.incidents.find((i) => i.id === hooked.incident);
check(inc1.state === 'acknowledged' && inc1.acknowledged_by === 'alice', 'alice acknowledges it: the service shows acknowledged by alice');
await shot(alice, 'ops-incidents-desktop-light');

await signIn(bob, 'bob');
await bob.page.getByTestId('ops-tab-incidents').click();
await bob.page.getByTestId(`incident-${hooked.incident}`).waitFor();
check((await bob.page.getByTestId(`resolve-open-${hooked.incident}`).count()) === 0 && (await bob.page.getByText('Only an admin resolves an incident.').count()) > 0, 'a reviewer is not offered the resolve button and is told why');

await signIn(root, 'root');
await root.page.getByTestId('ops-tab-incidents').click();
await root.page.getByTestId(`resolve-open-${hooked.incident}`).click();
await root.page.getByTestId(`resolve-${hooked.incident}`).click();
check((await root.page.getByText('Give a resolution of at least 10 characters').count()) > 0, 'an empty resolution is refused before sending');
await root.page.getByTestId(`resolution-${hooked.incident}`).fill('Authority returned to the multisig vault; protocol unpaused by the admin.');
await root.page.getByTestId(`resolve-${hooked.incident}`).click();
await root.page.getByTestId(`incident-${hooked.incident}`).getByText('resolved', { exact: true }).first().waitFor();
const inc2 = (await service('root', '/incidents?state=resolved')).body.incidents.find((i) => i.id === hooked.incident);
check(inc2?.resolved_by === 'root' && /multisig vault/.test(inc2.resolution), 'the admin resolves it: the service shows root and the resolution text');

// ------------------------------------------------------------------------------------------------------------ cases
await alice.page.getByTestId('ops-tab-cases').click();
await alice.page.getByTestId('case-subject').fill(WALLET);
await alice.page.getByTestId('case-summary').fill('short');
await alice.page.getByTestId('case-submit').click();
check((await alice.page.getByText('The summary must be 10 to 2,000 characters.').count()) > 0, 'a short case summary is refused before sending');
await alice.page.getByTestId('case-kind').selectOption('sanctions');
await alice.page.getByTestId('case-summary').fill('A screening provider flagged this wallet as a possible match; review needed.');
await alice.page.getByTestId('case-submit').click();
await alice.page.getByTestId('case-done').waitFor();
await alice.page.getByTestId('case-detail').waitFor();
await alice.page.getByTestId('note-text').fill('Asked the provider for the basis of the match.');
await alice.page.getByTestId('note-submit').click();
await alice.page.getByTestId('note-done').waitFor();
const theCase = (await service('alice', '/cases?status=open')).body.cases.find((c) => c.subject === WALLET);
check(Boolean(theCase) && theCase.opened_by === 'alice' && theCase.kind === 'sanctions', 'the case exists in the service, opened by alice');

await signIn(bob, 'bob');
await bob.page.getByTestId('ops-tab-cases').click();
await bob.page.getByTestId(`case-${theCase.id}`).click();
await bob.page.getByTestId('case-detail').waitFor();
await bob.page.getByTestId('note-text').fill('The match is a name collision; the dates of birth differ.');
await bob.page.getByTestId('note-submit').click();
await bob.page.getByTestId('note-done').waitFor();
const notes = (await service('bob', `/cases/${theCase.id}`)).body.notes;
check(notes.map((n) => n.author).join() === 'alice,bob', 'two reviewers\' notes are in the case in the order written, each under its author');
check((await bob.page.getByTestId('close-open').count()) === 0 && (await bob.page.getByText('Only an admin closes a case.').count()) > 0, 'a reviewer is not offered closing the case');
const noteInLog = JSON.stringify((await service('root', '/log?order=desc&limit=100')).body.entries.filter((e) => e.action === 'case.note'));
check(!noteInLog.includes('name collision'), 'the audit log says a note was added but does not hold its text');

await root.page.getByTestId('ops-tab-cases').click();
await root.page.getByTestId(`case-${theCase.id}`).click();
await root.page.getByTestId('close-open').click();
await root.page.getByTestId('close-resolution').fill('x');
await root.page.getByTestId('close-submit').click();
check((await root.page.getByText('Give a resolution of at least 10 characters').count()) > 0, 'closing without a real resolution is refused before sending');
await root.page.getByTestId('close-resolution').fill('Cleared as a name collision; the evidence is attached to the case.');
await root.page.getByTestId('close-submit').click();
await root.page.getByText('This case is closed.').waitFor();
const closed = (await service('root', `/cases/${theCase.id}`)).body;
check(closed.status === 'closed' && closed.closed_by === 'root' && closed.notes.length === 2, 'the admin closes it: closed by root, both notes kept');
check((await root.page.getByTestId('note-submit').count()) === 0, 'a closed case offers no new note');
await shot(root, 'ops-cases-desktop-light');

// ------------------------------------------------------------------------------------------------------------ the log
await root.page.getByTestId('ops-tab-log').click();
await root.page.getByTestId('log-table').waitFor();
const topSeq = Number((await service('root', '/log?order=desc&limit=1')).body.entries[0].seq);
check((await root.page.getByTestId(`log-${topSeq}`).count()) === 1, 'the newest log entry is shown first');
await root.page.getByTestId('log-verify').click();
await root.page.getByTestId('chain-ok').waitFor();
const intact = await root.page.getByTestId('chain-ok').innerText();
const serverCheck = (await service('root', '/log/verify')).body;
check(serverCheck.ok === true && intact.includes(`${serverCheck.length} entries`), `verify says intact and agrees with the service (${serverCheck.length} entries)`);
await root.page.getByTestId('log-head').click();
await root.page.getByTestId('head-result').waitFor();
const headText = await root.page.getByTestId('head-result').innerText();
check(/The head is signed/.test(headText), 'the signed head is shown');
const [download] = await Promise.all([root.page.waitForEvent('download'), root.page.getByTestId('head-save').click()]);
const saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
const headNow = (await service('root', '/log/head')).body;
check(saved.signer === headNow.document.signer && typeof saved.signature === 'string' && saved.body.head === serverCheck.head, 'the downloaded head is the signed document: signer, signature and the chain head');
check((await service('root', '/log/verify')).body.ok === true, 'the chain is intact before the tamper step');
await shot(root, 'ops-log-desktop-light');

// Someone with the database edits one row: the console finds the first broken entry, and refuses to sign.
const victim = log1[Math.floor(log1.length / 2)].seq;
const original = pgExec(`SELECT detail::text FROM ops_log WHERE seq = ${victim}`);
pgExec(`UPDATE ops_log SET detail = '{"edited":true}' WHERE seq = ${victim}`);
try {
  await root.page.getByTestId('log-verify').click();
  await root.page.getByTestId('chain-broken').waitFor();
  const broken = await root.page.getByTestId('chain-broken').innerText();
  check(broken.includes(`entry ${victim}`) && /edited/.test(broken), `after a row is edited in the database, verify names the entry and says it was edited: "${broken}"`);
  await root.page.getByTestId('log-head').click();
  await root.page.getByText('The chain is broken, so it is not signed.').waitFor();
  check(true, 'and the head is not signed while the chain is broken');
  await shot(root, 'ops-log-broken-desktop-light');
} finally {
  pgExec(`UPDATE ops_log SET detail = '${original.replace(/'/g, "''")}'::jsonb WHERE seq = ${victim}`);
}
check((await service('root', '/log/verify')).body.ok === true, 'the row was put back and the chain verifies again');
await root.page.getByTestId('log-verify').click();
await root.page.getByTestId('chain-ok').waitFor();

// A viewer sees the log but not the admin tools.
await vera.page.getByTestId('ops-tab-log').click();
await vera.page.getByTestId('log-table').waitFor();
check((await vera.page.getByTestId('log-verify').count()) === 0, 'a viewer reads the log but is not offered verify or the signed head');

// ------------------------------------------------------------------------------------------------------------ sessions
await alice.page.reload();
await alice.page.getByTestId('ops-who').waitFor();
check(true, 'a reload in the same tab keeps the session');
await alice.page.getByTestId('ops-sign-out').click();
await alice.page.getByTestId('ops-token').waitFor();
check((await alice.page.evaluate(() => window.sessionStorage.length)) === 0, 'signing out removes the token from the tab');
await alice.page.reload();
await alice.page.getByTestId('ops-token').waitFor();
check(true, 'and a reload after signing out stays signed out');
await alice.page.evaluate(() => window.sessionStorage.setItem('opening-cross.ops.token', 'a-token-that-was-revoked-or-never-valid'));
await alice.page.reload();
await alice.page.getByTestId('ops-sign-in-error').waitFor();
check((await alice.page.evaluate(() => window.sessionStorage.length)) === 0, 'a stored token the service no longer accepts is dropped with a message');

// ------------------------------------------------------------------------------------------------------------ the service goes away
await root.page.route('**/ops/api/**', (r) => r.abort('connectionrefused'));
await root.page.getByTestId('ops-tab-incidents').click();
await root.page.getByText('Could not reach the console.').first().waitFor();
check(true, 'when the console cannot be reached the page says so instead of showing an empty list');
await root.page.unroute('**/ops/api/**');

// ------------------------------------------------------------------------------------------------------------ visuals and accessibility
async function look(u, name, tabs, theme, viewport) {
  const v = await person(browser, { name: `${name}-${theme}-${viewport.width}`, theme, viewport, ignore });
  await signIn(v, u);
  for (const tab of tabs) {
    await v.page.getByTestId(`ops-tab-${tab}`).click();
    await sleep(900);
    const label = `ops-${tab}-${viewport.width < 600 ? 'mobile' : 'desktop'}-${theme}`;
    await shot(v, label);
    const violations = await axe(v);
    check(violations.length === 0, `${label}: no WCAG 2.2 AA violations${violations.length ? ` ${JSON.stringify(violations).slice(0, 600)}` : ''}`);
    const overflow = await v.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${label}: no horizontal scroll of the page (overflow ${overflow}px)`);
  }
  report(v);
  await v.context.close();
}
const TABS = ['listings', 'incidents', 'cases', 'log'];
await look('root', 'root', TABS, 'light', { width: 1440, height: 900 });
await look('root', 'root', TABS, 'dark', { width: 1440, height: 900 });
await look('root', 'root', TABS, 'light', { width: 390, height: 844 });
await look('root', 'root', TABS, 'dark', { width: 390, height: 844 });
await look('vera', 'vera', ['listings'], 'light', { width: 1440, height: 900 });

// the open listing form with the failed-evidence queue, in dark, for a designer's eye
// Cutting root's requests on purpose is reported by the browser as failed requests; those, and only those, are expected.
root.problems = root.problems.filter((p) => !/ERR_CONNECTION_REFUSED/.test(p));
for (const u of [vera, alice, bob, root, stranger]) report(u);
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
