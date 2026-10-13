// /calendar (market sessions, reminders, .ics) and /live (the calendar-driven board), light and dark, 1440 and 390: zero
// console errors, zero failed requests, no horizontal overflow, no axe-core WCAG 2.1 AA violation, plus the behaviour the
// pages promise: a reminder survives a reload and can be removed, the .ics holds the session's real start, a reminder that has
// come due shows as a banner, the countdown ticks, and the empty and API-down states say what they are.
//
// The data is the real calendar API (API_URL for the web app, set when it was started). The empty and API-down states cannot be
// reached with a real calendar present, so for those two the BROWSER's fetch of /v1/calendar is rewritten (page.route) and the
// board is told to refresh; the server render is untouched.
//
//   BASE_URL=http://localhost:3417 CHROME=C:/.../chrome.exe node e2e/w5-calendar-live-check.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3417';
const OUT = process.env.OUT ?? 'e2e/screens/w5';
mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !detail ? '' : ` :: ${detail}`}`);
  if (!ok) failures.push(what);
};
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const KEY = 'opening-bell.calendar.reminders.v1';

async function open(path, { width = 1440, height = 900, theme = 'light', init = null, route = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => !r.url().includes('/_next/webpack-hmr') && problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  if (route) await page.route('**/v1/calendar', route);
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  return { ctx, page, problems };
}

async function audit(tag, { page, problems }) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${tag}: no horizontal overflow`, `${overflow}px`);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  check(axe.violations.length === 0, `${tag}: axe WCAG 2.1 AA`, axe.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target?.join(' ')}`).join('; '));
  // Next's dev overlay reports its own HMR noise as it recompiles; the page's own errors are what count.
  const own = problems.filter((p) => !/webpack-hmr|Download the React DevTools|\[HMR\]/.test(p));
  check(own.length === 0, `${tag}: zero console errors and failed requests`, own.slice(0, 3).join(' | '));
}

// 1. Every page, both themes, both widths.
for (const path of ['/calendar', '/live']) {
  for (const theme of ['light', 'dark']) {
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      const s = await open(path, { width, height, theme });
      const tag = `${path} ${name} ${theme}`;
      await s.page.screenshot({ path: `${OUT}/${path.slice(1)}-${name}-${theme}.png`, fullPage: true });
      await audit(tag, s);
      await s.ctx.close();
    }
  }
}

// 2. /calendar behaviour.
{
  const s = await open('/calendar');
  const { page } = s;
  const rows = page.getByTestId('market-row');
  check((await rows.count()) > 0, '/calendar lists market calendars from the API', `${await rows.count()} row(s)`);
  const badge = await rows.first().innerText();
  check(/Session open|Closed/.test(badge), 'each market states open or closed in words', badge.split('\n').slice(0, 3).join(' / '));
  // Pick a row that has a next session (so it offers the reminder and the .ics).
  const withNext = rows.filter({ has: page.getByRole('button', { name: /^Notify me/ }) }).first();
  const have = (await withNext.count()) > 0;
  check(have, 'a market with a next session offers "Notify me" and "Add to calendar"');
  if (have) {
    const notify = withNext.getByRole('button', { name: /^Notify me/ });
    check((await notify.getAttribute('aria-pressed')) === 'false', 'the reminder starts off');
    await notify.click();
    check((await notify.getAttribute('aria-pressed')) === 'true', 'clicking turns it on');
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), KEY);
    check(stored.length === 1 && stored[0].startTs > Date.now() / 1000 - 5, 'it is stored in this browser (localStorage), for the session that has not started', JSON.stringify(stored));
    await page.reload({ waitUntil: 'networkidle' });
    const again = page.getByTestId('market-row').filter({ has: page.getByRole('button', { name: /^Notify me/ }) }).first().getByRole('button', { name: /^Notify me/ });
    check((await again.getAttribute('aria-pressed')) === 'true', 'it is still on after a reload');
    await page.screenshot({ path: `${OUT}/calendar-reminder-on-desktop-light.png`, fullPage: true });
    // The .ics download: one VEVENT whose start is the stored session's start.
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /^Add (next open )?to calendar/ }).first().click();
    const file = await dl;
    const text = readFileSync(await file.path(), 'utf8');
    const unfolded = text.replace(/\r\n /g, '');
    const m = /DTSTART:(\d{8}T\d{6}Z)/.exec(unfolded);
    const iso = m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[1].slice(9, 11)}:${m[1].slice(11, 13)}:${m[1].slice(13, 15)}Z` : '';
    check(file.suggestedFilename().endsWith('.ics') && text.includes('BEGIN:VEVENT') && text.includes('\r\n') && Boolean(m), 'the download is an .ics with a VEVENT and CRLF line ends', file.suggestedFilename());
    const first = (await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]'), KEY))[0];
    check(Date.parse(iso) / 1000 === first.startTs, 'the .ics DTSTART equals the session start the reminder is for', `${iso} vs ${first.startTs}`);
    await again.click();
    check((await again.getAttribute('aria-pressed')) === 'false' && (await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]').length, KEY)) === 0, 'clicking again removes it');
  }
  const note = await page.getByText(/Follow is different: once you choose a channel/).first().isVisible();
  check(note, 'the page says plainly that Notify me stays in this browser and Follow needs a channel');
  await s.ctx.close();
}

