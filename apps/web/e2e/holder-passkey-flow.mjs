// The passkey wallet in a real browser with a virtual authenticator that supports the PRF extension: it appears in the wallet list,
// connecting makes a passkey and shows a wallet address, the same passkey is the same wallet after a reload, a signature it makes
// verifies against that address, and nothing about the key is stored in the page.
//
//   BASE_URL=http://localhost:3412 node e2e/holder-passkey-flow.mjs
import { BASE, axe, check, launch, person, report, results, shot, sleep } from './holder-lib.mjs';

const browser = await launch();
const u = await person(browser, { name: 'passkey holder', theme: 'light', ignore: ['status of 429', ' 429 https://'] });
const p = u.page;
const cdp = await u.context.newCDPSession(p);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });

await p.goto(`${BASE}/portfolio`, { waitUntil: 'domcontentloaded' });
await p.getByTestId('passkey-card').waitFor({ timeout: 60_000 });
check((await p.getByTestId('passkey-card').innerText()).includes('devnet preview'), 'passkey: the card says it is a devnet preview');
await shot(u, 'passkey-card-1440-light');

const connect = async () => {
  const option = p.getByRole('button', { name: /Passkey wallet/ });
  for (let i = 0; i < 10 && !(await option.isVisible()); i++) {
    await p.getByRole('button', { name: 'Connect wallet' }).click({ timeout: 4000 }).catch(() => undefined);
    await option.waitFor({ timeout: 3000 }).catch(() => undefined);
  }
  check(await option.isVisible(), 'passkey: the wallet is listed beside installed wallets');
  await option.click();
  const chip = p.getByLabel(/Connected as /);
  await chip.waitFor({ timeout: 30_000 });
  return (await chip.getAttribute('aria-label')).replace('Connected as ', '');
};
const first = await connect();
check(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(first), `passkey: connecting made a passkey and a wallet address (${first.slice(0, 6)}…)`);
check((await p.evaluate(() => localStorage.getItem('opening-bell.passkey.v1'))) !== null, 'passkey: only a marker that a passkey exists is stored');
const storage = await p.evaluate(() => JSON.stringify({ ...localStorage }));
check(!/seed|secret|private|prf/i.test(storage), 'passkey: nothing in browser storage looks like a key');

// Sign a message with it and check the signature against the address, outside the page.
const sig = await p.evaluate(async (address) => {
  const wallets = [];
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (w) => (wallets.push(w), () => undefined) } }));
  const w = wallets.find((x) => x.name.startsWith('Passkey wallet'));
  const acct = w.accounts.find((a) => a.address === address);
  const msg = new TextEncoder().encode('Opening Bell comment\ncross: test');
  const [out] = await w.features['solana:signMessage'].signMessage({ account: acct, message: msg });
  return Array.from(out.signature);
}, first);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const decode58 = (s) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  while (bytes.length < 32) bytes.unshift(0);
  return Uint8Array.from(bytes);
};
const pub = await crypto.subtle.importKey('raw', decode58(first), { name: 'Ed25519' }, false, ['verify']);
check(await crypto.subtle.verify({ name: 'Ed25519' }, pub, Uint8Array.from(sig), new TextEncoder().encode('Opening Bell comment\ncross: test')), 'passkey: the signature verifies against the wallet address');

// The same passkey is the same wallet after a reload and a new connect.
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(1500);
check((await p.getByLabel(/Connected as /).count()) === 0, 'passkey: a reload does not reconnect silently (the person must be present)');
const second = await connect();
check(second === first, 'passkey: the same passkey gives the same wallet after a reload');
await shot(u, 'passkey-connected-1440-light');
check((await axe(u)).length === 0, 'passkey: portfolio page axe clean with the wallet connected');
report(u);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
