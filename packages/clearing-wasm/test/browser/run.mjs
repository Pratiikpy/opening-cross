// Runs the compiled clearing rule in real browsers. A small server hands a page the TypeScript loader (types stripped on the fly by Node, no bundler), the two .wasm files and the conformance vectors; the page fetches them the way a web app would,
// runs every vector through the module and reports. This test asserts the page's own report, a clean console, and what is on screen.
//
//   node test/browser/run.mjs            (CHROME=<path> to use another Chrome; OUT=<dir> for screenshots)
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from '@playwright/test';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = process.env.OUT ?? here('./out');
const CHROME = process.env.CHROME ?? 'C:/Users/prate/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
mkdirSync(OUT, { recursive: true });

// The loader uses types and nothing else TypeScript-only (no enums, no parameter properties), so removing the types is the whole compile.
const compile = (file) => stripTypeScriptTypes(readFileSync(here(file), 'utf8'));
const files = {
  '/': ['./index.html', 'text/html; charset=utf-8'],
  '/page.js': ['./page.js', 'text/javascript'],
  '/clearing.wasm': ['../../clearing.wasm', 'application/wasm'],
  '/clearing-v2.wasm': ['../../clearing-v2.wasm', 'application/wasm'],
  '/v1.json': ['../../../verifier/conformance/v1.json', 'application/json'],
  '/v2.json': ['../../../verifier/conformance/v2.json', 'application/json'],
};
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/favicon.ico') return void res.writeHead(204).end();
  if (path === '/index.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(compile('../../src/index.ts'));
  if (path === '/v2.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(compile('../../src/v2.ts'));
  const f = files[path];
  if (!f) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': f[1] }).end(readFileSync(here(f[0])));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

async function run(name, launcher, opts) {
  let browser;
  try {
    browser = await launcher.launch(opts);
  } catch (e) {
    return console.log(`SKIP ${name}: could not be launched (${String(e).split('\n')[0]})`);
  }
  for (const [theme, size] of [['light', { width: 1280, height: 800 }], ['dark', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: size });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('requestfailed', (r) => problems.push(`failed ${r.url()}`));
    page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
    await page.goto(url);
    await page.waitForFunction(() => window.__result?.done === true, null, { timeout: 120_000 });
    const result = await page.evaluate(() => window.__result);
    const tag = `${name} ${theme} ${size.width}px`;
    check(result.ok === true, `${tag}: every vector matches the program ${JSON.stringify(result.report?.map((r) => `${r.matching}/${r.total}`) ?? result.error)}`);
    check(result.report?.length === 3 && result.report[0].total === 525 && result.report[1].total === 437 && result.report[2].total === 525, `${tag}: the page ran 525 v1, 437 v2 and 525 v1-through-v2 vectors`);
    check((await page.locator('#status').innerText()) === 'Every vector matches the program.', `${tag}: the page says so`);
    check((await page.locator('#rows tr').count()) === 3, `${tag}: three result rows are on screen`);
    check((await page.evaluate(() => typeof WebAssembly.instantiate)) === 'function', `${tag}: it ran as real WebAssembly in the browser (${await page.evaluate(() => navigator.userAgent.match(/(Chrome|Firefox)\/[\d.]+/)?.[0])})`);
    check(problems.length === 0, `${tag}: zero console errors, page errors, failed requests and HTTP errors${problems.length ? ` ${problems.slice(0, 3).join(' | ')}` : ''}`);
    await page.screenshot({ path: `${OUT}/clearing-wasm-${name}-${theme}-${size.width}.png` });
    await ctx.close();
  }
  await browser.close();
}

await run('chromium', chromium, { executablePath: CHROME });
await run('firefox', firefox, {});
server.close();
console.log(failures === 0 ? '\nbrowser test passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
