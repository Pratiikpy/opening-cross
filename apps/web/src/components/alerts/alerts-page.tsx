'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  type Channel,
  type FeedItem,
  TOPICS,
  TOPIC_LABEL,
  type Topic,
  type Watch,
  ageText,
  allWatched,
  isMovementKind,
  toggleTopic,
  createPushSubscription,
  dropPushSubscription,
  pushSupport,
  relativeTime,
  startTelegram,
  subscribeEmail,
  subscribePush,
  subscriptionStatus,
  unsubscribe,
  updateSubscription,
} from '@/lib/holder-alerts';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { MovementSection } from './movement-section';
import { useAlertConfig, useFeed, useSaved, useWatchList } from './use-alerts';

const CARD = 'rounded-[var(--radius-card)] border border-border p-5';
const BUTTON = 'min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50';
const GHOST = 'min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50';

export function AlertsPage() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const { watch, follow, setWatch } = useWatchList();
  const { saved, set } = useSaved();
  const { config, error: configError } = useAlertConfig();
  // Everything the server is told: crosses and markets, then the tokens and treasuries followed for movements.
  const list = allWatched(watch);
  const { feed, error: feedError, loading } = useFeed(wallet, list);

  const topics = saved.topics;
  const managed = [saved.push, saved.telegram].filter((m): m is NonNullable<typeof m> => m !== null);
  const setTopics = useCallback(
    async (next: Topic[]) => {
      set({ ...saved, topics: next });
      await Promise.all(managed.map((m) => updateSubscription(m.id, m.token, { topics: next })));
    },
    // `managed` is derived from `saved`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, set],
  );
  /** Saves a change to the movement topics or to what is followed for them and tells the subscriptions this browser manages; returns what went wrong, if anything. */
  const changeMovement = useCallback(
    async (next: { topics?: Topic[]; watch?: Watch }): Promise<string | null> => {
      const nextTopics = next.topics ?? topics;
      const nextWatch = next.watch ?? watch;
      if (next.topics && !set({ ...saved, topics: nextTopics })) return 'This browser would not save the change, so it will be forgotten when you leave.';
      if (next.watch && !setWatch(nextWatch)) return 'This browser would not save the change, so it will be forgotten when you leave.';
      const answers = await Promise.all(managed.map((m) => updateSubscription(m.id, m.token, { topics: nextTopics, watch: allWatched(nextWatch) })));
      const failed = answers.find((a) => !a.ok);
      return failed && !failed.ok ? `Saved here, but a channel did not accept it: ${failed.error}` : null;
    },
    // `managed` is derived from `saved`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, set, setWatch, topics, watch],
  );

  return (
    <div className="mt-8 space-y-12">
      <NeedsYou items={feed?.items ?? null} asOf={feed?.asOf ?? null} wallet={wallet} following={list.length} loading={loading} error={feedError} />
      <Following watch={watch} follow={follow} />
      <MovementSection
        topics={topics}
        watch={watch}
        available={config?.available ?? null}
        thresholdPercent={config?.movementThresholdPercent ?? null}
        channels={managed.length > 0}
        onChange={changeMovement}
      />
      <section aria-labelledby="channels-h">
        <h2 id="channels-h" className="text-xl font-semibold tracking-tight">
          Where to reach you
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Nothing is sent until you set up a channel below. Each one can be turned off here at any time, and turning it off deletes the subscription from our server.
          {wallet ? ` Alerts about your orders use your connected wallet, ${shortAddress(wallet)}: its public address is stored with the subscription so the server can look up your orders, and nothing else about you is.` : ' Connect a wallet to get alerts about your own orders; without one you still get reminders for the crosses and markets you follow.'}
        </p>
        <TopicPicker topics={topics} onChange={setTopics} />
        {configError ? (
          <p role="alert" className="mt-4 text-sm text-accent-text">
            Alert channels could not be loaded: {configError}
          </p>
        ) : null}
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <PushCard config={config?.push ?? null} saved={saved.push} wallet={wallet} topics={topics} watch={list} onSaved={(m) => set({ ...saved, push: m })} />
          <EmailCard enabled={config ? config.email.enabled : null} wallet={wallet} topics={topics} watch={list} />
          <TelegramCard config={config?.telegram ?? null} saved={saved.telegram} wallet={wallet} topics={topics} watch={list} onSaved={(m) => set({ ...saved, telegram: m })} />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- needs you

function NeedsYou({ items, asOf, wallet, following, loading, error }: { items: FeedItem[] | null; asOf: number | null; wallet: string | null; following: number; loading: boolean; error: string | null }) {
  return (
    <section aria-labelledby="needs-h">
      <h2 id="needs-h" className="text-xl font-semibold tracking-tight">
        Needs you now
      </h2>
      <div className="mt-3" aria-live="polite">
        {!wallet && following === 0 ? (
          <p className={`${CARD} text-sm text-muted`}>
            Connect a wallet to see orders that can be claimed and crosses closing on your orders, or follow a cross or a market from its page to be reminded before it opens. <Link href="/crosses" className="text-accent-text underline">Browse crosses</Link>.
          </p>
        ) : loading ? (
          <p role="status" className="text-sm text-muted">
            Checking…
          </p>
        ) : error ? (
          <p role="alert" className={`${CARD} text-sm text-accent-text`}>
            Your alerts could not be read just now: {error}
          </p>
        ) : items && items.length > 0 ? (
          <ul className="space-y-3" data-testid="feed">
            {items.map((i) => (
              <li key={i.key} className={`${CARD} flex flex-wrap items-start justify-between gap-3`} data-kind={i.kind}>
                <div className="min-w-0">
                  <p className="font-medium">{i.title}</p>
                  <p className="mt-1 text-sm text-muted">{i.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm">
                  <span className="font-mono text-muted">{isMovementKind(i.kind) ? ageText(i.at, asOf ?? Math.floor(Date.now() / 1000)) : relativeTime(i.at, asOf ?? Math.floor(Date.now() / 1000))}</span>
                  <Link href={i.href} className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 hover:bg-surface">
                    {i.kind === 'claimable' ? 'Claim' : 'Open'}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`${CARD} text-sm text-muted`} data-testid="feed-empty">
            Nothing needs you right now. Orders that can be claimed, crosses about to open or close, and insider or treasury movements for what you follow, appear here.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- following

function Following({ watch, follow }: { watch: { crosses: string[]; markets: string[] }; follow: (k: 'crosses' | 'markets', a: string) => Promise<unknown> }) {
  const rows = [...watch.crosses.map((a) => ({ kind: 'crosses' as const, a })), ...watch.markets.map((a) => ({ kind: 'markets' as const, a }))];
  return (
    <section aria-labelledby="follow-h">
      <h2 id="follow-h" className="text-xl font-semibold tracking-tight">
        Following
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 max-w-2xl text-sm text-muted" data-testid="following-empty">
          You follow nothing yet. Use Follow on a cross page, in the <Link href="/calendar" className="underline underline-offset-4 hover:text-ink">calendar</Link> or on the <Link href="/live" className="underline underline-offset-4 hover:text-ink">live board</Link>. This list is kept in this browser.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border" data-testid="following">
          {rows.map(({ kind, a }) => (
            <li key={`${kind}:${a}`} className="flex items-center justify-between gap-3 py-2">
              <Link href={kind === 'crosses' ? `/crosses/${a}` : '/live'} className="min-w-0 py-2 text-sm hover:underline">
                <span className="text-muted">{kind === 'crosses' ? 'Cross' : 'Market'}</span> <span className="font-mono">{shortAddress(a)}</span>
              </Link>
              <button type="button" onClick={() => void follow(kind, a)} className={GHOST} aria-label={`Stop following ${kind === 'crosses' ? 'cross' : 'market'} ${shortAddress(a)}`}>
                Unfollow
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- topics

/** The reminder topics. The insider and treasury topics have their own section, since they come with the things to follow; both edit the one list. */
function TopicPicker({ topics, onChange }: { topics: Topic[]; onChange: (t: Topic[]) => void }) {
  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-medium">Tell me when</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {TOPICS.map((t) => {
          const on = topics.includes(t);
          return (
            <label key={t} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm has-[:checked]:border-border-strong has-[:checked]:bg-surface">
              <input
                type="checkbox"
                checked={on}
                disabled={on && topics.length === 1}
                onChange={() => onChange(toggleTopic(topics, t))}
                className="mt-0.5 size-5 shrink-0 accent-[var(--accent-fill)]"
              />
              <span>
                <span className="block font-medium">{TOPIC_LABEL[t].title}</span>
                <span className="mt-0.5 block text-xs text-muted">{TOPIC_LABEL[t].detail}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- channels

function Card({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className={`${CARD} flex flex-col`}>
      <h3 id={id} className="font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <p className="mt-3 text-sm text-muted" data-testid="channel-unavailable">
      {what} {what.endsWith('s') ? 'are' : 'is'} not switched on for this deployment yet: the server has no keys for it, so nothing could be delivered. The operator step is in <span className="font-mono text-xs">docs/CONFIGURATION.md</span>.
    </p>
  );
}

function PushCard({ config, saved, wallet, topics, watch, onSaved }: { config: { enabled: boolean; publicKey?: string } | null; saved: { id: string; token: string } | null; wallet: string | null; topics: Topic[]; watch: string[]; onSaved: (m: { id: string; token: string } | null) => boolean | void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const support = typeof window === 'undefined' ? { ok: true as const } : pushSupport({ serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined, PushManager: typeof PushManager === 'undefined' ? undefined : PushManager, Notification: typeof Notification === 'undefined' ? undefined : Notification, secure: window.isSecureContext });

  async function turnOn() {
    if (!config?.enabled || !config.publicKey) return;
    setBusy(true);
    setNote(null);
    const made = await createPushSubscription(config.publicKey);
    if (!made.ok) {
      setNote(made.reason);
      setBusy(false);
      return;
    }
    const r = await subscribePush(made.subscription, wallet, topics, watch);
    if (!r.ok) {
      setNote(`The server did not accept the subscription: ${r.error}`);
    } else {
      onSaved({ id: r.data.id, token: r.data.token });
      setNote('Notifications are on for this browser.');
    }
    setBusy(false);
  }
  async function turnOff() {
    if (!saved) return;
    setBusy(true);
    const r = await unsubscribe(saved.id, saved.token);
    await dropPushSubscription();
    // A subscription the server no longer knows is gone either way.
    if (r.ok || r.status === 404) {
      onSaved(null);
      setNote('Notifications are off and the subscription is deleted.');
    } else setNote(`Could not turn off: ${r.error}`);
    setBusy(false);
  }

  return (
    <Card title="Browser notifications" id="push-h">
      {config === null ? (
        <p className="mt-3 text-sm text-muted">Checking…</p>
      ) : !config.enabled ? (
        <Unavailable what="Browser notifications" />
      ) : !support.ok ? (
        <p className="mt-3 text-sm text-muted">{support.reason}</p>
      ) : (
        <>
          <p className="mt-3 text-sm text-muted">A notification from this browser, even when no Opening Bell tab is open. {saved ? 'On for this browser.' : 'Off.'}</p>
          <div className="mt-auto pt-4">
            {saved ? (
              <button type="button" onClick={() => void turnOff()} disabled={busy} className={GHOST}>
                {busy ? 'Working…' : 'Turn off'}
              </button>
            ) : (
              <button type="button" onClick={() => void turnOn()} disabled={busy} className={BUTTON}>
                {busy ? 'Working…' : 'Turn on notifications'}
              </button>
            )}
          </div>
        </>
      )}
      {note ? (
        <p role="status" className="mt-3 text-sm" data-testid="push-note">
          {note}
        </p>
      ) : null}
    </Card>
  );
}

function EmailCard({ enabled, wallet, topics, watch }: { enabled: boolean | null; wallet: string | null; topics: Topic[]; watch: string[] }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const r = await subscribeEmail(email, wallet, topics, watch);
    setNote(r.ok ? { ok: true, text: r.data.message } : { ok: false, text: r.error });
    setBusy(false);
  }
  return (
    <Card title="Email" id="email-h">
      {enabled === null ? (
        <p className="mt-3 text-sm text-muted">Checking…</p>
      ) : !enabled ? (
        <Unavailable what="Email alerts" />
      ) : (
        <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-1 flex-col">
          <p className="text-sm text-muted">We send a link to confirm the address and nothing else until you open it. Every email has a link to stop them.</p>
          <label htmlFor={id} className="mt-3 text-sm text-muted">
            Email address
          </label>
          <input id={id} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
          <div className="mt-auto pt-4">
            <button type="submit" disabled={busy || !email} className={BUTTON}>
              {busy ? 'Sending…' : 'Send confirmation link'}
            </button>
          </div>
        </form>
      )}
      {note ? (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-3 text-sm ${note.ok ? '' : 'text-accent-text'}`} data-testid="email-note">
          {note.text}
        </p>
      ) : null}
    </Card>
  );
}

function TelegramCard({ config, saved, wallet, topics, watch, onSaved }: { config: { enabled: boolean; bot?: string } | null; saved: { id: string; token: string } | null; wallet: string | null; topics: Topic[]; watch: string[]; onSaved: (m: { id: string; token: string } | null) => boolean | void }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: string; token: string; link: string } | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // A saved subscription is checked with the server, since it only becomes active once the chat has sent the code.
  useEffect(() => {
    if (!saved) {
      setLinked(null);
      return;
    }
    let live = true;
    void subscriptionStatus(saved.id, saved.token).then((r) => {
      if (!live) return;
      if (r.ok) setLinked(r.data.confirmed);
      else if (r.status === 404) {
        onSaved(null);
        setLinked(null);
      }
    });
    return () => {
      live = false;
    };
    // `onSaved` changes with every render of the parent; only the saved subscription matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  async function begin() {
    setBusy(true);
    setNote(null);
    const r = await startTelegram(wallet, topics, watch);
    setBusy(false);
    if (!r.ok) {
      setNote(r.error);
      return;
    }
    const p = { id: r.data.id, token: r.data.token, link: r.data.link };
    setPending(p);
    onSaved({ id: p.id, token: p.token });
    const until = Date.now() + r.data.expiresIn * 1000;
    timer.current = setInterval(() => {
      void subscriptionStatus(p.id, p.token).then((s) => {
        if (s.ok && s.data.confirmed) {
          if (timer.current) clearInterval(timer.current);
          setPending(null);
          setLinked(true);
          setNote('Linked. You will get alerts in that chat.');
        } else if (Date.now() > until) {
          if (timer.current) clearInterval(timer.current);
          setPending(null);
          onSaved(null);
          setNote('The link expired before the bot saw it. Start again.');
        }
      });
    }, 3000);
  }
  async function remove() {
    if (!saved) return;
    setBusy(true);
    const r = await unsubscribe(saved.id, saved.token);
    if (r.ok || r.status === 404) {
      onSaved(null);
      setPending(null);
      setLinked(null);
      setNote('Removed.');
    } else setNote(`Could not remove: ${r.error}`);
    setBusy(false);
  }

  return (
    <Card title="Telegram" id="telegram-h">
      {config === null ? (
        <p className="mt-3 text-sm text-muted">Checking…</p>
      ) : !config.enabled ? (
        <Unavailable what="Telegram alerts" />
      ) : (
        <>
          <p className="mt-3 text-sm text-muted">Alerts arrive in a private chat with the Opening Bell bot. Open the link, press Start in Telegram, and this page confirms the link. Send /stop to the bot to remove it.</p>
          <div className="mt-auto pt-4">
            {pending ? (
              <div className="space-y-2 text-sm">
                <a href={pending.link} target="_blank" rel="noreferrer" className={`${BUTTON} inline-flex items-center`}>
                  Open Telegram
                </a>
                <p role="status" className="text-muted">
                  Waiting for you to press Start in Telegram…
                </p>
              </div>
            ) : saved && linked ? (
              <button type="button" onClick={() => void remove()} disabled={busy} className={GHOST}>
                Remove this chat
              </button>
            ) : (
              <button type="button" onClick={() => void begin()} disabled={busy} className={BUTTON}>
                {busy ? 'Working…' : 'Link Telegram'}
              </button>
            )}
          </div>
        </>
      )}
      {note ? <p role="status" className="mt-3 text-sm">{note}</p> : null}
    </Card>
  );
}

export type { Channel };
