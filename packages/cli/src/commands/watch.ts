import { type CrossDetail, compareCross, readCrossFromChain } from '@opening-cross/client';
import { type CommandDef, noExtra, positional } from '../command.js';
import type { Context } from '../context.js';
import { EXIT, UsageError } from '../exit.js';
import { describeCross, jsonText } from '../format.js';
import { addressArg, stringOpt } from '../inputs.js';

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

function intOpt(v: string | boolean | undefined, name: string, min: number): number | undefined {
  const s = stringOpt(v);
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s) || Number(s) < min) throw new UsageError(`${name} must be a whole number of at least ${min} (got "${s}").`);
  return Number(s);
}

const watch: CommandDef = {
  path: ['watch'],
  summary: 'Follow a cross: the API’s event stream when --api is given, otherwise the chain polled. Ctrl+C stops.',
  args: '<cross>',
  options: {
    'poll-interval': { type: 'string', value: 'secs', description: 'seconds between chain reads when there is no API (default 3)' },
    count: { type: 'string', value: 'n', description: 'stop after this many updates (default: run until interrupted)' },
    timeout: { type: 'string', value: 'secs', description: 'stop after this many seconds' },
  },
  examples: ['opening-cross watch F5k8...QPnZ --api http://localhost:8080 --json'],
  async run(ctx: Context, args) {
    noExtra(args, 1);
    const addr = addressArg(positional(args, 0, 'cross'), '<cross>');
    const interval = (intOpt(args.values['poll-interval'], '--poll-interval', 1) ?? 3) * 1000;
    const max = intOpt(args.values.count, '--count', 1);
    const timeout = intOpt(args.values.timeout, '--timeout', 1);
    const ac = new AbortController();
    const stop = () => ac.abort();
    ctx.runtime.signal?.addEventListener('abort', stop, { once: true });
    const timer = timeout !== undefined ? setTimeout(stop, timeout * 1000) : null;
    let updates = 0;
    const tick = () => {
      updates += 1;
      if (max !== undefined && updates >= max) stop();
    };

    const first = await readCrossFromChain(ctx.rpc, addr);
    const show = (d: CrossDetail, why: string, now: bigint) => {
      if (ctx.json) ctx.io.out(jsonText({ type: 'state', reason: why, cross: d, now: now.toString() }));
      else for (const l of [`-- ${why}`, ...describeCross(d, now)]) ctx.io.out(l);
      tick();
    };
    show(first.detail, 'current state', await ctx.rpc.unixTime());

    let last = first.detail;
    const changed = (a: CrossDetail, b: CrossDetail) => !compareCross(a, b).matches;
    const refresh = async (why: string) => {
      const next = await readCrossFromChain(ctx.rpc, addr);
      if (changed(last, next.detail)) {
        last = next.detail;
        show(next.detail, why, await ctx.rpc.unixTime());
      }
    };

    if (ctx.hasApi && !ac.signal.aborted) {
      const api = ctx.api();
      let pending = Promise.resolve();
      const close = api.subscribe(addr, (event) => {
        if (event.type !== 'event') return;
        // Report the event itself, then the state it produced.
        if (ctx.json) ctx.io.out(jsonText({ type: 'event', name: event.name, slot: event.slot, signature: event.signature, payload: event.payload }));
        else ctx.io.out(`-- event ${String(event.name)} (slot ${String(event.slot)}, ${String(event.signature).slice(0, 12)}...)`);
        pending = pending.then(() => refresh(`after ${String(event.name)}`)).catch((e) => ctx.io.err(`could not refresh: ${e instanceof Error ? e.message : String(e)}`));
      });
      await new Promise<void>((resolve) => ac.signal.addEventListener('abort', () => resolve(), { once: true }));
      close();
      await pending;
    } else {
      while (!ac.signal.aborted) {
        await wait(interval, ac.signal);
        if (ac.signal.aborted) break;
        await refresh('changed').catch((e) => ctx.io.err(`could not read the cross: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    if (timer) clearTimeout(timer);
    return EXIT.OK;
  },
};

export const watchCommands: CommandDef[] = [watch];
