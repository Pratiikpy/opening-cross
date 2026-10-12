// A scripted, reproducible tour of the live product, recorded as video: every frame comes from the real deployed site and
// API, with a short caption on each screen. Nothing is mocked; the tour only reads (no wallet, no transaction).
//   BASE_URL=https://opening-bell-psi.vercel.app API_URL=https://98-87-59-136.sslip.io OUT=/path/demo.webm node e2e/demo-tour.mjs
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'https://opening-bell-psi.vercel.app';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const OUT = process.env.OUT ?? 'demo-live.webm';
mkdirSync(dirname(OUT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const crosses = (await (await fetch(`${API}/v1/crosses?limit=200`)).json()).crosses;
const settled = crosses.filter((c) => c.state === 'Finalized' && c.clearing_price && Number(c.matched) > 0).sort((a, b) => Number(b.orders_committed) - Number(a.orders_committed))[0];
const now = Math.floor(Date.now() / 1000);
const open = crosses.find((c) => c.state === 'Live' && Number(c.close_ts) > now);
if (!settled) throw new Error('no settled cross to show');

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light', recordVideo: { dir: dirname(OUT), size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();

async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:99999;background:#0b0b0f;color:#fff;font:600 30px "Hanken Grotesk",system-ui,sans-serif;padding:16px 30px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);max-width:1500px;text-align:center;letter-spacing:-0.3px';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
async function scrollTo(y, ms = 1500) {
  await page.evaluate(([top, d]) => new Promise((res) => { const start = window.scrollY; const t0 = performance.now(); const step = (now) => { const k = Math.min(1, (now - t0) / d); window.scrollTo(0, start + (top - start) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); }), [y, ms]);
}
async function visit(path, text, hold) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await caption(text);
  await sleep(hold);
}

await visit('/', 'Opening Bell: one fair price for every new market on Solana', 4500);
await scrollTo(700); await caption('Live from the indexer: crosses opened and cleared on Solana devnet'); await sleep(4000);
await scrollTo(1400); await caption('Everything is checkable: the verifier recomputes any result'); await sleep(3500);
await visit('/crosses', 'Every cross is public: open, sealed, cleared or settled', 5000);
await visit(`/crosses/${settled.address}`, 'A settled cross: one clearing price, and every filled order pays it', 5500);
await scrollTo(500); await caption('The order book as it cleared, with the fills and refunds'); await sleep(4500);
await scrollTo(900); await caption('An independent implementation recomputed this cross and matched it'); await sleep(4500);
if (open) { await visit(`/crosses/${open.address}`, 'An open cross: connect a wallet to place an order', 5000); await scrollTo(500); await sleep(2500); }
await visit('/accuracy', 'Every price band is signed before the close and graded after it: the record starts with the first live cross', 5500);
await visit('/premium', 'A live premium monitor for tokenized stocks, measured on mainnet', 5500);
await visit('/developers', 'An SDK, a verifier, REST and WebSocket APIs, and an MCP server for agents', 5500);
await scrollTo(800); await sleep(3000);
await visit('/status', 'Live status of the indexer and the API', 4500);
await visit('/', 'Opening Bell: one fair price. Live on Solana devnet.', 3500);

await ctx.close();
const video = await page.video()?.path();
console.log('recorded', video);
await browser.close();
