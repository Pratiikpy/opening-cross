// One page of live figures for a public dashboard (PRODUCT_FEATURES O1).
//
//   GET /v1/dashboard
//
// This route computes nothing. Each section is the answer of a route that already exists, fetched through the server itself, with
// the route named beside it, so a figure on the dashboard can be checked by opening the route it came from. A section whose route
// fails or is not enabled on this deployment is reported as unavailable, with the reason; it is never filled with a default. The
// program section is read from chain: when each of the five programs was last deployed and who may upgrade it.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import { CROSS_CALENDAR_PROGRAM_ADDRESS } from '@opening-cross/cross-calendar-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { TREASURY_PROGRAM_ADDRESS } from '@opening-cross/treasury-client';
import type { ApiDeps } from '../server.js';

export type DashboardDeps = Pick<ApiDeps, 'account' | 'network' | 'clock'>;
export type DashboardOptions = {
  /** Sections to leave out, by name. */
  skip?: readonly string[];
  /** How long a result is reused, in milliseconds. Default 15,000. */
  ttlMs?: number;
};

type Section = { ok: true; source: string; data: unknown } | { ok: false; source: string; error: string };

const BPF_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const PROGRAMS: [string, string][] = [
  ['cross_core', CROSS_CORE_PROGRAM_ADDRESS],
  ['cross_gate', CROSS_GATE_PROGRAM_ADDRESS],
  ['cross_settle', CROSS_SETTLE_PROGRAM_ADDRESS],
  ['cross_calendar', CROSS_CALENDAR_PROGRAM_ADDRESS],
  ['treasury', TREASURY_PROGRAM_ADDRESS],
];

const b58 = (bytes: Uint8Array): string => {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
};

/** The deployed state of an upgradeable program: where its code lives, when it was last written, and who may replace it. */
export async function programState(account: DashboardDeps['account'], program: string) {
  const prog = await account(program as Address);
  if (!prog) return { address: program, deployed: false as const };
  if (prog.owner !== BPF_UPGRADEABLE || prog.data.length < 36 || new DataView(prog.data.buffer, prog.data.byteOffset).getUint32(0, true) !== 2) return { address: program, deployed: true as const, upgradeable: false as const };
  const dataAddress = b58(prog.data.slice(4, 36));
  const pd = await account(dataAddress as Address);
  if (!pd || pd.data.length < 45) return { address: program, deployed: true as const, upgradeable: true as const, programData: dataAddress, error: 'the program data account could not be read' };
  const v = new DataView(pd.data.buffer, pd.data.byteOffset);
  const hasAuthority = pd.data[12] === 1;
  return {
    address: program,
    deployed: true as const,
    upgradeable: true as const,
    programData: dataAddress,
    lastDeployedSlot: v.getBigUint64(4, true).toString(),
    upgradeAuthority: hasAuthority ? b58(pd.data.slice(13, 45)) : null,
    allocatedBytes: pd.data.length - 45,
  };
}

export function registerDashboard(app: FastifyInstance, d: DashboardDeps, opts: DashboardOptions = {}): void {
  const ttl = opts.ttlMs ?? 15_000;
  const skip = new Set(opts.skip ?? []);
  let cache: { at: number; value: Promise<unknown> } | null = null;

  async function viaRoute(source: string, pick?: (body: unknown) => unknown): Promise<Section> {
    try {
      const res = await app.inject({ method: 'GET', url: source });
      if (res.statusCode === 404) return { ok: false, source, error: 'this route is not enabled on this deployment' };
      const body = JSON.parse(res.body) as unknown;
      if (res.statusCode >= 500) return { ok: false, source, error: `answered HTTP ${res.statusCode}: ${(body as { error?: string }).error ?? 'no reason given'}` };
      return { ok: true, source, data: pick ? pick(body) : body };
    } catch (e) {
      return { ok: false, source, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function build() {
    const sections: Record<string, () => Promise<Section>> = {
      health: () => viaRoute('/v1/health'),
      totals: () => viaRoute('/v1/stats'),
      execution: () => viaRoute('/v1/metrics/execution'),
      fairness: () => viaRoute('/v1/metrics/fairness', (b) => {
        const { perCross: _perCross, ...rest } = b as { perCross?: unknown };
        return rest;
      }),
      externalFlow: () => viaRoute('/v1/metrics/external-flow'),
      accuracy: () => viaRoute('/v1/accuracy'),
      fees: () => viaRoute('/v1/fees/ledger?limit=200', (b) => ({ totals: (b as { totals?: unknown }).totals, entries: ((b as { entries?: unknown[] }).entries ?? []).length })),
      protocol: () => viaRoute('/v1/fees/schedule', (b) => {
        const x = b as { paused?: boolean; feeRecipient?: string; protocolBps?: unknown; status?: string };
        return { paused: x.paused, feeRecipient: x.feeRecipient, protocolBps: x.protocolBps, feeStatus: x.status };
      }),
      ratings: () => viaRoute('/v1/integrity/ratings/track-record', (b) => {
        const { how: _how, ...rest } = b as { how?: string };
        return rest;
      }),
      programs: async (): Promise<Section> => {
        try {
          return { ok: true, source: 'chain: the five programs and their ProgramData accounts', data: await Promise.all(PROGRAMS.map(async ([name, addr]) => ({ name, ...(await programState(d.account, addr)) }))) };
        } catch (e) {
          return { ok: false, source: 'chain: the five programs', error: e instanceof Error ? e.message : String(e) };
        }
      },
    };
    const names = Object.keys(sections).filter((n) => !skip.has(n));
    const results = await Promise.all(names.map((n) => sections[n]!()));
    return {
      schema: 'opening-cross/dashboard/v1',
      network: d.network ?? 'unknown',
      generatedAt: new Date((d.clock?.() ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      note: 'Nothing on this page is computed by the dashboard. Each section is the answer of the route named in its source, which carries its own method and sample size. A section that failed says so instead of showing a default.',
      sections: Object.fromEntries(names.map((n, i) => [n, results[i]])),
    };
  }

  const send = (reply: FastifyReply, v: unknown) => reply.code(200).type('application/json').send(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  app.get('/v1/dashboard', async (_req, reply) => {
    if (!cache || Date.now() - cache.at > ttl) {
      const value = build();
      cache = { at: Date.now(), value };
      value.catch(() => {
        cache = null;
      });
    }
    return send(reply, await cache.value);
  });
}
