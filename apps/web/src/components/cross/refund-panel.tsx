'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { WalletAction } from '@/components/issuer/issuer-action';
import { API_URL } from '@/lib/api';
import { nextBatch, refundCandidates, refundSentence } from '@/lib/refunds';
import type { CrossDetail } from '@/lib/types';
import type { OrderRecord } from './order-record';

type Batch = { orders: { owner: string; nonce: string }[]; missing: number };

/** The nonce of an order is on its account, not in the index: ask the batch lookup for the ones about to be sent. */
async function nonces(batch: OrderRecord[]): Promise<Batch> {
  const res = await fetch(`${API_URL}/v1/orders?addresses=${batch.map((o) => o.address).join(',')}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The API answered HTTP ${res.status} when asked for the orders.`);
  const body = (await res.json()) as { orders: { address: string; found: boolean; open?: boolean; owner?: string; nonce?: string | number }[] };
  const orders = body.orders.filter((o) => o.found && o.open && o.owner !== undefined && o.nonce !== undefined).map((o) => ({ owner: o.owner!, nonce: String(o.nonce) }));
  return { orders, missing: batch.length - orders.length };
}

/**
 * Refunds nobody has to ask for: after a cross has settled, any wallet can send back the orders that cannot have traded, to their owners' own
 * token accounts, twelve to a transaction. The sender pays only the network fee and chooses nothing but which orders go in; the program checks
 * the destination is the owner's and refuses an order that has a fill.
 */
export function RefundPanel({ cross, orders, account, onChanged }: { cross: CrossDetail; orders: OrderRecord[] | null; account: UiWalletAccount; onChanged: () => void }) {
  const list = refundCandidates(cross, orders);
  if (cross.state === 'Live' || cross.state === 'Finalized') return null;
  const { batch, after } = nextBatch(list);
  return (
    <section aria-labelledby="refunds-h" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="refund-panel" data-count={list.length}>
      <h2 id="refunds-h" className="font-medium">
        Send refunds
      </h2>
      <p className="mt-1 text-sm text-muted" data-testid="refund-sentence">
        {orders === null ? 'Reading the orders…' : refundSentence(list.length)}
      </p>
      {list.length > 0 ? (
        <div className="mt-4 space-y-2">
          <WalletAction
            account={account}
            label={after > 0 ? `Refund the next ${batch.length} orders (${after} more after)` : `Refund ${batch.length} order${batch.length === 1 ? '' : 's'}`}
            variant="secondary"
            path="/v1/tx/push-refunds"
            testId="push-refunds"
            body={async () => {
              const n = await nonces(batch);
              return { cross: cross.address, payer: account.address, orders: n.orders };
            }}
            onDone={onChanged}
          />
          <p className="text-xs text-muted">Each order’s escrow goes to its owner’s own token account and the order closes. You pay the network fee and nothing else. An order the program finds has a fill is refused, and nothing moves.</p>
        </div>
      ) : null}
    </section>
  );
}
