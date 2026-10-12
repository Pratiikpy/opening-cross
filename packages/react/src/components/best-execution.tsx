import { type CrossDetail, type Side, formatAtoms, formatPrice, marketOf } from '@opening-cross/client';
import { useBestExecution } from '../hooks/use-best-execution.js';

export type BestExecutionProps = {
  cross: CrossDetail;
  side: Side;
  /** Base atoms, as a decimal string. Null: nothing to compare yet. */
  quantity: string | null;
  /** Your limit in on-chain price units, if any. */
  limitPrice?: string;
  className?: string;
};

type Report = { recommendation?: string; caveats?: string[]; comparison?: { crossPrice: string | null; dexPrice: string | null; crossBetterByBps: number | null; filledOnCross: string; filledOnDex: string } };

/**
 * Whether joining this cross beats the best DEX route for the same order, net of fees, per the deployment's router. Renders nothing at all
 * on a deployment without the router, rather than an error: best execution is an extra, not a requirement.
 */
export function BestExecution({ cross, side, quantity, limitPrice, className }: BestExecutionProps) {
  const state = useBestExecution(quantity ? { cross: cross.address, side, quantity, ...(limitPrice ? { limitPrice } : {}) } : null);
  const m = marketOf(cross);
  if (state.status === 'idle' || state.status === 'unavailable') return null;
  const cls = `oc-card${className ? ` ${className}` : ''}`;
  if (state.status === 'loading') return <section className={cls} aria-busy="true"><p className="oc-muted">Comparing with the best DEX route&hellip;</p></section>;
  if (state.status === 'error') return <section className={cls}><p role="status" className="oc-muted">Best execution could not be checked: {state.error.message}</p></section>;
  const r = state.report as Report;
  const c = r.comparison;
  return (
    <section className={cls} aria-label="Best execution" data-recommendation={r.recommendation}>
      <h2 className="oc-title">Best execution</h2>
      <p className="oc-strong">{r.recommendation === 'cross' ? 'This cross is the better venue for this order.' : r.recommendation === 'dex' ? 'A DEX route is the better venue for this order.' : r.recommendation === 'split' ? 'Splitting between the cross and a DEX route is best.' : 'No venue can fill this order.'}</p>
      {c ? (
        <dl className="oc-facts">
          <div className="oc-fact-row"><dt>Cross price</dt><dd>{c.crossPrice ? formatPrice(BigInt(c.crossPrice), m) : 'none'} (fills {formatAtoms(BigInt(c.filledOnCross), m.baseDecimals)})</dd></div>
          <div className="oc-fact-row"><dt>DEX price</dt><dd>{c.dexPrice ? formatPrice(BigInt(c.dexPrice), m) : 'none'} (fills {formatAtoms(BigInt(c.filledOnDex), m.baseDecimals)})</dd></div>
          {c.crossBetterByBps !== null ? <div className="oc-fact-row"><dt>Cross better by</dt><dd>{c.crossBetterByBps} bps</dd></div> : null}
        </dl>
      ) : null}
      {(r.caveats ?? []).map((cv) => (
        <p key={cv} className="oc-hint">{cv}</p>
      ))}
    </section>
  );
}