// 3. A reminder that has come due is a banner, on both pages; dismissing removes it.
{
  const now = Math.floor(Date.now() / 1000);
  const seeded = JSON.stringify([{ calendar: '4YRGverHdwFRntHPhmHppAFGp4pag5pvVgQX4QHDb7FS', startTs: now + 300, endTs: now + 1200 }]);
  for (const path of ['/calendar', '/live']) {
    const s = await open(path, { init: `try{localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(seeded)})}catch(e){}` });
    const banner = s.page.getByTestId('reminder-banner');
    check(await banner.isVisible(), `${path}: a reminder due in 5 minutes shows as a banner`);
    check(/opens in \d+m/.test(await banner.innerText()), `${path}: the banner counts down`, (await banner.innerText()).replace(/\n/g, ' '));
    if (path === '/live') await s.page.screenshot({ path: `${OUT}/live-reminder-banner-desktop-light.png`, fullPage: true });
    await audit(`${path} with a due reminder`, s);
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    check((await s.page.getByTestId('reminder-banner').count()) === 0 && (await s.page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]').length, KEY)) === 0, `${path}: Dismiss removes the banner and the stored reminder`);
    await s.ctx.close();
  }
}

// 4. /live behaviour.
{
  const s = await open('/live');
  const { page } = s;
  const running = await page.getByTestId('live-running').count();
  const next = await page.getByTestId('live-next').count();
  const empty = await page.getByTestId('live-empty').count();
  check(running + next + empty > 0, '/live shows an open session, a next event, or the empty state', `running ${running}, next ${next}, empty ${empty}`);
  const counter = page.getByTestId(running ? 'live-running-countdown' : 'live-next-countdown');
  if (running || next) {
    const a = await counter.first().innerText();
    await page.waitForTimeout(2200);
    const b = await counter.first().innerText();
    // Under an hour the countdown shows seconds and must move; over an hour it moves once a minute, so two samples can match.
    if (/s$/.test(a)) check(a !== b, 'the countdown ticks', `${a} -> ${b}`);
    else console.log(`INFO countdown is ${a} (hours granularity); tick not asserted`);
    const events = await page.getByTestId('live-event').count();
    console.log(`INFO /live: ${running} running, next ${next}, ${events} upcoming event(s)`);
  }
  await s.ctx.close();

  // Empty: the browser is told no calendar exists, then the board refreshes.
  const e = await open('/live', {
    route: (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ network: 'devnet', asOf: String(Math.floor(Date.now() / 1000)), protocolPaused: false, calendars: [] }) }),
  });
  await e.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await e.page.getByTestId('live-empty').waitFor({ timeout: 10_000 });
  const text = await e.page.getByTestId('live-empty').innerText();
  check(/No market has a session scheduled/.test(text) && /No market calendar is indexed/.test(text), '/live with no calendar shows the honest empty state', text.replace(/\n/g, ' ').slice(0, 160));
  check((await e.page.getByTestId('live-event').count()) === 0 && (await e.page.getByTestId('live-next').count()) === 0, 'the empty state invents no event and no countdown');
  await e.page.screenshot({ path: `${OUT}/live-empty-desktop-light.png`, fullPage: true });
  await audit('/live empty state', e);
  await e.ctx.close();

  // A calendar with every session in the past: also empty, and it says so differently.
  const past = await open('/live', {
    route: (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ network: 'devnet', asOf: String(Math.floor(Date.now() / 1000)), protocolPaused: false, calendars: [{ address: '4YRGverHdwFRntHPhmHppAFGp4pag5pvVgQX4QHDb7FS', id: '1', admin: 'a', timelockSecs: '604800', state: 'closed', halted: false, current: null, next: null, previous: null, sessionCount: 2, upcomingSessions: 0, schedule: [], feeds: [], pendingUpdate: null, pendingAdmin: null, crosses: [], verified: true, indexInSync: true }] }) }),
  });
  await past.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await past.page.getByTestId('live-empty').waitFor({ timeout: 10_000 });
  check(/1 market calendar is indexed, and none lists a session/.test(await past.page.getByTestId('live-empty').innerText()), '/live with calendars whose sessions all ended says exactly that');
  await past.ctx.close();

  // API down: the last good data stays and the page says the refresh failed.
  const down = await open('/live', { route: (r) => r.abort('failed') });
  const before = await down.page.getByTestId('live-event').count();
  await down.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await down.page.getByTestId('live-stale').waitFor({ timeout: 10_000 });
  check(/last refresh failed/.test(await down.page.getByTestId('live-stale').innerText()) && (await down.page.getByTestId('live-event').count()) === before, '/live keeps the last good data and says the refresh failed when the API cannot be reached', await down.page.getByTestId('live-stale').innerText());
  await down.page.screenshot({ path: `${OUT}/live-api-down-desktop-light.png`, fullPage: true });
  await down.ctx.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
