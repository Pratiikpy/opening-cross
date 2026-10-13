import Link from 'next/link';
import { type Receipt, cardOf } from '@/lib/receipt';
import { explorerTx } from '@/lib/replay';
import { shortAddress } from '@/lib/units';
import { ReceiptActions } from './receipt-actions';

/** The receipt as a page: the card, what it proves and what it does not, the transactions that recorded the result, and how to check the hash. */
export function ReceiptView({ receipt, sha256, pagePath, imagePath, jsonPath, origin }: { receipt: Receipt; sha256: string; pagePath: string; imagePath: string; jsonPath: string; origin: string }) {
  const card = cardOf(receipt);
  const cluster = receipt.network === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  const ok = card.verdict.tone === 'ok';
  return (
    <div className="mx-auto max-w-[900px] px-4 py-12 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-widest text-muted">{card.title}</p>
      <h1 className="mt-2 text-[28px] font-semibold tracking-tight sm:text-[34px]">
        Cross <Link href={`/crosses/${receipt.cross}`} className="underline underline-offset-4">{shortAddress(receipt.cross)}</Link>
      </h1>

      <div className="mt-6 rounded-[var(--radius-card)] border border-border bg-inverse-bg p-6 text-inverse-ink sm:p-8" data-testid="receipt-card">
        <p className="font-mono text-xs uppercase tracking-widest text-inverse-muted">{card.headline.label}</p>
        <p className="mt-2 text-[44px] font-semibold leading-none tracking-tight sm:text-[64px]" data-testid="receipt-headline">
          {card.headline.value}
        </p>
        <p className={`mt-5 inline-flex items-center gap-2 text-base ${ok ? 'text-[#5fd08f]' : 'text-[#ff7a4a]'}`} data-testid="receipt-verdict">
          <span className={`size-2.5 rounded-full ${ok ? 'bg-[#5fd08f]' : 'bg-[#ff7a4a]'}`} aria-hidden="true" />
          {card.verdict.text}
        </p>
        <dl className="mt-5 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {card.lines.map((l) => (
            <div key={l.label} className="contents">
              <dt className="text-inverse-muted">{l.label}</dt>
              <dd className="font-mono">{l.value}</dd>
            </div>
          ))}
        </dl>
        {card.wallet ? (
          <div className="mt-5 border-t border-inverse-muted/30 pt-4" data-testid="receipt-wallet">
            <p className="text-sm text-inverse-muted">{card.wallet.heading}</p>
            <ul className="mt-2 space-y-1 text-sm">
              {card.wallet.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-6 text-xs text-inverse-muted">
          Solana {receipt.network}, not audited. Receipt hash (SHA-256) <span className="break-all font-mono">{sha256}</span>
        </p>
      </div>

      <div className="mt-5">
        <ReceiptActions pagePath={pagePath} imagePath={imagePath} jsonPath={jsonPath} />
      </div>

      <section className="mt-10" aria-labelledby="proves">
        <h2 id="proves" className="font-mono text-xs uppercase tracking-widest text-muted">What this receipt shows</h2>
        <p className="mt-3 text-sm leading-relaxed">{receipt.verification.method}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
          {receipt.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      {receipt.rules ? (
        <section className="mt-8" aria-labelledby="rules-checks" data-testid="receipt-rules">
          <h2 id="rules-checks" className="font-mono text-xs uppercase tracking-widest text-muted">Checks on this cross’s rules</h2>
          {receipt.rules.checks.length === 0 ? (
            <p className="mt-3 text-sm text-muted">The proof ran no check beyond the clearing itself.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border border-y border-border text-sm">
              {receipt.rules.checks.map((c) => (
                <li key={c.name} className="py-2.5">
                  <p className="font-medium">
                    {c.name}{' '}
                    <span className={c.ok === true ? 'text-positive' : c.ok === false ? 'text-accent-text' : 'text-muted'}>{c.ok === true ? 'reproduced' : c.ok === false ? 'did not reproduce' : 'not checked'}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{c.detail}</p>
                </li>
              ))}
            </ul>
          )}
          {receipt.rules.limits.length > 0 ? (
            <>
              <h3 className="mt-5 text-sm font-medium">What the proof does not establish</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                {receipt.rules.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="anchors">
        <h2 id="anchors" className="font-mono text-xs uppercase tracking-widest text-muted">Recorded on chain in</h2>
        {receipt.anchors.length === 0 ? (
          <p className="mt-3 text-sm text-muted">The index holds no clearing or finalize transaction for this cross.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {receipt.anchors.map((a) => (
              <li key={a.signature} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{a.event === 'CrossCleared' ? 'Clearing' : 'Finalize'}</span>
                <a className="break-all font-mono text-xs text-accent-text underline underline-offset-2" href={explorerTx(a.signature, cluster)} target="_blank" rel="noreferrer">
                  {a.signature}
                  <span className="sr-only"> (opens the Solana explorer in a new tab)</span>
                </a>
                <span className="font-mono text-xs text-muted">slot {a.slot}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="check">
        <h2 id="check" className="font-mono text-xs uppercase tracking-widest text-muted">Check it yourself</h2>
        <p className="mt-3 text-sm text-muted">
          The JSON is canonical (keys sorted, no spaces) and has no timestamp, so its hash never changes for a settled cross. Fetch it and hash it; the result must equal the hash above. To redo the recomputation itself, run{' '}
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">opening-cross-verify {receipt.cross}</code>.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-xs" tabIndex={0} aria-label="Command that hashes the receipt">{`curl -s ${origin}${jsonPath} | sha256sum`}</pre>
      </section>
    </div>
  );
}
