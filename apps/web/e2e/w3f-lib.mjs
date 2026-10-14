// Shared by the W3F browser tests: everything from the issuer W3B library, plus a connect that copes with a wallet the page restored on its own,
// and a wait for text that arrives after a read (amounts are shown once the token's decimals have been read).
export * from './issuer-w3b-lib.mjs';
import { sleep, text } from './issuer-w3b-lib.mjs';

/**
 * Connects the person’s wallet unless the page restores it on its own. The page shows "Connect wallet" for a moment before a remembered wallet is
 * restored, so the button is pressed only after the restore has had three seconds to happen.
 */
export async function ensureConnected(p, address) {
  const connected = p.page.getByLabel(`Connected as ${address}`);
  const button = p.page.getByRole('button', { name: 'Connect wallet' });
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (await connected.isVisible().catch(() => false)) return;
    await sleep(100);
  }
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await p.page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  }
  await connected.waitFor({ timeout: 15000 });
}

/** Waits (not for the clock, for the words) until the element’s text matches. */
export async function eventually(loc, re, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(await text(loc))) return true;
    await sleep(250);
  }
  return false;
}
