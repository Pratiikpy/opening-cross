'use client';

import { type Draft } from '@/lib/issuer-draft';
import { type FeeSchedule } from '@/lib/issuer-data';
import { MAX_INTEGRATOR_FEE_BPS, protocolFeeBps, totalFeeBps } from '@/lib/issuer-fees';
import { Fieldset, Num, SmallButton, Text } from './fields';

/** Fees as cross_core takes them, stated before signing. The issuer is the seller, so the issuer pays them; bids, cancels and refunds never carry a fee. */
export function FeesPanel({ draft, set, fees, rev, errors, wallet, referral }: { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; fees: FeeSchedule | null; rev: number; errors: Record<string, string | undefined>; wallet: string | null; referral: boolean }) {
  const i = Number.isInteger(draft.integratorFeeBps) ? draft.integratorFeeBps : 0;
  const valid = i >= 0 && i <= MAX_INTEGRATOR_FEE_BPS;
  const protocol = fees && valid ? protocolFeeBps(fees, draft.kind, i) : null;
  const total = protocol !== null ? totalFeeBps(protocol, i) : null;
  return (
    <Fieldset legend="Fees" id="fees">
      <p className="text-sm text-muted">
        Fees are charged on the value of tokens sold and are paid from the sale, by the seller, which is you. Bidders pay exactly the clearing price. Bids, cancels and refunds never carry a fee. A cross with no integrator fee pays no fee at all.
      </p>
      {referral ? (
        <p role="status" className="rounded-lg border border-border-strong bg-surface p-3 text-sm" data-testid="referral-note">
          You came from a referral link, so the integrator fee and its recipient below are pre-filled. They are only a starting point: change or clear them before you create the cross.
        </p>
      ) : null}
      <Num key={`fee-${rev}`} label="Integrator fee, basis points (0 to 300)" value={draft.integratorFeeBps} onChange={(v) => set('integratorFeeBps', v)} error={errors.integratorFeeBps} hint="Paid to the integrator wallet below, for example the launchpad or affiliate that brought you. 100 basis points is 1%." />
      <div>
        <Text label="Integrator wallet (empty means your own wallet)" value={draft.integrator} onChange={(v) => set('integrator', v)} error={errors.integrator} />
        {wallet ? (
          <div className="mt-2">
            <SmallButton onClick={() => set('integrator', '')}>Use my own wallet</SmallButton>
          </div>
        ) : null}
      </div>
      <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-3" data-testid="fee-summary">
        <div>
          <dt className="text-muted">Protocol fee</dt>
          <dd className="font-mono">{protocol === null ? 'unavailable' : `${protocol} bps`}</dd>
        </div>
        <div>
          <dt className="text-muted">Integrator fee</dt>
          <dd className="font-mono">{valid ? `${i} bps` : 'not valid'}</dd>
        </div>
        <div>
          <dt className="text-muted">Total on tokens sold</dt>
          <dd className="font-mono">{total === null ? 'unavailable' : `${total} bps (${(total / 100).toFixed(2)}%)`}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted">
        The protocol fee is the smaller of the schedule entry for a {draft.kind} cross{fees ? ` (${fees[draft.kind]} bps, ${fees.source === 'chain' ? 'read from the chain' : 'the schedule proposed in ADR-0010: the live one could not be read'})` : ''} and a quarter of the integrator fee, so it is never more than 20% of what is charged. The fee is fixed when the cross is created.
      </p>
    </Fieldset>
  );
}
