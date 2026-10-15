'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import {
  MAX_WATCH,
  MOVEMENT_TOPICS,
  MOVEMENT_WHY_OFF,
  TOPIC_LABEL,
  type Subject,
  type Topic,
  type Watch,
  getSubject,
  isAddress,
  isWatching,
  subjectSummary,
  toggleTopic,
  toggleWatch,
} from '@/lib/holder-alerts';
import { shortAddress } from '@/lib/units';

const CARD = 'rounded-[var(--radius-card)] border border-border p-5';
const BUTTON = 'min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50';
const GHOST = 'min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50';

/**
 * Insiders and treasuries (row F5): which movement alerts to receive, and which tokens and treasuries to follow for them. An address is checked with the server first, so a person sees
 * which wallets following it covers before turning anything on.
 */
export function MovementSection({
  topics,
  watch,
  available,
  thresholdPercent,
  channels,
  onChange,
}: {
  /** Every topic selected, reminders and movements alike: one list, as the server takes it. */
  topics: Topic[];
  /** Everything followed: crosses, markets, and the tokens and treasuries followed for movements. */
  watch: Watch;
  /** The server's answer per topic; null while it has not answered. */
  available: Record<string, boolean> | null;
  thresholdPercent: number | null;
  /** Whether a push or Telegram subscription exists that a change would reach. */
  channels: boolean;
  /** Saves the new selection and tells the server's subscriptions; resolves to an error text or null. */
  onChange: (next: { topics?: Topic[]; watch?: Watch }) => Promise<string | null>;
}) {
  const inputId = useId();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply(next: { topics?: Topic[]; watch?: Watch }, done: string) {
    setBusy(true);
    const err = await onChange(next);
    setBusy(false);
    setNote(err ? { ok: false, text: err } : { ok: true, text: done });
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setNote(null);
    setSubject(null);
    const a = address.trim();
    if (!isAddress(a)) {
      setNote({ ok: false, text: 'An address is 32 to 44 base58 characters: letters and digits, with no 0, O, I or l.' });
      return;
    }
    setBusy(true);
    const r = await getSubject(a);
    setBusy(false);
    if (!r.ok) setNote({ ok: false, text: r.error });
    else setSubject(r.data);
  }

  const summary = subject ? subjectSummary(subject) : null;
  const target = subject && summary?.follow ? (summary.follow === 'treasuries' ? subject.address : (subject.tokens.find((t) => t.isToken === true)?.mint ?? null)) : null;

  return (
    <section aria-labelledby="movement-h" data-testid="movement-section">
      <h2 id="movement-h" className="text-xl font-semibold tracking-tight">
        Insiders and treasuries
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Be told when someone tied to a token you follow moves it out, or when a treasury you follow pays out. These alerts read balances and the indexed record of treasury payouts; they do not trace transactions, so a
        fall in a balance is a fact worth looking at, not proof of a sale.
        {thresholdPercent !== null ? ` An insider alert needs a fall of at least ${thresholdPercent}% of the token’s supply, and smaller falls add up until they reach it.` : ''}
      </p>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Tell me when</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {MOVEMENT_TOPICS.map((t) => {
            const on = topics.includes(t);
            const off = available !== null && available[t] === false;
            return (
              <label key={t} className={`flex min-h-11 items-start gap-3 rounded-lg border border-border p-3 text-sm has-[:checked]:border-border-strong has-[:checked]:bg-surface ${off ? 'opacity-60' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || (off && !on) || (on && topics.length === 1)}
                  onChange={() => void apply({ topics: toggleTopic(topics, t) }, on ? `Turned off: ${TOPIC_LABEL[t].title}.` : `Turned on: ${TOPIC_LABEL[t].title}.`)}
                  className="mt-0.5 size-5 shrink-0 accent-[var(--accent-fill)]"
                  data-testid={`topic-${t}`}
                />
                <span>
                  <span className="block font-medium">{TOPIC_LABEL[t].title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{off ? MOVEMENT_WHY_OFF[t] : TOPIC_LABEL[t].detail}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <form onSubmit={(e) => void check(e)} className="mt-5 max-w-2xl">
        <label htmlFor={inputId} className="text-sm font-medium">
          Follow a token or a treasury
        </label>
        <p className="mt-0.5 text-xs text-muted">Paste a token mint, a treasury or a cross address. Following a cross’s token also covers its treasury.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id={inputId}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Address"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-sm"
          />
          <button type="submit" disabled={busy || address.trim().length < 32} className={GHOST}>
            {busy ? 'Checking…' : 'Check'}
          </button>
        </div>
      </form>

      {subject && summary ? (
        <div className={`${CARD} mt-4 max-w-2xl`} data-testid="subject" data-kind={subject.kind}>
          <p className="text-sm">{summary.text}</p>
          {subject.tokens.map((t) =>
            t.insiders === null ? (
              <p key={t.mint} className="mt-3 text-sm text-muted">
                {t.note}
              </p>
            ) : t.isToken === false ? null : (
              <div key={t.mint} className="mt-3">
                <p className="text-sm font-medium">Wallets tied to token <span className="font-mono">{shortAddress(t.mint)}</span></p>
                {t.insiders.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">{t.note}</p>
                ) : (
                  <ul className="mt-2 divide-y divide-border border-y border-border text-sm" data-testid="insiders">
                    {t.insiders.map((i) => (
                      <li key={i.wallet} className="py-2">
                        <span className="font-mono">{shortAddress(i.wallet)}</span> <span className="rounded-full border border-border px-2 py-0.5 text-xs">{i.topic === 'team' ? 'declared team' : 'insider'}</span>
                        <span className="mt-0.5 block text-xs text-muted">It {i.basis}.</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          )}
          {summary.follow && target ? (
            <div className="mt-4">
              {isWatching(watch, summary.follow, target) ? (
                <p className="text-sm text-muted">You already follow this.</p>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className={BUTTON}
                  onClick={() => {
                    const next = toggleWatch(watch, summary.follow as 'tokens' | 'treasuries', target);
                    if (next === watch) setNote({ ok: false, text: `You follow as many things as alerts can hold (${MAX_WATCH}). Unfollow one first.` });
                    else void apply({ watch: next }, channels ? 'Following. Your notification channels have been told.' : 'Following in this browser. Choose a channel below to be reached when something moves.');
                  }}
                >
                  Follow
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-3 max-w-2xl text-sm ${note.ok ? '' : 'text-accent-text'}`} data-testid="movement-note">
          {note.text}
        </p>
      ) : null}

      <div className="mt-6">
        <h3 className="text-sm font-medium">Following for movements</h3>
        {watch.tokens.length + watch.treasuries.length === 0 ? (
          <p className="mt-2 max-w-2xl text-sm text-muted" data-testid="movement-empty">
            You follow no token or treasury yet. A cross you follow from its page covers its token too, once an insider or treasury alert is turned on.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-y border-border" data-testid="movement-following">
            {[...watch.tokens.map((a) => ({ kind: 'tokens' as const, a })), ...watch.treasuries.map((a) => ({ kind: 'treasuries' as const, a }))].map(({ kind, a }) => (
              <li key={`${kind}:${a}`} className="flex items-center justify-between gap-3 py-2">
                {kind === 'treasuries' ? (
                  <Link href={`/treasury/${a}`} className="min-w-0 py-2 text-sm hover:underline">
                    <span className="text-muted">Treasury</span> <span className="font-mono">{shortAddress(a)}</span>
                  </Link>
                ) : (
                  <span className="min-w-0 py-2 text-sm">
                    <span className="text-muted">Token</span> <span className="font-mono">{shortAddress(a)}</span>
                  </span>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void apply({ watch: toggleWatch(watch, kind, a) }, 'Stopped following.')}
                  className={GHOST}
                  aria-label={`Stop following ${kind === 'tokens' ? 'token' : 'treasury'} ${shortAddress(a)}`}
                >
                  Unfollow
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
