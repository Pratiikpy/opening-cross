'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { Chip, SmallButton } from '@/components/issue-wizard/fields';
import { type MessageSigner, type QaThread, publishRecord } from '@/lib/issuer-board';
import { apiRead } from '@/lib/issuer-data';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { WithMessageSigner } from './message-signer';

const STATE = { answered: { tone: 'ok', text: 'Answered' }, overdue: { tone: 'block', text: 'Overdue' }, requested: { tone: 'warn', text: 'Waiting for an answer' } } as const;

/**
 * Questions about a cross or a treasury and the answers its owner gave, with a form to ask. Public: reading needs no wallet, asking needs
 * a wallet that can sign a message. The page can be mounted anywhere; it needs only the subject's address.
 */
export function QaThreadView({ subject }: { subject: string }) {
  const [thread, setThread] = useState<QaThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { account } = useWallet();
  const load = useCallback(async () => {
    const r = await apiRead<QaThread>(`/v1/issuer/qa?subject=${subject}`);
    if (r.ok) setThread(r.data);
    else setError(r.error);
  }, [subject]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p role="alert" className="mt-8 text-sm text-accent-text">{error}</p>;
  if (!thread) return <p role="status" className="mt-8 text-sm text-muted">Reading the questions…</p>;
  return (
    <div className="mt-8 space-y-8" data-testid="qa">
      <p className="max-w-2xl text-sm text-muted">
        Questions about this {thread.subjectKind} ({shortAddress(subject)}). Only its {thread.subjectKind === 'cross' ? 'creator' : 'authority'}, {shortAddress(thread.owner)}, can answer. A question unanswered for seven days shows as overdue; that clock is this board&apos;s convention, not a rule a program enforces. Everything here is public.
      </p>
      {thread.questions.length === 0 ? (
        <p className="text-sm text-muted" data-testid="no-questions">No one has asked yet.</p>
      ) : (
        <ul className="space-y-4">
          {thread.questions.map((q) => (
            <li key={q.id} className="rounded-lg border border-border p-4 text-sm" data-testid="question" data-state={q.state}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={STATE[q.state].tone}>{STATE[q.state].text}</Chip>
                <span className="font-mono text-xs text-muted">asked by {shortAddress(q.signer)}</span>
              </div>
              <p className="mt-2 whitespace-pre-line">{String(q.body.text)}</p>
              {q.answer ? (
                <p className="mt-3 border-l-2 border-border-strong pl-3 text-muted">
                  <span className="text-ink">Answer: </span>
                  {String(q.answer.body.text)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {account ? (
        <WithMessageSigner account={account}>{(sign) => <Ask thread={thread} account={account} sign={sign} onDone={load} />}</WithMessageSigner>
      ) : (
        <p role="status" className="text-sm text-muted" data-testid="ask-connect">
          Connect a wallet to ask a question. You sign a message; nothing is sent to the network and no funds move.
        </p>
      )}
    </div>
  );
}

function Ask({ thread, account, sign, onDone }: { thread: QaThread; account: UiWalletAccount; sign: MessageSigner; onDone: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form className="max-w-xl space-y-3" onSubmit={(e) => e.preventDefault()}>
      <label className="block text-sm">
        <span className="text-muted">Your question</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={1000} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
      </label>
      <SmallButton
        testId="ask"
        disabled={busy || text.trim() === ''}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await publishRecord(sign, account.address, 'question', { subject: thread.subject, subjectKind: thread.subjectKind, text: text.trim() });
          setBusy(false);
          setMsg(r.ok ? { ok: true, text: 'Your question is recorded and public.' } : { ok: false, text: r.error });
          if (r.ok) {
            setText('');
            await onDone();
          }
        }}
      >
        {busy ? 'Waiting for your wallet…' : 'Sign and ask'}
      </SmallButton>
      {msg ? (
        <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-positive' : 'text-accent-text'}`} data-testid="ask-result">
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}
