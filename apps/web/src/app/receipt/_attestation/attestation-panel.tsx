import Link from 'next/link';
import { explorerTx } from '@/lib/replay';
import { shortAddress } from '@/lib/units';
import { type Check, type Verdict } from './verify';
import { type Loaded, loadAttestation } from './load';

const WORD: Record<Verdict, string> = { pass: 'Verified', fail: 'Failed', unknown: 'Not checked' };
const TONE: Record<Verdict, string> = { pass: 'text-positive', fail: 'text-accent-text', unknown: 'text-muted' };
const MARK: Record<Verdict, string> = { pass: '✓', fail: '✕', unknown: '○' };

const utc = (t: number) => `${new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

/**
 * The signature and chain anchor that stand behind a cross receipt's hash (row S2, ADR-0941), with every check repeated here from the document rather than taken from the API's word.
 * A cross that has not settled for good has none yet; the panel says so, and says what it will mean once it exists.
 */
export async function AttestationPanel({ address, owner, origin }: { address: string; owner?: string; origin: string }) {
  if (owner) {
    return (
      <Shell>
        <p className="mt-3 text-sm text-muted">
          The signature and chain anchor cover the cross’s own receipt, which lists no wallet’s orders. This page adds one wallet’s orders, which change when they are claimed, so it carries no signature of its own.{' '}
          <Link className="text-accent-text underline underline-offset-4" href={`/receipt/${address}`}>
            See the signed cross receipt
          </Link>
          .
        </p>
      </Shell>
    );
  }
  const loaded = await loadAttestation(address);
  return (
    <Shell>
      <Body loaded={loaded} address={address} origin={origin} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[900px] px-4 pb-14 sm:px-6" data-testid="attestation">
      <section aria-labelledby="signed">
        <h2 id="signed" className="font-mono text-xs uppercase tracking-widest text-muted">
          Signed and anchored
        </h2>
        {children}
      </section>
    </div>
  );
}

function Body({ loaded, address, origin }: { loaded: Loaded; address: string; origin: string }) {
  if (loaded.state === 'unavailable') {
    return (
      <p className="mt-3 text-sm text-muted" role="status" data-testid="attestation-state" data-state="unavailable">
        The signature could not be looked up just now: {loaded.reason} The receipt above is unaffected; it is bound by its hash.
      </p>
    );
  }
  if (loaded.state === 'none') {
    return (
      <div data-testid="attestation-state" data-state="none">
        <p className="mt-3 text-sm">Not signed yet.</p>
        <p className="mt-2 text-sm text-muted">
          The receipt above is bound to its content by a hash and nothing more. Some minutes after a cross has settled for good, Opening Cross signs that hash with the key it publishes and writes a batch of such hashes to the chain, which fixes the latest time they can have been made. This page then shows
          both, and repeats every check on them here.
        </p>
      </div>
    );
  }
  const { view, checks, summary } = loaded;
  const a = view.attestation;
  const cluster = view.cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  const headline = summary.failed
    ? { text: 'Do not rely on this attestation: a check failed.', tone: 'text-accent-text' }
    : summary.trusted && summary.anchored
      ? { text: 'Signed by Opening Cross and anchored on chain.', tone: 'text-positive' }
      : summary.trusted
        ? { text: 'Signed by Opening Cross. Waiting for the chain anchor.', tone: 'text-positive' }
        : { text: 'Signed, but not every check could be made.', tone: 'text-muted' };
  return (
    <div data-testid="attestation-state" data-state={summary.failed ? 'failed' : summary.trusted ? (summary.anchored ? 'anchored' : 'signed') : 'partial'}>
      <p className={`mt-3 text-base font-medium ${headline.tone}`} data-testid="attestation-headline">
        {headline.text}
      </p>
      <p className="mt-2 text-sm text-muted">
        The key {shortAddress(a.signer)} attests that the receipt of this cross has the hash <span className="break-all font-mono text-xs">{a.body.receiptSha256}</span>, after reading the cross account and finding its recorded result equal to the receipt’s. It attests the hash, not that the clearing rule was applied
        correctly: that is for anyone to recompute.
        {view.anchor?.blockTime ? ` It existed no later than ${utc(view.anchor.blockTime)}.` : ''}
        {(view.attestations ?? 1) > 1 ? ` The receipt served for this cross changed once after it was first attested, so ${view.attestations} attestations exist and this is the newest.` : ''}
      </p>

      <ul className="mt-4 divide-y divide-border border-y border-border text-sm" data-testid="attestation-checks">
        {checks.map((c) => (
          <CheckRow key={c.id} c={c} />
        ))}
      </ul>

      {view.anchor ? (
        <p className="mt-3 text-sm">
          <span className="font-medium">Anchor transaction</span>{' '}
          <a className="break-all font-mono text-xs text-accent-text underline underline-offset-2" href={explorerTx(view.anchor.signature, cluster)} target="_blank" rel="noreferrer">
            {view.anchor.signature}
            <span className="sr-only"> (opens the Solana explorer in a new tab)</span>
          </a>{' '}
          <span className="font-mono text-xs text-muted">
            {view.anchor.slot !== null ? `slot ${view.anchor.slot}, ` : ''}batch of {view.anchor.count}
          </span>
        </p>
      ) : null}

      <details className="mt-5 text-sm">
        <summary className="cursor-pointer font-medium">Check it yourself</summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted">
          <li>
            Hash the receipt and compare with the attested hash above:{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">curl -s {origin}/receipt/{address}/json | sha256sum</code>
          </li>
          <li>
            Fetch the signed document:{' '}
            <a className="text-accent-text underline underline-offset-2" href={`/receipt/${address}/attestation`}>
              /receipt/{shortAddress(address)}/attestation
            </a>{' '}
            (or the API’s <code className="font-mono text-xs">/v1/crosses/{shortAddress(address)}/receipt-attestation</code>), and check it with the library every Opening Cross signed document uses:{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">verifyDocument(attestation, signer)</code> from <code className="font-mono text-xs">@opening-cross/attest</code>, with the signer from <code className="font-mono text-xs">/v1/promises/signer</code>.
          </li>
          <li>Open the anchor transaction in an explorer and read its memo: it must be the text shown in the document, and the transaction must be signed by the same key.</li>
        </ol>
      </details>
    </div>
  );
}

function CheckRow({ c }: { c: Check }) {
  return (
    <li className="flex items-start gap-3 py-2.5" data-check={c.id} data-verdict={c.verdict}>
      <span className={`mt-0.5 w-4 shrink-0 text-center font-mono ${TONE[c.verdict]}`} aria-hidden="true">
        {MARK[c.verdict]}
      </span>
      <div>
        <p className="font-medium">
          {c.label} <span className={`text-xs font-normal ${TONE[c.verdict]}`}>{WORD[c.verdict]}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted">{c.detail}</p>
      </div>
    </li>
  );
}
