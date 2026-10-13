'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Num, SmallButton, Text } from '@/components/issue-wizard/fields';
import type { StoredRecord } from '@/lib/issuer-board';
import { type OrderRow, ownCrosses } from '@/lib/issuer-dashboard';
import { apiRead, crossSummary } from '@/lib/issuer-data';
import { type Contact, PLAYBOOKS, buildContacts, contactsCsv, referralLink } from '@/lib/issuer-growth';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const NOTES_KEY = 'opening-bell:issuer-notes:v1';

export function Growth() {
  return (
    <div className="mt-8 space-y-12">
      <Playbooks />
      <Referrals />
      <Contacts />
      <section aria-labelledby="ir-h">
        <h2 id="ir-h" className="text-xl font-semibold tracking-tight">
          Referring other issuers
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted" data-testid="issuer-referral-gap">
          A share of the protocol fee for the issuer who brought another issuer is modelled in the fee accounting only. No program pays it, so this page offers no such link. The referral link above is different: it routes the integrator fee, which the program does pay, to the wallet you name.
        </p>
      </section>
    </div>
  );
}

function Playbooks() {
  return (
    <section aria-labelledby="pb-h">
      <h2 id="pb-h" className="text-xl font-semibold tracking-tight">
        Playbooks
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">Short sequences built from what the product does. They say what to do and in what order. They do not say what will work for your raise.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2" data-testid="playbooks">
        {PLAYBOOKS.map((p) => (
          <article key={p.id} className="rounded-[var(--radius-card)] border border-border p-5">
            <h3 className="font-medium">{p.title}</h3>
            <p className="mt-0.5 text-xs text-muted">{p.when}</p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
              {p.steps.map((s) => (
                <li key={s.text}>
                  {s.href ? (
                    <Link href={s.href} className="underline-offset-4 hover:underline">
                      {s.text}
                    </Link>
                  ) : (
                    s.text
                  )}
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </section>
  );
}

function Referrals() {
  const { account } = useWallet();
  const [wallet, setWallet] = useState('');
  const [bps, setBps] = useState(20);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (account && wallet === '') setWallet(account.address);
  }, [account, wallet]);
  const link = referralLink(typeof window !== 'undefined' ? window.location.origin : '', wallet, bps);
  return (
    <section aria-labelledby="ref-h">
      <h2 id="ref-h" className="text-xl font-semibold tracking-tight">
        Referral link
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Anyone who builds on or promotes the product can share a link that opens the wizard with their wallet named as the integrator. If the issuer keeps it, the program pays that wallet the integrator fee from the sale when the cross finalizes. The issuer sees the fee and the wallet before signing and can change or remove both, so a link is a starting point, not a hidden charge.
      </p>
      <form className="mt-4 grid max-w-2xl gap-4" onSubmit={(e) => e.preventDefault()}>
        <Text label="Wallet that earns the fee" value={wallet} onChange={setWallet} error={wallet.trim() !== '' && !link.ok ? link.error : undefined} />
        <Num label="Integrator fee, basis points (0 to 300)" value={bps} onChange={setBps} />
        {link.ok ? (
          <div data-testid="referral-link">
            <p className="break-all font-mono text-xs">{link.url}</p>
            <div className="mt-2">
              <SmallButton
                onClick={() => {
                  void navigator.clipboard?.writeText(link.url);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy the link'}
              </SmallButton>
            </div>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function Contacts() {
  const { account } = useWallet();
  return (
    <section id="contacts" aria-labelledby="ct-h" className="scroll-mt-24">
      <h2 id="ct-h" className="text-xl font-semibold tracking-tight">
        Contacts
      </h2>
      {account ? <ContactList wallet={account.address} /> : <p role="status" className="mt-3 text-sm text-muted">Connect your issuer wallet to see the wallets that bid in your crosses or soft-committed to your drafts.</p>}
    </section>
  );
}

function ContactList({ wallet }: { wallet: string }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      if (raw) setNotes((JSON.parse(raw) as Record<string, Record<string, string>>)[wallet] ?? {});
    } catch {
      // No stored notes.
    }
  }, [wallet]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const c = await crossSummary(1000);
      if (!live) return;
      if (!c.ok) return setError(c.error);
      const mine = ownCrosses(c.data.crosses, wallet).slice(0, 12);
      const orderSets = await Promise.all(
        mine.map(async (x) => {
          const r = await apiRead<{ orders: OrderRow[] }>(`/v1/crosses/${x.address}/orders`);
          return { cross: x.address, orders: r.ok ? r.data.orders : [] };
        }),
      );
      const drafts = await apiRead<{ records: StoredRecord[] }>(`/v1/issuer/records?kind=draft&signer=${wallet}&limit=50`);
      const decimals = new Map<string, number>();
      const commits: { draft: string; record: StoredRecord }[] = [];
      if (drafts.ok) {
        for (const d of drafts.data.records) {
          decimals.set(d.id, Number(d.body.quoteDecimals));
          const cs = await apiRead<{ records: StoredRecord[] }>(`/v1/issuer/records?kind=softcommit&subject=${d.id}&limit=200`);
          if (cs.ok) for (const r of cs.data.records) commits.push({ draft: d.id, record: r });
        }
      }
      if (live) setContacts(buildContacts(orderSets, commits, (d) => decimals.get(d) ?? null));
    })();
    return () => {
      live = false;
    };
  }, [wallet]);

  const save = (w: string, text: string) => {
    const next = { ...notes, [w]: text };
    if (text === '') delete next[w];
    setNotes(next);
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      const all = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
      all[wallet] = next;
      localStorage.setItem(NOTES_KEY, JSON.stringify(all));
    } catch {
      // The note stays for this visit only.
    }
  };
  const shown = useMemo(() => contacts?.slice(0, 100) ?? [], [contacts]);

  if (error) return <p role="alert" className="mt-3 text-sm text-accent-text">{error}</p>;
  if (!contacts) return <p role="status" className="mt-3 text-sm text-muted">Reading your crosses and drafts…</p>;
  return (
    <div className="mt-3">
      <p className="max-w-2xl text-sm text-muted">
        Wallets that bid in your crosses or soft-committed to your drafts. A wallet is all there is: the chain and the board hold no names, emails or locations, and nothing here infers any. Notes you add are saved in this browser only.
      </p>
      {contacts.length === 0 ? (
        <p className="mt-4 text-sm text-muted" data-testid="no-contacts">
          No wallet has bid in a cross of yours or committed to a draft yet.
        </p>
      ) : (
        <>
          <div className="mt-4">
            <SmallButton
              testId="download-contacts"
              onClick={() => {
                const blob = new Blob([contactsCsv(contacts, notes)], { type: 'text/csv' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'contacts.csv';
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Download CSV with notes
            </SmallButton>
          </div>
          <ul className="mt-4 divide-y divide-border border-y border-border text-sm" data-testid="contacts">
            {shown.map((c) => (
              <li key={c.wallet} className="grid gap-2 py-3 md:grid-cols-[160px_1fr_1fr] md:items-center">
                <span className="font-mono text-xs">{shortAddress(c.wallet)}</span>
                <span className="text-muted">
                  {c.crosses} {c.crosses === 1 ? 'cross' : 'crosses'}, filled in {c.filledCrosses}
                  {c.commits ? `, ${c.commits} soft ${c.commits === 1 ? 'commit' : 'commits'}` : ''}
                </span>
                <label className="block text-xs text-muted">
                  <span className="sr-only">Note about {shortAddress(c.wallet)}</span>
                  <input value={notes[c.wallet] ?? ''} onChange={(e) => save(c.wallet, e.target.value)} placeholder="A private note" className="min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-ink" />
                </label>
              </li>
            ))}
          </ul>
          {contacts.length > shown.length ? <p className="mt-2 text-xs text-muted">Showing the first {shown.length} of {contacts.length}; the CSV has all of them.</p> : null}
        </>
      )}
    </div>
  );
}
