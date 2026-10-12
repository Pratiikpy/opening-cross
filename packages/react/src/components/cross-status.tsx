import { useId } from 'react';
import { type BookResponse, type CrossDetail, formatAtoms, formatDuration, formatPrice, marketOf, phaseOf, shortAddress } from '@opening-cross/client';
import { useClock } from '../hooks/use-clock.js';
import type { Verification } from '../hooks/use-cross.js';

export type CrossStatusProps = {
  cross: CrossDetail;
  /** The book, if you have it (`useBook`): its indicative price is shown while the cross is open. */
  book?: BookResponse | null;
  /** The result of `useCross({ verify: 'both' })`: shown as a line saying whether the API and the cluster agree. */
  verification?: Verification;
  /** Unix seconds on the cluster's clock (from `useCross`). Default: this machine's clock. */
  now?: bigint;
  className?: string;
};

const PHASE_LABEL = { upcoming: 'Not open yet', open: 'Open', reveal: 'Reveal window', 'awaiting-settlement': 'Awaiting settlement', settled: '' } as const;

const utc = (ts: string) => new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16);

const VERIFY_TEXT: Record<Verification['status'], string | null> = {
  off: null,
  verified: 'Checked against the chain: every field matches.',
  mismatch: 'The API and the chain disagree. Trust the chain.',
  inconclusive: 'The API and the chain differ only in fields that move as orders arrive; the next read settles it.',
  unavailable: 'Could not check against the chain.',
};

/** What a cross is and where it stands: state, the headline price, the countdown, orders, fees, and an optional chain check. */
export function CrossStatus({ cross, book, verification, now: nowProp, className }: CrossStatusProps) {
  const clock = useClock();
  const now = nowProp ?? clock;
  const id = useId();
  const m = marketOf(cross);
  const phase = phaseOf(cross, now);
  const label = cross.state === 'Live' ? PHASE_LABEL[phase] : cross.state === 'NoPrint' ? 'Did not print' : cross.state;
  const next = phase === 'upcoming' ? cross.window.openTs : phase === 'open' ? cross.window.closeTs : phase === 'reveal' ? cross.window.revealEndTs : null;
  const headingText = cross.clearing ? 'Clearing price' : phase === 'settled' ? 'Result' : phase === 'upcoming' || phase === 'open' ? 'Price if it closed now' : 'Price once it settles';
  const price = cross.clearing
    ? formatPrice(BigInt(cross.clearing.price), m)
    : cross.state === 'NoPrint' || cross.state === 'Finalized'
      ? 'No print'
      : book?.indicative
        ? formatPrice(BigInt(book.indicative.price), m)
        : cross.disclosure === 'sealed' && phase !== 'settled'
          ? 'Sealed'
          : 'No price yet';
  const caption = cross.clearing
    ? `${formatAtoms(BigInt(cross.clearing.matched), m.baseDecimals)} tokens traded at this one price`
    : cross.noPrintReason
      ? `Did not print (${cross.noPrintReason}); every order is refunded in full.`
      : book?.indicative
        ? `${formatAtoms(BigInt(book.indicative.matched), m.baseDecimals)} tokens would trade. ${phase === 'upcoming' || phase === 'open' ? 'Indicative until the call closes.' : 'Indicative: settling the cross fixes the final price.'}`
        : cross.disclosure === 'sealed'
          ? 'Sealed: prices stay hidden until bids are revealed.'
          : 'No crossing orders yet.';
  const verifyText = verification ? VERIFY_TEXT[verification.status] : null;

  return (
    <section className={`oc-card${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-title`} data-state={cross.state} data-phase={phase}>
      <header className="oc-status-head">
        <h2 id={`${id}-title`} className="oc-title">
          Cross <span className="oc-mono" title={cross.address}>{shortAddress(cross.address)}</span>
        </h2>
        <span className="oc-badge" data-testid="state-badge">{label}</span>
      </header>
      <p className="oc-muted">
        {cross.kind} · {cross.disclosure === 'sealed' ? 'sealed bids' : 'open book'} · base {cross.baseMint ? shortAddress(cross.baseMint) : 'minted at settlement'} · quote {shortAddress(cross.quoteMint)}
        {cross.gateMint ? ' · eligibility pass required' : ''}
      </p>
      <div className="oc-headline">
        <div>
          <p className="oc-eyebrow">{headingText}</p>
          <p className="oc-price" data-testid="price">{price}</p>
          <p className="oc-muted">{caption}</p>
        </div>
        {next ? (
          <div className="oc-countdown">
            <p className="oc-eyebrow">{phase === 'upcoming' ? 'Opens in' : phase === 'open' ? 'Closes in' : 'Reveals close in'}</p>
            {/* The countdown is a timer: it must not be announced every second. */}
            <p className="oc-mono oc-timer" data-testid="countdown" role="timer" aria-live="off">{formatDuration(BigInt(next) - now)}</p>
          </div>
        ) : null}
      </div>
      <dl className="oc-grid-facts">
        <div><dt>Orders</dt><dd>{cross.orders.total}</dd></div>
        <div><dt>Open orders</dt><dd>{cross.orders.open}</dd></div>
        <div><dt>Seller fee</dt><dd>{(cross.fees.protocolBps + cross.fees.integratorBps) / 100}%</dd></div>
        <div><dt>Closes (UTC)</dt><dd className="oc-mono">{utc(cross.window.closeTs)}</dd></div>
      </dl>
      {verifyText ? (
        <p className="oc-verify" data-status={verification!.status} role="status">
          {verifyText}
          {verification!.reason ? ` (${verification!.reason})` : ''}
        </p>
      ) : null}
    </section>
  );
}
