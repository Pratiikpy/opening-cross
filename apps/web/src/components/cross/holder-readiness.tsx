'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FollowButton } from '@/components/alerts/follow-button';
import { ONRAMP_CODE, ONRAMP_KEY, ONRAMP_MINT, ONRAMP_URL, fiatFromLocale, onMainnet, onrampLink, swapHandOff } from '@/lib/holder-pay';
import { hasAcknowledged } from '@/lib/risk-ack';
import { CHAIN } from '@/lib/wallet';
import { readBalances, readLamports } from '@/lib/holder-chain';
import { HOLDER_API_URL } from '@/lib/holder-api';
import type { CrossDetail } from '@/lib/types';
import { formatAtoms, shortAddress } from '@/lib/units';

/** About what an order needs in SOL: the order account's deposit (it comes back at claim or cancel) and the network fee. */
export const SOL_NEEDED = 3_000_000n;

export type SponsorInfo = { enabled: false } | { enabled: true; sponsor: string; perWalletPerDay: number; covers: string };

/** Whether this deployment sponsors orders; null while it is being asked. */
export function useSponsor(): SponsorInfo | null {
  const [s, setS] = useState<SponsorInfo | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`${HOLDER_API_URL}/v1/sponsor`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<SponsorInfo>) : { enabled: false as const }))
      .catch(() => ({ enabled: false as const }))
      .then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/** The SOL balance of the wallet; null until read or when it could not be. */
export function useLamports(owner: string, refresh = 0): bigint | null {
  const [v, setV] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    void readLamports(owner).then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, [owner, refresh]);
  return v;
}

type Item = { id: string; ok: boolean | null; title: string; detail: string };

/**
 * Be ready before the cross opens: what the wallet needs to place an order and whether it has it, each read from the chain, plus a
 * reminder. Nothing here is a gate: it says what is missing and what to do about it.
 */
