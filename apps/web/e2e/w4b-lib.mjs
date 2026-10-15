// Shared by the W4B browser tests: everything from the W3F library, with this harness's defaults, plus the helpers the Wave 3D screens share.
//
//   cd services/api && W4B_PORT=8390 npx tsx test/w4b-harness.ts
//   cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:8390 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8390/rpc NEXT_DIST_DIR=node_modules/.cache/next-4b next dev -p 3491
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch directory> node e2e/w4b-graduation.mjs
process.env.BASE_URL ??= 'http://localhost:3491';
process.env.API_URL ??= 'http://127.0.0.1:8390';
const lib = await import('./w3f-lib.mjs');
export const { BASE, OUT, api, connect, ensureConnected, eventually, failures, find, fixtures, gone, hasAccount, launch, log, person, reset, sent, setMode, shape, signerOf, sleep, text, visible, visualPass, settle, COMBOS } = lib;

/** Opens a path and waits until the network has gone quiet. */
export async function go(p, path) {
  // A page that keeps a request in flight (a poll, a socket) never goes idle; the tests wait for the elements they need, so idle is waited for briefly, not required.
  await p.page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
}

/** Clicks an action's button and waits for its confirmation; returns the transaction(s) the wallet signed. */
export async function act(p, testId, ms = 20000) {
  await reset();
  await p.page.getByTestId(testId).click();
  const done = await visible(p.page.getByTestId(`${testId}-done`), ms);
  const tx = await sent();
  return { done, tx, shape: shape(tx).flat() };
}

/** Clicks an action's button and waits for the refusal it shows; the number of transactions sent must be zero. */
export async function refusedBy(p, testId, ms = 15000) {
  await reset();
  await p.page.getByTestId(testId).click();
  const shown = await visible(p.page.getByTestId(`${testId}-error`), ms);
  return { shown, message: shown ? await text(p.page.getByTestId(`${testId}-error`)) : '', n: (await sent()).length };
}

/** The instruction `program.instruction` among the transactions sent, with its decoded arguments. */
export const ixOf = (tx, program, instruction) => find(tx, program, instruction);

/** No console error, page error or failed request, ignoring the HTTP statuses a test provokes on purpose. */
export const clean = (p, ignore = []) => p.problems.filter((x) => !ignore.some((i) => x.includes(i)));
