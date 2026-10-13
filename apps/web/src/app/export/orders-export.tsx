'use client';

import { useState } from 'react';
import { API_URL } from '@/lib/api';
import type { ReplayResponse } from '@/lib/replay';
import type { CrossDetail, OwnerOrder } from '@/lib/types';
import { useWallet } from '@/lib/wallet';
import { type CrossFacts, NOT_TAX_ADVICE, type OrderEvents, csvFilename, orderRow, ordersCsv } from './orders-csv';

type State = { phase: 'idle' } | { phase: 'working'; note: string } | { phase: 'done'; orders: number; crosses: number; missing: number; truncated: boolean } | { phase: 'error'; message: string };

const btn = 'inline-flex min-h-10 items-center justify-center rounded-full border border-border-strong px-4 text-sm text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60';

/** The API reads the cross from a rate-limited RPC: wait out a 429 or 503 and ask again, a few times, before leaving the cross out. */
async function crossOf(a: string): Promise<CrossDetail | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(`${API_URL}/v1/crosses/${a}`, { cache: 'no-store' });
      if (r.status === 429 || r.status === 503) {
        await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
        continue;
      }
      return r.ok ? ((await r.json()) as CrossDetail) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The index serves at most this many orders of a wallet (GET /v1/owners/:owner/orders). */
const API_ORDER_CAP = 500;

async function replayOf(cross: string): Promise<ReplayResponse | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${API_URL}/v1/replay/${cross}`, { cache: 'no-store' });
      if (r.status === 429 || r.status === 503) {
        await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
        continue;
      }
      return r.ok ? ((await r.json()) as ReplayResponse) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Builds the CSV in the browser from the API's records for the connected wallet; nothing about the wallet is sent anywhere else or stored. */
export function OrdersExport() {
  const { account } = useWallet();
  const [state, setState] = useState<State>({ phase: 'idle' });

  async function run() {
    if (!account) return;
    setState({ phase: 'working', note: 'Reading this wallet\'s orders and their crosses…' });
    const listed = await fetch(`${API_URL}/v1/owners/${account.address}/orders`, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<{ orders: OwnerOrder[] }>) : null), () => null);
    if (!listed) return setState({ phase: 'error', message: 'The Opening Cross API could not be reached, so no file was made. Nothing was changed.' });
    const addresses = [...new Set(listed.orders.map((o) => o.cross_address))];
    const details = new Map<string, CrossDetail>();
    const missing: string[] = [];
    for (let i = 0; i < addresses.length; i += 6) {
      await Promise.all(
        addresses.slice(i, i + 6).map(async (a) => {
          const c = await crossOf(a);
          if (c) details.set(a, c);
          else missing.push(a);
          setState({ phase: 'working', note: `Reading crosses: ${details.size + missing.length} of ${addresses.length}` });
        }),
      );
    }
    const loaded = { orders: listed.orders.filter((o) => details.has(o.cross_address)), details, missing, truncated: listed.orders.length >= API_ORDER_CAP };
    // Times and transactions come from each cross's recorded events: one read per cross, a few at a time.
    const crosses = [...loaded.details.keys()];
    const events = new Map<string, Map<string, OrderEvents>>();
    let done = 0;
    for (let i = 0; i < crosses.length; i += 6) {
      await Promise.all(
        crosses.slice(i, i + 6).map(async (a) => {
          const r = await replayOf(a);
          const byOrder = new Map<string, OrderEvents>();
          for (const e of r?.events ?? []) {
            const order = typeof e.details.order === 'string' ? e.details.order : null;
            if (!order) continue;
            const cur = byOrder.get(order) ?? { placedAt: null, placedTx: null, settledAt: null, settledTx: null };
            if (e.kind === 'order_placed') Object.assign(cur, { placedAt: e.time, placedTx: e.signature });
            if (e.kind === 'order_claimed' || e.kind === 'order_cancelled') Object.assign(cur, { settledAt: e.time, settledTx: e.signature });
            byOrder.set(order, cur);
          }
          events.set(a, byOrder);
          setState({ phase: 'working', note: `Reading event times: ${++done} of ${crosses.length}` });
        }),
      );
    }
    const network = (await fetch(`${API_URL}/v1/stats`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null))?.network ?? '';
    const rows = loaded.orders.map((o) => {
      const d = loaded.details.get(o.cross_address)!;
      const facts: CrossFacts = { state: d.state, disclosure: d.disclosure, baseMint: d.baseMint, quoteMint: d.quoteMint, priceScale: d.grid.priceScale, decimals: d.decimals, clearing: d.clearing };
      return orderRow(o, facts, events.get(o.cross_address)?.get(o.address) ?? { placedAt: null, placedTx: null, settledAt: null, settledTx: null }, network);
    });
    const url = URL.createObjectURL(new Blob([ordersCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFilename(account.address);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setState({ phase: 'done', orders: rows.length, crosses: crosses.length, missing: loaded.missing.length, truncated: loaded.truncated });
  }

  return (
    <div>
      <p className="rounded-lg border border-border bg-surface p-3 text-sm" data-testid="not-tax-advice">
        {NOT_TAX_ADVICE}
      </p>
      {!account ? (
        <p role="status" className="mt-4 text-sm text-muted">
          Connect a wallet with Connect wallet at the top right to export its orders.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className={btn} onClick={() => void run()} disabled={state.phase === 'working'} data-testid="orders-csv">
            Download my orders (CSV)
          </button>
          <p role="status" className="text-sm text-muted">
            {state.phase === 'working' ? state.note : null}
            {state.phase === 'error' ? state.message : null}
            {state.phase === 'done'
              ? state.orders === 0
                ? 'This wallet has no orders the index has seen. The file holds only the header row.'
                : `Saved ${state.orders} ${state.orders === 1 ? 'order' : 'orders'} from ${state.crosses} ${state.crosses === 1 ? 'cross' : 'crosses'}.${state.missing > 0 ? ` ${state.missing} could not be read and are left out.` : ''}${state.truncated ? ` The index serves at most ${API_ORDER_CAP} orders of a wallet, so older ones may be missing.` : ''}`
              : null}
          </p>
        </div>
      )}
    </div>
  );
}
