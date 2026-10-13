// Shared by the issuer W3B browser tests: the harness client, one isolated browser context per person, the wallet, the checks, and the
// per-page visual pass (screenshot, axe, overflow, console) in light and dark at 1440 and 390.
//
//   cd services/api && ISSUER_PORT=8190 ISSUER_KEY_FILE=<scratch>/issuer-key.json npx tsx test/helpers/issuer-harness.ts
//   cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:8190 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8190/rpc NEXT_DIST_DIR=.next-issuer next dev -p 3410
//   BASE_URL=http://localhost:3410 API_URL=http://127.0.0.1:8190 OUT=../../docs/evidence/screens/w3b node e2e/issuer-w3b-wizard.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { webcrypto } from 'node:crypto';
import { chromium } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

export const BASE = process.env.BASE_URL ?? 'http://localhost:3410';
export const API = process.env.API_URL ?? 'http://127.0.0.1:8190';
export const OUT = process.env.OUT ?? 'e2e/screens/w3b';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./issuer-wallet.js', import.meta.url), 'utf8');

export const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, init);
  return res.json();
};
export const fixtures = () => api('/__fixtures');
export const sent = async () => (await api('/__sent')).sent;
export const reset = () => api('/__reset', { method: 'POST' });
export const setMode = (mode) => api('/__mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });

export const failures = [];
export const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};
export const visible = (loc, ms = 15000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
export const gone = (loc, ms = 8000) => loc.waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);
export const text = async (loc) => ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CHROME names a browser; otherwise the newest Chromium Playwright has installed (the pinned build may not be the one on this machine). */
function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = `${homedir()}/AppData/Local/ms-playwright`;
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    const exe = `${root}/${b}/chrome-win64/chrome.exe`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}
export const launch = () => chromium.launch(chromePath() ? { executablePath: chromePath() } : {});

/** A fresh Ed25519 key in the wallet's format (64 bytes: seed then public key). */
export async function freshSecret() {
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return [...pkcs8.slice(-32), ...raw];
}

/** A person: their own context (so their own storage and wallet), with every console error, page error and failed request collected. */
export async function person(browser, { name = 'person', secret, viewport = { width: 1440, height: 900 }, scheme = 'light' }) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, timezoneId: 'UTC' });
  if (secret) {
    await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret, chain: 'solana:devnet' })};`);
    await ctx.addInitScript(WALLET_JS);
  }
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`${name} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/[?&]_rsc=/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`${name} requestfailed: ${r.url().slice(0, 100)} ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/[?&]_rsc=/.test(r.url())) problems.push(`${name} http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 110)}`);
  });
  return { ctx, page, problems, name };
}

export async function connect(p, address) {
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await p.page.getByLabel(`Connected as ${address}`).waitFor({ timeout: 15000 });
}

/** The wallet balance and the like come from the harness; a page is ready when the network has gone quiet. */
export const settle = (page) => page.waitForLoadState('networkidle').catch(() => undefined);

// ---- what a transaction did

/** The sent transactions as a list of [{instruction, program}] lists, oldest first. */
export const shape = (list) => list.map((t) => t.transaction.map((i) => `${i.program}.${i.instruction ?? '?'}`));
export const find = (list, program, instruction) => list.flatMap((t) => t.transaction.map((ix) => ({ ...ix, signature: t.signature, feePayer: t.feePayer }))).find((ix) => ix.program === program && ix.instruction === instruction);
export const hasAccount = (ix, address) => Boolean(ix?.accounts.some((a) => a.address === address));
export const signerOf = (ix, address) => Boolean(ix?.accounts.some((a) => a.address === address && a.signer));

// ---- the visual pass

export const COMBOS = [
  ['desktop-light', { width: 1440, height: 900 }, 'light'],
  ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
  ['mobile-light', { width: 390, height: 844 }, 'light'],
  ['mobile-dark', { width: 390, height: 844 }, 'dark'],
];

/**
 * Opens a page in each of the four views, runs `setup(p)` to reach the state worth looking at, then saves a full-page screenshot and fails on a
 * console error, a failed request, horizontal overflow or an axe violation (WCAG 2.1 AA).
 */
export async function visualPass(browser, { name, route, secret, setup, ignore = [] }) {
  for (const [combo, viewport, scheme] of COMBOS) {
    const p = await person(browser, { name: `${name}-${combo}`, secret, viewport, scheme });
    await p.page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    if (setup) await setup(p);
    await settle(p.page);
    const theme = await p.page.evaluate(() => document.documentElement.dataset.theme);
    const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const axe = await new AxeBuilder({ page: p.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const file = `${OUT}/${name}-${combo}.png`;
    await p.page.screenshot({ path: file, fullPage: true });
    const issues = [...p.problems.filter((x) => !ignore.some((i) => x.includes(i)))];
    if (theme !== scheme) issues.push(`theme: expected ${scheme}, applied ${theme}`);
    if (overflow > 0) issues.push(`horizontal overflow ${overflow}px`);
    for (const v of axe.violations) issues.push(`axe ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
    log(issues.length === 0, `visual ${name} ${combo} -> ${file}${issues.length ? ` :: ${issues.join(' ;; ')}` : ''}`);
    await p.ctx.close();
  }
}
