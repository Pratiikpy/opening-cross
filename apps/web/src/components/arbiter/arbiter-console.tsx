'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { WalletAction } from '@/components/issuer/issuer-action';
import { ProgramNotice } from '@/components/issuer/program-notice';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { type AdminRead, type ArbiterRead, type Challenge, EMPTY_RULING, EXPIRY_DAYS, STATUS_TEXT, type RulingForm, buildRuling, readAdmin, readArbiter, standingText } from '@/lib/arbiter';
import { apiRead, crossSummary } from '@/lib/issuer-data';
import { readMintFull } from '@/lib/issuer-chain';
import { fmt } from '@/lib/issuer-treasury-console';
import type { RulesRead } from '@/lib/holder-rules';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

type Item = { cross: string; challenges: Challenge[]; bondHeld: string | null; bondQuote: string | null; insiders: string[]; quoteMint: string };
const TONE = { Open: 'warn', Upheld: 'block', Rejected: 'ok', Expired: 'info' } as const;

export function ArbiterConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [arbiter, setArbiter] = useState<ArbiterRead | undefined>(undefined);
  const [admin, setAdmin] = useState<AdminRead | undefined>(undefined);
  const [items, setItems] = useState<Item[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((r) => r + 1), []);

  useEffect(() => {
    let live = true;
    void Promise.all([readArbiter(), readAdmin()]).then(([a, p]) => {
      if (!live) return;
      setArbiter(a);
      setAdmin(p);
    });
    return () => {
      live = false;
    };
  }, [rev]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const crosses = await crossSummary(1000);
      if (!live) return;
      if (!crosses.ok) {
        setScanError(crosses.error);
        return;
      }
      // Challenges are filed in the window after a clear and must be answered before finalize, so they live on cleared crosses. Finalized and
      // no-print crosses are read only when named, to see how a challenge ended.
      const addresses = [...new Set([...crosses.data.crosses.filter((c) => c.state === 'Cleared').map((c) => c.address), ...extra])];
      const rows = await Promise.all(
        addresses.slice(0, 60).map(async (cross): Promise<Item | null> => {
          const ch = await apiRead<{ challenges: Challenge[] }>(`/v1/crosses/${cross}/challenges`);
          if (!ch.ok || ch.data.challenges.length === 0) return null;
          const rules = await apiRead<RulesRead>(`/v1/crosses/${cross}/rules`);
          const row = crosses.data.crosses.find((c) => c.address === cross);
          return {
            cross,
            challenges: ch.data.challenges,
            bondHeld: rules.ok && rules.data.state ? rules.data.state.neutrality.bondHeld : null,
            bondQuote: rules.ok && rules.data.rules ? rules.data.rules.neutrality.bondQuote : null,
            insiders: rules.ok && rules.data.rules ? rules.data.rules.neutrality.insiders : [],
            quoteMint: row?.quoteMint ?? '',
          };
        }),
      );
      if (live) {
        setItems(rows.filter((r): r is Item => r !== null));
        setScanError(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [rev, extra]);

  const isArbiter = arbiter?.state === 'named' && wallet === arbiter.arbiter;
  const open = (items ?? []).flatMap((i) => i.challenges.filter((c) => c.status === 'Open').map((c) => ({ item: i, c })));
  const typedOk = isAddress(typed.trim());
  return (
    <div className="mt-8 space-y-6">
      <ProgramNotice which="crossCore" what="Insider challenges and the arbiter’s ruling" />
      <Section id="standing" title="Who is the arbiter?" intro="Anyone can allege that a wallet was an undeclared insider of a cross. One wallet, named by the protocol admin, weighs the evidence and rules. The program cannot tell whether two wallets are linked, so a challenge is a judgement, and this page is where it is made.">
        <p className="text-sm" data-testid="standing">
          {arbiter === undefined ? 'Reading the arbiter from the chain…' : standingText(arbiter, wallet)}
        </p>
        <Facts rows={[['Arbiter', arbiter?.state === 'named' ? arbiter.arbiter : arbiter?.state === 'none' ? 'not named yet' : 'unread'], ['Connected wallet', wallet ?? 'none'], ['Protocol admin', admin?.ok ? admin.protocol.admin : admin === undefined ? 'reading…' : 'unread']]} />
      </Section>

      <Section id="queue" title="Challenges" intro={`A challenge is open until the arbiter rules. If nobody rules for ${EXPIRY_DAYS} days, anyone can close it and the challenger’s deposit goes back, so an absent arbiter cannot hold a cross’s proceeds back for ever.`}>
        {scanError ? (
          <p role="alert" className="text-sm text-accent-text" data-testid="scan-error">
            The crosses could not be listed: {scanError}
          </p>
        ) : null}
        {items === null && !scanError ? (
          <p role="status" className="text-sm text-muted">
            Looking for challenges…
          </p>
        ) : null}
        {items !== null ? (
          <p className="text-sm text-muted" data-testid="queue-count">
            {open.length === 0 ? 'No challenge is waiting for a ruling.' : `${open.length} challenge${open.length === 1 ? ' is' : 's are'} waiting for a ruling.`} This page looks at the cleared crosses the index lists, up to 60. To see a cross that finalized, name it below.
          </p>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Look at one cross" value={typed} onChange={setTyped} error={typed.trim() !== '' && !typedOk ? 'This is not a Solana address.' : undefined} />
          <SmallButton testId="use-typed" disabled={!typedOk} onClick={() => setExtra((x) => (x.includes(typed.trim()) ? x : [...x, typed.trim()]))}>
            Look
          </SmallButton>
        </div>
        <div className="space-y-4">
          {(items ?? []).map((i) => (
            <CrossChallenges key={i.cross} item={i} isArbiter={isArbiter} wallet={wallet} arbiterNamed={arbiter?.state === 'named'} account={account ?? null} reload={reload} />
          ))}
        </div>
      </Section>

      <NameArbiter admin={admin} arbiter={arbiter} account={account ?? null} wallet={wallet} reload={reload} />
    </div>
  );
}

function CrossChallenges({ item, isArbiter, wallet, arbiterNamed, account, reload }: { item: Item; isArbiter: boolean; wallet: string | null; arbiterNamed: boolean; account: ReturnType<typeof useWallet>['account']; reload: () => void }) {
  const [decimals, setDecimals] = useState<number | null>(null);
  useEffect(() => {
    if (!item.quoteMint) return;
    let live = true;
    void readMintFull(item.quoteMint).then((m) => live && setDecimals(m.ok ? m.decimals : null));
    return () => {
      live = false;
    };
  }, [item.quoteMint]);
  return (
    <div className="rounded-lg border border-border p-4" data-testid={`cross-${item.cross}`}>
      <p className="text-sm">
        <Link href={`/crosses/${item.cross}`} className="font-mono underline underline-offset-4">
          {shortAddress(item.cross)}
        </Link>{' '}
        <span className="text-muted">
          bond posted {fmt(item.bondQuote, decimals, 'quote')}, held now {fmt(item.bondHeld, decimals, 'quote')}; {item.insiders.length} declared insider{item.insiders.length === 1 ? '' : 's'}
        </span>
      </p>
      <ul className="mt-3 space-y-3">
        {item.challenges.map((c) => (
          <li key={c.id} className="rounded-lg bg-surface p-3 text-sm" data-testid={`challenge-${item.cross}-${c.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                Challenge {c.id}: the wallet {shortAddress(c.subject)}
              </span>
              <Pill tone={TONE[c.status]}>{STATUS_TEXT[c.status]}</Pill>
            </div>
            <p className="mt-1 text-xs text-muted">
              Filed by {shortAddress(c.challenger)}. Evidence hash <span className="break-all font-mono">{c.evidence}</span>. Only the hash is on chain; the document is with the challenger.
              {c.slash && c.status === 'Upheld' ? ` Slashed ${fmt(c.slash, decimals, 'quote')}.` : ''}
            </p>
            {c.status === 'Open' ? <Ruling item={item} c={c} decimals={decimals} isArbiter={isArbiter} wallet={wallet} arbiterNamed={arbiterNamed} account={account} reload={reload} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Ruling({ item, c, decimals, isArbiter, wallet, arbiterNamed, account, reload }: { item: Item; c: Challenge; decimals: number | null; isArbiter: boolean; wallet: string | null; arbiterNamed: boolean; account: ReturnType<typeof useWallet>['account']; reload: () => void }) {
  const [f, setF] = useState<RulingForm>(EMPTY_RULING);
  const ruling = buildRuling(f, { cross: item.cross, id: c.id, arbiter: isArbiter ? wallet : null, bondHeld: item.bondHeld, quoteDecimals: decimals });
  const id = `${item.cross}-${c.id}`;
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      {isArbiter ? (
        <div className="space-y-3" data-testid={`ruling-${id}`}>
          <fieldset>
            <legend className="text-sm font-medium">Your ruling</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {(['reject', 'uphold'] as const).map((d) => (
                <label key={d} className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name={`decision-${id}`} checked={f.decision === d} onChange={() => setF({ ...f, decision: d })} className="size-5" data-testid={`decision-${d}-${id}`} />
                  {d === 'reject' ? 'Reject: the wallet was not an insider' : 'Uphold: the wallet was an undeclared insider'}
                </label>
              ))}
            </div>
          </fieldset>
          {f.decision === 'uphold' ? <Text label="Slash from the bond, in quote tokens" value={f.slash} onChange={(v) => setF({ ...f, slash: v })} inputMode="decimal" error={ruling.error ?? undefined} hint={`At most the bond held now: ${fmt(item.bondHeld, decimals, 'quote')}. It can be 0.`} /> : ruling.error ? <p className="text-xs text-accent-text">{ruling.error}</p> : null}
          {ruling.sentence ? (
            <p className="text-sm text-muted" data-testid={`ruling-sentence-${id}`}>
              {ruling.sentence}
            </p>
          ) : null}
          <WalletAction account={account} label="Sign the ruling" path="/v1/tx/resolve-challenge" needs="crossCore" what="The arbiter’s ruling" testId={`resolve-${id}`} disabled={!ruling.body} disabledReason={ruling.error ?? 'Choose a ruling.'} body={() => ruling.body} onDone={reload} />
        </div>
      ) : (
        <p className="text-xs text-muted" data-testid={`not-arbiter-${id}`}>
          {arbiterNamed ? 'Only the arbiter can rule on this.' : 'No arbiter has been named, so nobody can rule on this yet.'}
        </p>
      )}
      <div>
        <WalletAction account={account} label="Close it as unanswered" variant="secondary" path="/v1/tx/expire-challenge" needs="crossCore" what="Closing an unanswered challenge" testId={`expire-${id}`} connectHint={`Anyone can close a challenge that has waited ${EXPIRY_DAYS} days. Connect a wallet to pay the fee.`} body={() => ({ cross: item.cross, id: c.id, payer: wallet })} onDone={reload} />
        <p className="mt-1 text-xs text-muted">Allowed {EXPIRY_DAYS} days after the challenge was filed; the program refuses it earlier. The deposit goes back to the challenger.</p>
      </div>
    </div>
  );
}

function NameArbiter({ admin, arbiter, account, wallet, reload }: { admin: AdminRead | undefined; arbiter: ArbiterRead | undefined; account: ReturnType<typeof useWallet>['account']; wallet: string | null; reload: () => void }) {
  const [next, setNext] = useState('');
  const ok = isAddress(next.trim());
  const isAdmin = admin?.ok === true && wallet === admin.protocol.admin;
  return (
    <Section id="name" title="Name the arbiter" intro="Only the protocol admin can name the arbiter, and naming a new one replaces the old. This is a decision about who judges the evidence, so it is made in public, with the admin’s own wallet.">
      {!isAdmin ? (
        <p className="text-sm text-muted" data-testid="not-admin">
          {admin?.ok ? (wallet ? 'This wallet is not the protocol admin.' : 'Connect the protocol admin wallet to name the arbiter.') : 'The protocol admin could not be read just now.'}
        </p>
      ) : (
        <div className="space-y-3" data-testid="name-form">
          <Text label="Arbiter wallet" value={next} onChange={setNext} error={next.trim() !== '' && !ok ? 'This is not a Solana address.' : undefined} hint={arbiter?.state === 'named' ? `Replaces ${shortAddress(arbiter.arbiter)}.` : 'The first arbiter.'} />
          <div className="max-w-sm">
            <WalletAction account={account} label="Name the arbiter" path="/v1/tx/set-arbiter" needs="crossCore" what="Naming the arbiter" testId="set-arbiter" disabled={!ok} disabledReason="Enter the arbiter’s address." body={() => ({ admin: wallet, arbiter: next.trim() })} onDone={reload} />
          </div>
        </div>
      )}
    </Section>
  );
}