export function Readiness({ cross, owner, decimals }: { cross: CrossDetail; owner: string; decimals: number }) {
  const lamports = useLamports(owner);
  const sponsor = useSponsor();
  const [quote, setQuote] = useState<bigint | null | 'unread'>(null);
  useEffect(() => {
    let live = true;
    void readBalances(owner, [cross.quoteMint]).then((m) => live && setQuote(m?.get(cross.quoteMint)?.amount ?? 'unread'));
    return () => {
      live = false;
    };
  }, [owner, cross.quoteMint]);

  const sponsored = sponsor?.enabled === true;
  const items: Item[] = [
    { id: 'wallet', ok: true, title: 'Wallet connected', detail: `Connected as ${shortAddress(owner)}. The app never holds your key.` },
    {
      id: 'sol',
      ok: lamports === null ? null : lamports >= SOL_NEEDED ? true : sponsored,
      title: 'SOL for the network fee',
      detail:
        lamports === null
          ? 'Reading your balance…'
          : lamports >= SOL_NEEDED
            ? `You hold ${formatAtoms(lamports, 9, 4)} SOL, enough for the fee and the order account's deposit (about 0.003 SOL, returned when the order is claimed or cancelled).`
            : sponsored
              ? `You hold ${formatAtoms(lamports, 9, 4)} SOL. Opening Bell can pay the network fee and the order deposit for you on this network: choose that in the order ticket.`
              : `You hold ${formatAtoms(lamports, 9, 4)} SOL and an order needs about 0.003 SOL (the deposit is returned when the order is claimed or cancelled). Add a little SOL to this wallet.`,
    },
    {
      id: 'quote',
      ok: quote === null ? null : quote === 'unread' ? null : quote > 0n,
      title: 'The token this cross is paid in',
      detail:
        quote === null
          ? 'Reading your balance…'
          : quote === 'unread'
            ? 'The balance could not be read just now.'
            : quote > 0n
              ? `You hold ${formatAtoms(quote, decimals)} of the quote token (${shortAddress(cross.quoteMint)}). A buy order locks the most it could cost; what is not used comes back at settlement.`
              : `You hold none of the quote token (${shortAddress(cross.quoteMint)}), so you cannot place a buy order. Swapping another token into it needs a market for the pair, and there is none on devnet.`,
    },
    ...(cross.gateMint ? [{ id: 'gate', ok: null, title: 'An eligibility pass', detail: 'This cross takes orders only from wallets holding a pass. The order ticket shows where your wallet stands and how to claim one.' }] : []),
    { id: 'risk', ok: hasAcknowledged(owner), title: 'The risks, read once', detail: hasAcknowledged(owner) ? 'You accepted them for this wallet on this device.' : 'You are asked once, before your first order.' },
  ];
  const ready = items.every((i) => i.ok !== false);
  return (
    <section aria-labelledby="ready-h" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="readiness">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ready-h" className="font-medium">
          Ready to order?
        </h2>
        <FollowButton kind="crosses" address={cross.address} label="this cross for a reminder" />
      </div>
      <p className="mt-1 text-sm text-muted" data-testid="readiness-summary">
        {ready ? 'Everything this wallet needs is in place.' : 'Something is missing. Each line says what.'}
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((i) => (
          <li key={i.id} className="flex gap-3 text-sm" data-ok={String(i.ok)}>
            <span aria-hidden="true" className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs ${i.ok === true ? 'border-positive text-positive' : i.ok === false ? 'border-accent text-accent-text' : 'border-border-strong text-muted'}`}>
              {i.ok === true ? '✓' : i.ok === false ? '!' : '…'}
            </span>
            <span>
              <span className="font-medium">{i.title}</span>
              <span className="sr-only">: {i.ok === true ? 'ready' : i.ok === false ? 'missing' : 'checking'}.</span>
              <span className="mt-0.5 block text-muted">{i.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {quote === 0n ? <FundingOptions cross={cross} owner={owner} /> : null}
      <p className="mt-3 text-xs text-muted">
        Reminders and alerts: <Link href="/alerts" className="underline">Alerts</Link>.
      </p>
    </section>
  );
}

/** Where to get the quote token: a card or UPI provider's own widget and a swap page, each only where it can work. */
function FundingOptions({ cross, owner }: { cross: CrossDetail; owner: string }) {
  const card = ONRAMP_URL && ONRAMP_KEY && ONRAMP_MINT === cross.quoteMint && ONRAMP_CODE && onMainnet(CHAIN) ? onrampLink({ base: ONRAMP_URL, apiKey: ONRAMP_KEY, address: owner, cryptoCurrencyCode: ONRAMP_CODE, referrerDomain: window.location.hostname, ...(fiatFromLocale(navigator.language) ? { fiatCurrency: fiatFromLocale(navigator.language)! } : {}) }) : null;
  return (
    <div className="mt-3 rounded-lg bg-surface p-3 text-sm" data-testid="funding">
      <p className="font-medium">Getting the quote token</p>
      {onMainnet(CHAIN) ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">
          {card ? (
            <li>
              <a href={card} target="_blank" rel="noreferrer" className="text-accent-text underline">Buy it with a card or bank transfer</a>, on the provider&apos;s own page. It delivers to this wallet.
            </li>
          ) : null}
          <li>
            <a href={swapHandOff(null, cross.quoteMint)} target="_blank" rel="noreferrer" className="text-accent-text underline">Swap another token for it</a> on Jupiter&apos;s page; you sign the swap there.
          </li>
        </ul>
      ) : (
        <p className="mt-1 text-muted">This is a test network. Test tokens are not sold and no market exists to swap into this one; the issuer of a test cross hands them out. Buying with a card and swapping work on the main network only.</p>
      )}
    </div>
  );
}

/** The action address of a cross for blink-aware clients, with a live preview of what the endpoint answers. */
export function ShareAsBlink({ cross, apiUrl }: { cross: string; apiUrl: string }) {
  const url = `${apiUrl}/v1/actions/crosses/${cross}`;
  const action = `solana-action:${url}`;
  const [state, setState] = useState<{ phase: 'idle' } | { phase: 'loading' } | { phase: 'ok'; title: string; disabled: boolean; note: string } | { phase: 'error'; text: string }>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);
  async function check() {
    setState({ phase: 'loading' });
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const j = (await r.json()) as { title?: string; disabled?: boolean; error?: { message: string }; message?: string };
      setState(r.ok ? { phase: 'ok', title: j.title ?? '', disabled: Boolean(j.disabled), note: j.error?.message ?? '' } : { phase: 'error', text: j.message ?? `HTTP ${r.status}` });
    } catch {
      setState({ phase: 'error', text: 'The action endpoint could not be reached.' });
    }
  }
  return (
    <section aria-labelledby="blink-h" className="rounded-[var(--radius-card)] border border-border p-5">
      <h2 id="blink-h" className="font-medium">
        Bid from a link
      </h2>
      <p className="mt-1 text-sm text-muted">This cross is also a Solana Action: a blink-aware wallet or feed can show a bid form for it and build the same order transaction the page does. Open crosses with public bids only. Devnet.</p>
      <p className="mt-3 break-all rounded-lg bg-surface p-3 font-mono text-xs" data-testid="action-url">
        {action}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(action).then(() => setCopied(true), () => setCopied(false));
          }}
          className="min-h-11 rounded-full border border-border-strong px-4 text-sm hover:bg-surface"
        >
          {copied ? 'Copied' : 'Copy the action link'}
        </button>
        <button type="button" onClick={() => void check()} disabled={state.phase === 'loading'} className="min-h-11 rounded-full border border-border-strong px-4 text-sm hover:bg-surface disabled:opacity-50">
          {state.phase === 'loading' ? 'Checking…' : 'Check what it answers'}
        </button>
      </div>
      {state.phase === 'ok' ? (
        <p role="status" className="mt-3 text-sm" data-testid="action-check">
          The endpoint answers: &ldquo;{state.title}&rdquo;{state.disabled ? `, bidding disabled: ${state.note}` : ', bidding enabled.'}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-accent-text">
          {state.text}
        </p>
      ) : null}
    </section>
  );
}
