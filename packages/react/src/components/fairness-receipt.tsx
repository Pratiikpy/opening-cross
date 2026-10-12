import { useId } from 'react';
import { type FairnessProofView, type Market, formatAtoms, formatPrice } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useFairnessProof } from '../hooks/use-fairness-proof.js';

export type FairnessReceiptProps = {
  /** The cross's address. */
  cross: string;
  /** The cross's market (`marketOf(cross)`): with it prices and amounts read in tokens, without it they are shown as exact integers. */
  market?: Market;
  /** Pass the cross's state if you have it, so a live cross is not asked for a proof it cannot have yet. */
  state?: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  className?: string;
};

const figure = (p: FairnessProofView, market: Market | undefined, v: string | null, kind: 'price' | 'amount'): string => {
  if (v === null) return 'none';
  if (!market) return kind === 'price' ? `${v} quote atoms per ${p.params.priceScale} base atoms` : `${v} base atoms`;
  return kind === 'price' ? formatPrice(BigInt(v), market) : formatAtoms(BigInt(v), market.baseDecimals);
};

/**
 * The fairness receipt of a settled cross: a second, independent implementation of the clearing rule recomputed the result from the
 * book on chain, and either matched what the program recorded or did not. Shows both side by side, every note, a link to the proof
 * document and the command anyone can run to check it without trusting this page.
 */
export function FairnessReceipt({ cross, market, state, className }: FairnessReceiptProps) {
  const { api } = useOpeningCross();
  const id = useId();
  const enabled = state !== 'Live';
  const { status, proof, error } = useFairnessProof(cross, { enabled });
  const cls = `oc-card${className ? ` ${className}` : ''}`;
  if (!enabled) return null;
  if (status === 'loading' || status === 'idle') {
    return (
      <section className={cls} aria-busy="true">
        <p className="oc-muted">Checking the result against the chain&hellip;</p>
      </section>
    );
  }
  if (status === 'error' || !proof) {
    return (
      <section className={cls}>
        <p role="alert" className="oc-error">
          {error?.message ?? 'The fairness proof could not be read.'}
        </p>
      </section>
    );
  }
  if (proof.state === 'Live') return null;
  return (
    <section className={cls} aria-labelledby={`${id}-title`} data-verified={proof.verified} data-testid="fairness-receipt">
      <h2 id={`${id}-title`} className="oc-title">
        {proof.verified ? 'Result independently verified' : 'Result did not verify'}
      </h2>
      <p className="oc-muted">A second implementation of the clearing rule recomputed this cross from its on-chain book and {proof.verified ? 'matched' : 'did not match'} the recorded result.</p>
      <table className="oc-table">
        <caption className="oc-sr-only">Recorded on chain compared with recomputed</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="oc-sr-only">Figure</span>
            </th>
            <th scope="col">Recorded on chain</th>
            <th scope="col">Recomputed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Printed</th>
            <td>{proof.onchain.printed ? 'yes' : 'no'}</td>
            <td>{proof.recomputed.printed ? 'yes' : 'no'}</td>
          </tr>
          <tr>
            <th scope="row">Clearing price</th>
            <td className="oc-mono">{figure(proof, market, proof.onchain.price, 'price')}</td>
            <td className="oc-mono">{figure(proof, market, proof.recomputed.price, 'price')}</td>
          </tr>
          <tr>
            <th scope="row">Matched</th>
            <td className="oc-mono">{figure(proof, market, proof.onchain.matched, 'amount')}</td>
            <td className="oc-mono">{figure(proof, market, proof.recomputed.matched, 'amount')}</td>
          </tr>
          <tr>
            <th scope="row">Rationed side</th>
            <td>{proof.onchain.rationed ?? 'none'}</td>
            <td>{proof.recomputed.rationed ?? 'none'}</td>
          </tr>
        </tbody>
      </table>
      {proof.notes.map((n) => (
        <p key={n} className="oc-muted">
          {n}
        </p>
      ))}
      <p>
        <a className="oc-link" href={`${api.baseUrl}/v1/crosses/${cross}/proof`} download>
          Download the fairness proof
        </a>
      </p>
      <p className="oc-muted">
        Check it yourself without trusting this page: <code className="oc-code">opening-cross verify {cross}</code>
      </p>
    </section>
  );
}
