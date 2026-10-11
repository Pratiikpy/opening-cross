// Rebuilds data/registry.json from the issuers' own published lists and the chain.
//
//   RPC_URL  Solana mainnet RPC (default: the public endpoint)
//
// 1. xStocks (Backed): every page of https://api.xstocks.fi/api/v2/public/assets, the asset's Solana deployment.
// 2. Ondo Global Markets: the token CSV linked from https://docs.ondo.finance/addresses, the "Solana Deployed Address" column.
// 3. Canonical addresses published by the stablecoin issuers (each with the page that shows it).
// 4. Every listed mint is read on chain; the issuer-power rule per family is the set of holders the issuer is seen using.
//
// A list either arrives whole or the run fails: a bad page, a missing column or an address that is not on chain stops
// it, and the previous file is left untouched.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createSolanaRpc } from '@solana/kit';
import { parseCsv } from '../src/csv.js';
import { observeMints } from '../src/observe.js';
import type { FamilyRule, FingerprintKey, GenuineMint, MintObservation, RegistryData, SourceStamp } from '../src/types.js';
import { FINGERPRINT_KEYS } from '../src/types.js';

const OUT = new URL('../data/registry.json', import.meta.url);
const XSTOCKS_URL = 'https://api.xstocks.fi/api/v2/public/assets';
const ONDO_PAGE = 'https://docs.ondo.finance/addresses';
// The CSV link published on the addresses page on 2026-10-11; used only when the page yields no link.
const ONDO_FALLBACK = 'https://www.dropbox.com/scl/fi/qjfxyg748mx0dwi6up86d/EXTERNAL-Ondo-GM-Tokens-Ondo-GM-Tokens.csv?rlkey=n3no1w78wrah3umsl0nr9s77i&dl=1';

