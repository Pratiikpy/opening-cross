// The attester's configuration: which assets it attests and where each reserve figure comes from. A JSON file named by ATTESTER_CONFIG; secrets are never in it (a header value
// `env:NAME` is read from the environment when the request is made).
//
//   {
//     "refreshFraction": 0.5,          // post again once a statement is this fraction of the policy's maximum age old (default 0.5)
//     "minChangeBps": 50,              // or as soon as the reserve moved this much (default 50 = 0.5%)
//     "minIntervalSecs": 60,           // never post twice in less than this (default 60)
//     "maxIncreaseFactor": 4,          // refuse a figure more than this many times the last one: a glitch that overstates backing gives false comfort (default 4; 0 turns it off)
//     "assets": [
//       { "mint": "<asset mint>", "source": { "type": "token-accounts", "accounts": ["<token account>", ...], "mint": "<mint those accounts hold>" } },
//       { "mint": "<asset mint>", "source": { "type": "http-json", "url": "https://...", "valuePath": "reserves.total", "asOfPath": "asOf", "maxStalenessSecs": 3600, "scale": { "mul": "1", "div": "100" }, "headers": { "authorization": "env:CUSTODIAN_TOKEN" } } },
//       { "mint": "<asset mint>", "source": { "type": "file-json", "path": "/var/lib/reserve.json", "valuePath": "backing", "asOfPath": "asOf", "maxStalenessSecs": 3600 } }
//     ]
//   }
//
// `scale` turns the source's unit into the asset's own atoms: value x mul / div, rounded down, in integers. Figures must be non-negative integers (a JSON number with a fraction is refused,
// not rounded: an attester that rounds up overstates the backing).
import { type Address, isAddress } from '@solana/kit';

export type Scale = { mul: bigint; div: bigint };
export type Source =
  | { type: 'token-accounts'; accounts: Address[]; mint?: Address }
  | { type: 'http-json'; url: string; valuePath: string; asOfPath?: string; maxStalenessSecs: number; scale: Scale; headers: Record<string, string>; allowInsecure: boolean }
  | { type: 'file-json'; path: string; valuePath: string; asOfPath?: string; maxStalenessSecs: number; scale: Scale };
export type AssetConfig = { mint: Address; source: Source };
export type AttesterConfig = { refreshFraction: number; minChangeBps: number; minIntervalSecs: number; maxIncreaseFactor: number; assets: AssetConfig[] };

export class ConfigError extends Error {}

const bad = (path: string, message: string): never => {
  throw new ConfigError(`${path}: ${message}`);
};
const obj = (v: unknown, path: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(path, 'must be an object'));
const only = (o: Record<string, unknown>, keys: readonly string[], path: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length > 0) bad(path, `unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}; the fields are ${keys.join(', ')}`);
};
const address = (v: unknown, path: string): Address => (typeof v === 'string' && isAddress(v) ? v : bad(path, 'must be a base58 Solana address'));
const text = (v: unknown, path: string): string => (typeof v === 'string' && v.length > 0 ? v : bad(path, 'must be a non-empty string'));
const num = (v: unknown, path: string, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : bad(path, `must be a number from ${min} to ${max}`));
const posInt = (v: unknown, path: string): bigint => (typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : bad(path, 'must be a positive integer (a decimal string or a safe integer)'));

function scale(v: unknown, path: string): Scale {
  if (v === undefined) return { mul: 1n, div: 1n };
  const o = obj(v, path);
  only(o, ['mul', 'div'], path);
  return { mul: posInt(o.mul ?? '1', `${path}.mul`), div: posInt(o.div ?? '1', `${path}.div`) };
}

export function parseConfig(raw: unknown): AttesterConfig {
  const c = obj(raw, 'config');
  only(c, ['refreshFraction', 'minChangeBps', 'minIntervalSecs', 'maxIncreaseFactor', 'assets'], 'config');
  if (!Array.isArray(c.assets) || c.assets.length === 0) bad('config.assets', 'name at least one asset');
  const seen = new Set<string>();
  const assets = (c.assets as unknown[]).map((a, i): AssetConfig => {
    const path = `config.assets[${i}]`;
    const o = obj(a, path);
    only(o, ['mint', 'source'], path);
    const mint = address(o.mint, `${path}.mint`);
    if (seen.has(mint)) bad(`${path}.mint`, `${mint} is configured twice`);
    seen.add(mint);
    const s = obj(o.source, `${path}.source`);
    switch (s.type) {
      case 'token-accounts': {
        only(s, ['type', 'accounts', 'mint'], `${path}.source`);
        if (!Array.isArray(s.accounts) || s.accounts.length === 0) bad(`${path}.source.accounts`, 'name at least one token account');
        return { mint, source: { type: 'token-accounts', accounts: (s.accounts as unknown[]).map((x, j) => address(x, `${path}.source.accounts[${j}]`)), ...(s.mint !== undefined && { mint: address(s.mint, `${path}.source.mint`) }) } };
      }
      case 'http-json': {
        only(s, ['type', 'url', 'valuePath', 'asOfPath', 'maxStalenessSecs', 'scale', 'headers', 'allowInsecure'], `${path}.source`);
        const url = text(s.url, `${path}.source.url`);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return bad(`${path}.source.url`, 'is not a URL');
        }
        const allowInsecure = s.allowInsecure === true;
        if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) bad(`${path}.source.url`, 'must be https (set allowInsecure for a local http source)');
        const headers: Record<string, string> = {};
        if (s.headers !== undefined) for (const [k, v] of Object.entries(obj(s.headers, `${path}.source.headers`))) headers[k] = text(v, `${path}.source.headers.${k}`);
        return { mint, source: { type: 'http-json', url, valuePath: text(s.valuePath, `${path}.source.valuePath`), ...(s.asOfPath !== undefined && { asOfPath: text(s.asOfPath, `${path}.source.asOfPath`) }), maxStalenessSecs: num(s.maxStalenessSecs ?? 3_600, `${path}.source.maxStalenessSecs`, 1, 30 * 86_400), scale: scale(s.scale, `${path}.source.scale`), headers, allowInsecure } };
      }
      case 'file-json': {
        only(s, ['type', 'path', 'valuePath', 'asOfPath', 'maxStalenessSecs', 'scale'], `${path}.source`);
        return { mint, source: { type: 'file-json', path: text(s.path, `${path}.source.path`), valuePath: text(s.valuePath, `${path}.source.valuePath`), ...(s.asOfPath !== undefined && { asOfPath: text(s.asOfPath, `${path}.source.asOfPath`) }), maxStalenessSecs: num(s.maxStalenessSecs ?? 3_600, `${path}.source.maxStalenessSecs`, 1, 30 * 86_400), scale: scale(s.scale, `${path}.source.scale`) } };
      }
      default:
        return bad(`${path}.source.type`, 'must be "token-accounts", "http-json" or "file-json"');
    }
  });
  return {
    refreshFraction: c.refreshFraction === undefined ? 0.5 : num(c.refreshFraction, 'config.refreshFraction', 0.05, 0.95),
    minChangeBps: c.minChangeBps === undefined ? 50 : num(c.minChangeBps, 'config.minChangeBps', 1, 10_000),
    minIntervalSecs: c.minIntervalSecs === undefined ? 60 : num(c.minIntervalSecs, 'config.minIntervalSecs', 1, 86_400),
    maxIncreaseFactor: c.maxIncreaseFactor === undefined ? 4 : num(c.maxIncreaseFactor, 'config.maxIncreaseFactor', 0, 1_000_000),
    assets,
  };
}
