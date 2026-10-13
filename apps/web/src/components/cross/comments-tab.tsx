'use client';

import { getBase58Decoder } from '@solana/kit';
import { useSignMessage } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { type Comment, MAX_BODY, bodyProblem, commentMessage, listComments, postComment, weightLabel } from '@/lib/holder-comments';
import { shortAddress } from '@/lib/units';

/**
 * Comments on this cross. Anyone can read them. Writing needs a wallet that placed an order here or holds the token, and every comment is
 * signed by the wallet that wrote it, so no one speaks for another. The most weight in the cross is listed first.
 */
export function CommentsTab({ cross, account }: { cross: string; account: UiWalletAccount | null }) {
  const [comments, setComments] = useState<Comment[] | null | 'error'>(null);
  const reload = useCallback(() => void listComments(cross).then((c) => setComments(c ?? 'error')), [cross]);
  useEffect(reload, [reload]);
  return (
    <section aria-labelledby="comments-h">
      <h2 id="comments-h" className="font-mono text-xs uppercase tracking-widest text-muted">
        Comments from holders and bidders
      </h2>
      <p className="mt-2 text-sm text-muted">
        Only a wallet that placed an order in this cross, or holds its token, can comment, and each comment is signed by its author&apos;s wallet. Comments from wallets that hold more of what the cross matched are listed first. Nothing here is advice, and a comment is not a statement by the issuer.
      </p>
      {account ? (
        account.features.includes('solana:signMessage') ? (
          <Composer cross={cross} account={account} onPosted={reload} />
        ) : (
          <p className="mt-4 text-sm text-muted">This wallet cannot sign messages, so it cannot comment.</p>
        )
      ) : (
        <p className="mt-4 text-sm text-muted">Connect a wallet to comment.</p>
      )}
      <div className="mt-6" aria-live="polite">
        {comments === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : comments === 'error' ? (
          <p role="alert" className="text-sm text-accent-text">
            Comments could not be loaded just now.
          </p>
        ) : comments.length === 0 ? (
          <p className="text-sm text-muted" data-testid="no-comments">
            No comments yet.
          </p>
        ) : (
          <ul className="divide-y divide-border border-y border-border" data-testid="comments">
            {comments.map((c) => (
              <li key={c.id} className="py-4">
                <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="font-mono" title={c.author}>
                    {shortAddress(c.author)}
                  </span>
                  <span className="rounded-full border border-border-strong px-2 py-0.5 text-xs capitalize">{c.role}</span>
                  <span className="text-xs text-muted">{weightLabel(c)}</span>
                  <time className="text-xs text-muted" dateTime={new Date(c.createdAt * 1000).toISOString()}>
                    {new Date(c.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC
                  </time>
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Composer({ cross, account, onPosted }: { cross: string; account: UiWalletAccount; onPosted: () => void }) {
  const signMessage = useSignMessage(account);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const problem = text ? bodyProblem(text) : null;

  async function post() {
    const body = text.trim();
    const p = bodyProblem(body);
    if (p) return setNote({ ok: false, text: p });
    setBusy(true);
    setNote(null);
    const signedAt = Math.floor(Date.now() / 1000);
    let signature: string;
    try {
      const out = await signMessage({ message: new TextEncoder().encode(commentMessage(cross, signedAt, body)) });
      signature = getBase58Decoder().decode(out.signature);
    } catch (e) {
      setBusy(false);
      return setNote({ ok: false, text: e instanceof Error && /reject|cancel|denied/i.test(e.message) ? 'You declined in your wallet. Nothing was posted.' : `Your wallet could not sign: ${e instanceof Error ? e.message : String(e)}` });
    }
    const r = await postComment(cross, { author: account.address, signedAt, body, signature });
    setBusy(false);
    if (r.ok) {
      setText('');
      setNote({ ok: true, text: 'Posted.' });
      onPosted();
    } else setNote({ ok: false, text: r.error });
  }

  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
    >
      <label htmlFor="comment-body" className="text-sm text-muted">
        Your comment (signing it asks your wallet for a message signature; it moves no money)
      </label>
      <textarea
        id="comment-body"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        aria-invalid={Boolean(problem)}
        aria-describedby="comment-help"
        className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-sm"
      />
      <p id="comment-help" className={`mt-1 text-xs ${problem ? 'text-accent-text' : 'text-muted'}`}>
        {problem ?? `${text.trim().length} of ${MAX_BODY} characters. No links.`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !text.trim() || Boolean(problem)} className="min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
          {busy ? 'Waiting for your wallet…' : 'Sign and post'}
        </button>
        {note ? (
          <p role={note.ok ? 'status' : 'alert'} className={`text-sm ${note.ok ? '' : 'text-accent-text'}`} data-testid="comment-note">
            {note.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