/** Canonical mints the issuers publish, each with the page that shows the address. */
const CANONICAL = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
  { mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', symbol: 'EURC', name: 'EURC', source: 'https://developers.circle.com/stablecoins/eurc-contract-addresses' },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD', source: 'https://tether.to/en/supported-protocols/' },
  { mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', symbol: 'PYUSD', name: 'PayPal USD', source: 'https://paxos.com/pyusd' },
] as const;

const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function get(url: string): Promise<{ body: string; hash: string }> {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { body: new TextDecoder().decode(buf), hash: sha256(buf) };
}

interface XAsset {
  name: string;
  symbol: string;
  isin: string | null;
  underlyingSymbol: string | null;
  deployments: { network: string; address: string }[];
}

async function xstocks(now: string): Promise<{ mints: GenuineMint[]; stamp: SourceStamp }> {
  const assets: XAsset[] = [];
  const hashes: string[] = [];
  for (let page = 0; page < 100; page++) {
    const { body, hash } = await get(`${XSTOCKS_URL}?page=${page}&pageSize=100`);
    hashes.push(hash);
    const j = JSON.parse(body) as { nodes: XAsset[]; page: { hasNextPage: boolean } };
    assets.push(...j.nodes);
    if (!j.page.hasNextPage) break;
  }
  const mints: GenuineMint[] = [];
  for (const a of assets) {
    const d = a.deployments.find((x) => x.network === 'Solana');
    if (!d) continue;
    mints.push({ mint: d.address, family: 'xstock', symbol: a.symbol, name: a.name, ticker: a.underlyingSymbol ? a.underlyingSymbol.toUpperCase() : null, isin: a.isin, listedBy: ['xstocks_api'] });
  }
  if (mints.length === 0) throw new Error('xStocks API returned no Solana deployments');
  return { mints, stamp: { id: 'xstocks_api', url: `${XSTOCKS_URL}?page=<n>&pageSize=100`, fetchedAt: now, contentHash: sha256(hashes.join('\n')), count: mints.length } };
}

async function ondo(now: string): Promise<{ mints: GenuineMint[]; stamp: SourceStamp }> {
  let csvUrl = ONDO_FALLBACK;
  try {
    const page = await get(ONDO_PAGE);
    const m = /https:\/\/www\.dropbox\.com\/scl\/fi\/[^"'\s)\\]+\.csv\?[^"'\s)\\]+/.exec(page.body);
    if (m) csvUrl = m[0].replace(/&amp;/g, '&').replace(/dl=0/, 'dl=1');
  } catch {
    // keep the recorded link
  }
  const { body, hash } = await get(csvUrl);
  const rows = parseCsv(body);
  const header = rows[0] ?? [];
  const col = (n: string): number => {
    const i = header.indexOf(n);
    if (i < 0) throw new Error(`Ondo CSV has no "${n}" column`);
    return i;
  };
  const [cName, cSymbol, cSol, cTicker, cIsin] = [col('Name'), col('Symbol'), col('Solana Deployed Address'), col('Stock Ticker'), col('ISIN')];
  const mints: GenuineMint[] = [];
  for (const r of rows.slice(1)) {
    const mint = (r[cSol] ?? '').trim();
    if (!mint) continue;
    mints.push({ mint, family: 'ondo', symbol: (r[cSymbol] ?? '').trim(), name: (r[cName] ?? '').trim(), ticker: (r[cTicker] ?? '').trim().toUpperCase() || null, isin: (r[cIsin] ?? '').trim() || null, listedBy: ['ondo_csv'] });
  }
  if (mints.length === 0) throw new Error('Ondo CSV has no Solana addresses');
  return { mints, stamp: { id: 'ondo_csv', url: csvUrl, fetchedAt: now, contentHash: hash, count: mints.length } };
}

async function canonical(now: string): Promise<{ mints: GenuineMint[]; stamps: SourceStamp[] }> {
  const mints: GenuineMint[] = [];
  const stamps: SourceStamp[] = [];
  for (const c of CANONICAL) {
    const { body, hash } = await get(c.source);
    if (!body.includes(c.mint)) throw new Error(`${c.source} does not show ${c.symbol} mint ${c.mint}`);
    mints.push({ mint: c.mint, family: 'canonical', symbol: c.symbol, name: c.name, ticker: null, isin: null, listedBy: [`issuer_page:${new URL(c.source).host}`] });
    stamps.push({ id: `issuer_page:${new URL(c.source).host}:${c.symbol}`, url: c.source, fetchedAt: now, contentHash: hash, count: 1 });
  }
  return { mints, stamps };
}

/** An address is one of the issuer's own keys when it holds a power on at least this many of the family's listed mints. */
const MIN_SUPPORT = 3;

function ruleOf(family: 'xstock' | 'ondo', obs: readonly MintObservation[], rpcLabel: string, now: string): FamilyRule {
  const perKey = new Map<FingerprintKey, Map<string, number>>();
  const total = new Map<string, number>();
  for (const o of obs) {
    for (const k of FINGERPRINT_KEYS) {
      const h = o.fingerprint[k];
      if (!h) continue;
      const m = perKey.get(k) ?? new Map<string, number>();
      m.set(h, (m.get(h) ?? 0) + 1);
      perKey.set(k, m);
      total.set(h, (total.get(h) ?? 0) + 1);
    }
  }
  // The issuer's keys are the addresses that hold powers across the family. A key may serve a different power on one
  // mint (Ondo's mint authority is also the permanent delegate of its dollar token), so each power accepts every
  // issuer key seen holding it, not only the keys that hold it often.
  const core = new Set([...total].filter(([, n]) => n >= MIN_SUPPORT).map(([h]) => h));
  const accepted: Partial<Record<FingerprintKey, string[]>> = {};
  for (const [k, m] of perKey) {
    const keep = [...m.entries()].filter(([h]) => core.has(h)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    if (keep.length > 0) accepted[k] = keep.map(([h]) => h);
  }
  return { family, accepted, measured: obs.length, evidence: `read from ${rpcLabel} on ${now}; an issuer key is an address holding powers on at least ${MIN_SUPPORT} listed mints of the family` };
}

const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const rpcUrl = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const rpc = createSolanaRpc(rpcUrl);
  const [x, o, c] = [await xstocks(now), await ondo(now), await canonical(now)];
  const all = [...x.mints, ...o.mints, ...c.mints];
  const seen = new Set<string>();
  for (const m of all) {
    if (seen.has(m.mint)) throw new Error(`mint ${m.mint} appears in two lists`);
    seen.add(m.mint);
  }

  const obs: MintObservation[] = [];
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  for (let i = 0; i < all.length; i += 100) {
    obs.push(...(await observeMints(rpc, all.slice(i, i + 100).map((m) => m.mint), nowS)));
    process.stderr.write(`\rread ${Math.min(i + 100, all.length)}/${all.length}`);
  }
  process.stderr.write('\n');
  const byMint = new Map(obs.map((v) => [v.mint, v]));
  const missing = all.filter((m) => !byMint.get(m.mint)?.isMint);
  if (missing.length > 0) {
    throw new Error(`${missing.length} listed addresses are not token mints on chain, e.g. ${missing.slice(0, 3).map((m) => `${m.symbol} ${m.mint}`).join(', ')}`);
  }

  const rules = [
    ruleOf('xstock', x.mints.map((m) => byMint.get(m.mint)!), rpcUrl.replace(/\/\/[^/]*@/, '//'), now),
    ruleOf('ondo', o.mints.map((m) => byMint.get(m.mint)!), rpcUrl.replace(/\/\/[^/]*@/, '//'), now),
  ];
  const sources = [x.stamp, o.stamp, ...c.stamps];
  const body = { rules, mints: all };
  const data: RegistryData = {
    schema: 'opening-cross/authenticity-registry/v1',
    snapshotHash: sha256(canonicalJson(body)),
    generatedAt: now,
    sources,
    rules,
    mints: all,
  };
  writeFileSync(OUT, `${JSON.stringify(data, null, 1)}\n`);

  // Report how many listed mints each rule accepts: a rule that rejects its own family is a bad rule.
  for (const r of rules) {
    const fam = all.filter((m) => m.family === r.family);
    const bad = fam.filter((m) => {
      const fp = byMint.get(m.mint)!.fingerprint;
      return !fp.MINT_AUTHORITY || Object.entries(fp).some(([k, h]) => !(r.accepted[k as FingerprintKey] ?? []).includes(h as string));
    });
    console.log(`${r.family}: ${fam.length} listed, ${fam.length - bad.length} match the measured rule, ${bad.length} do not${bad.length ? ` (${bad.slice(0, 5).map((m) => m.symbol).join(', ')})` : ''}`);
  }
  console.log(`wrote ${all.length} mints, snapshot ${data.snapshotHash.slice(0, 16)}`);
}

await main();
