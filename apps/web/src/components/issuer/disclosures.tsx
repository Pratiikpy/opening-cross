'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSigner } from '@/components/cross/use-signer';
import { Chip, Fieldset, SmallButton, Text } from '@/components/issue-wizard/fields';
import { DisclosureStatus, UpdatesFeed } from '@/components/treasury/updates-feed';
import { type MessageSigner, type QaThread, publishRecord } from '@/lib/issuer-board';
import { apiRead, apiSend, crossSummary, treasuries as readTreasuries, type TreasuryRow } from '@/lib/issuer-data';
import { ownCrosses } from '@/lib/issuer-dashboard';
import { type UpdateForm, checkUpdateForm, postUpdate } from '@/lib/issuer-update';
import { ActionError, build, signSendConfirm } from '@/lib/tx';
import { duration, type UpdatesResponse } from '@/lib/treasury';
import { parseAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { ConnectPrompt } from './connect-prompt';
import { WithMessageSigner } from './message-signer';

export function Disclosures() {
  const { account } = useWallet();
  if (!account) return <ConnectPrompt what="your disclosure schedule, the updates you have posted and the questions holders asked" />;
  return (
    <WithMessageSigner account={account}>{(signMessage) => <Inner account={account} signMessage={signMessage} />}</WithMessageSigner>
  );
}

function Inner({ account, signMessage }: { account: UiWalletAccount; signMessage: MessageSigner }) {
  const wallet = account.address;
  const [treasuryRows, setTreasuryRows] = useState<TreasuryRow[] | null>(null);
  const [subjects, setSubjects] = useState<{ address: string; kind: 'cross' | 'treasury' }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [c, t] = await Promise.all([crossSummary(1000), readTreasuries()]);
      if (!live) return;
      if (!t.ok) return setError(t.error);
      const mineT = t.data.treasuries.filter((x) => x.authority === wallet);
      setTreasuryRows(mineT);
      const mineC = c.ok ? ownCrosses(c.data.crosses, wallet).slice(0, 6) : [];
      setSubjects([...mineT.map((x) => ({ address: x.address, kind: 'treasury' as const })), ...mineC.map((x) => ({ address: x.address, kind: 'cross' as const }))]);
    })();
    return () => {
      live = false;
    };
  }, [wallet]);

  if (error) return <p role="alert" className="mt-8 text-sm text-accent-text">{error}</p>;
  if (!treasuryRows || !subjects) return <p role="status" className="mt-8 text-sm text-muted">Reading your treasuries and crosses…</p>;
  return (
    <div className="mt-8 space-y-12">
      <section aria-labelledby="upd-h">
        <h2 id="upd-h" className="text-xl font-semibold tracking-tight">
          Updates
        </h2>
        {treasuryRows.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="no-treasury-for-updates">
            Disclosure updates belong to a treasury, and this wallet controls none. <Link href="/issuer/treasury/new" className="underline underline-offset-4">Create a treasury</Link> first.
          </p>
        ) : (
          <div className="mt-3 space-y-10">
            {treasuryRows.map((t) => (
              <UpdateComposer key={t.address} row={t} account={account} signMessage={signMessage} />
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="qa-h">
        <h2 id="qa-h" className="text-xl font-semibold tracking-tight">
          Questions from holders
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Anyone with a wallet can ask a question about a cross or a treasury, and only you, the creator or the authority, can answer. A question not answered within seven days shows as overdue. The seven days is this board&apos;s convention, not a rule a program enforces.
        </p>
        {subjects.length === 0 ? <p className="mt-3 text-sm text-muted">Nothing to ask about yet: this wallet has created no cross and controls no treasury.</p> : <div className="mt-4 space-y-8">{subjects.map((s) => <Thread key={s.address} subject={s.address} kind={s.kind} wallet={wallet} signMessage={signMessage} />)}</div>}
      </section>
    </div>
  );
}

function UpdateComposer({ row, account, signMessage }: { row: TreasuryRow; account: UiWalletAccount; signMessage: MessageSigner }) {
  const signTx = useSigner(account);
  const [f, setF] = useState<UpdateForm>({ title: '', summary: '', coveredFrom: '', coveredTo: '', declaredSpent: '' });
  const [updates, setUpdates] = useState<UpdatesResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const d = row.quoteDecimals ?? 6;
  const load = useCallback(async () => {
    const r = await apiRead<UpdatesResponse>(`/v1/treasuries/${row.address}/updates`);
    if (r.ok) setUpdates(r.data);
  }, [row.address]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = <K extends keyof UpdateForm>(k: K, v: string) => setF((x) => ({ ...x, [k]: v }));
  const checked = checkUpdateForm(f, row.quoteDecimals ?? null, parseAtoms, Math.floor(Date.now() / 1000));
  const err = (k: string) => (!checked.ok && f[k as keyof UpdateForm]?.trim() !== '' ? checked.errors[k] : undefined);
  const busy = status !== null;

  const publish = async () => {
    if (!checked.ok) return;
    setResult(null);
    const r = await postUpdate(
      row.address,
      account.address,
      checked.body,
      {
        prepare: (b) => apiSend(`/v1/treasuries/${row.address}/updates/prepare`, b),
        signMessage,
        memoTx: async (b) => {
          try {
            const built = await build('/v1/tx/treasury-memo', b);
            return { ok: true as const, txs: built.txs };
          } catch (e) {
            return { ok: false as const, error: e instanceof ActionError ? e.message : String(e) };
          }
        },
        send: (txs, s) => signSendConfirm(txs, signTx, s),
        submit: (t, b) => apiSend(`/v1/treasuries/${t}/updates`, b),
      },
      setStatus,
    );
    setStatus(null);
    if (r.ok) {
      setResult({ ok: true, text: `Update ${r.sequence} is published and anchored on chain.` });
      setF({ title: '', summary: '', coveredFrom: '', coveredTo: '', declaredSpent: '' });
      void load();
    } else setResult({ ok: false, text: `${r.error}${r.anchored ? ` The anchoring transaction ${r.anchored} did land on chain; publishing it again needs a new update.` : ''}` });
  };

  return (
    <div data-testid={`updates-${row.address}`}>
      <p className="font-mono text-xs text-muted">Treasury {shortAddress(row.address)}</p>
      <div className="mt-3">
        <DisclosureStatus d={row.disclosure} periodText={row.periodSecs ? duration(row.periodSecs) : 'the allowance period'} />
      </div>
      <form className="mt-6 max-w-2xl space-y-5" onSubmit={(e) => e.preventDefault()}>
        <Fieldset legend="Post an update" note="You sign it with your wallet and anchor it on chain with a second signature. Holders see what you wrote and whether the spend you declare matches what the program recorded. Updates cannot be edited or removed.">
          <Text label="Title" value={f.title} onChange={(v) => set('title', v)} error={err('title')} mono={false} />
          <div className="text-sm">
            <label className="block">
              <span className="text-muted">What happened</span>
              <textarea value={f.summary} onChange={(e) => set('summary', e.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" aria-invalid={Boolean(err('summary'))} />
            </label>
            {err('summary') ? <span className="mt-1 block text-xs text-accent-text">{err('summary')}</span> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text label="Covers from (first day, UTC)" type="date" value={f.coveredFrom} onChange={(v) => set('coveredFrom', v)} error={err('coveredFrom')} />
            <Text label="Covers to (last day, UTC)" type="date" value={f.coveredTo} onChange={(v) => set('coveredTo', v)} error={err('coveredTo')} />
          </div>
          <Text label="Quote tokens spent in that span (optional)" value={f.declaredSpent} onChange={(v) => set('declaredSpent', v)} inputMode="decimal" error={err('declaredSpent')} hint="If you give a figure, holders see it checked against what the program recorded as spent in the same span." />
        </Fieldset>
        <button type="button" disabled={!checked.ok || busy} onClick={() => void publish()} data-testid="publish-update" className="w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent disabled:opacity-50">
          {status ?? 'Sign and post the update'}
        </button>
        {result ? (
          <p role={result.ok ? 'status' : 'alert'} className={`text-sm ${result.ok ? 'text-positive' : 'text-accent-text'}`} data-testid="update-result">
            {result.text}
          </p>
        ) : null}
      </form>
      <h3 className="mt-8 font-medium">Posted updates</h3>
      {updates ? <UpdatesFeed updates={updates.updates} decimals={d} /> : <p className="mt-2 text-sm text-muted">Reading…</p>}
    </div>
  );
}

function Thread({ subject, kind, wallet, signMessage }: { subject: string; kind: 'cross' | 'treasury'; wallet: string; signMessage: MessageSigner }) {
  const [thread, setThread] = useState<QaThread | null>(null);
  const [none, setNone] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const r = await apiRead<QaThread>(`/v1/issuer/qa?subject=${subject}`);
    if (r.ok) {
      setThread(r.data);
      setNone(false);
    } else setNone(true);
  }, [subject]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = useMemo(() => thread?.questions ?? [], [thread]);
  if (none) return <p className="text-sm text-muted">{kind === 'cross' ? 'Cross' : 'Treasury'} {shortAddress(subject)}: the API does not serve questions for it (it may not be indexed yet).</p>;
  if (!thread) return <p className="text-sm text-muted">Reading questions for {shortAddress(subject)}…</p>;
  return (
    <div data-testid={`thread-${subject}`}>
      <p className="font-medium">
        {kind === 'cross' ? 'Cross' : 'Treasury'} <span className="font-mono text-xs text-muted">{shortAddress(subject)}</span>
      </p>
      {open.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No questions yet.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {open.map((q) => (
            <li key={q.id} className="rounded-lg border border-border p-4 text-sm" data-testid="question" data-state={q.state}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={q.state === 'answered' ? 'ok' : q.state === 'overdue' ? 'block' : 'warn'}>{q.state === 'answered' ? 'Answered' : q.state === 'overdue' ? 'Overdue' : 'Waiting'}</Chip>
                <span className="font-mono text-xs text-muted">asked by {shortAddress(q.signer)}</span>
              </div>
              <p className="mt-2 whitespace-pre-line">{String(q.body.text)}</p>
              {q.answer ? (
                <p className="mt-3 border-l-2 border-border-strong pl-3 text-muted">
                  <span className="text-ink">Answer: </span>
                  {String(q.answer.body.text)}
                </p>
              ) : thread.owner === wallet ? (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-muted">
                    Your answer
                    <textarea value={drafts[q.id] ?? ''} onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })} rows={3} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-ink" />
                  </label>
                  <SmallButton
                    testId="send-answer"
                    disabled={(drafts[q.id] ?? '').trim() === ''}
                    onClick={async () => {
                      const r = await publishRecord(signMessage, wallet, 'answer', { question: q.id, text: drafts[q.id] ?? '' });
                      setNote({ ...note, [q.id]: r.ok ? 'Answer published.' : r.error });
                      if (r.ok) void load();
                    }}
                  >
                    Sign and publish the answer
                  </SmallButton>
                  {note[q.id] ? <p role="status" className="text-xs text-muted">{note[q.id]}</p> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
