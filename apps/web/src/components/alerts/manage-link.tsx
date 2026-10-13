'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { confirmEmail, unsubscribe } from '@/lib/holder-alerts';

type Phase = { phase: 'ready' } | { phase: 'working' } | { phase: 'done'; text: string } | { phase: 'failed'; text: string };

/**
 * The page an email link opens. Nothing happens on load: a mail scanner that follows links must not confirm or remove a subscription,
 * so the action is a button the person presses.
 */
export function ManageLink({ action }: { action: 'confirm' | 'unsubscribe' }) {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const token = params.get('token') ?? '';
  const [state, setState] = useState<Phase>({ phase: 'ready' });
  const valid = /^[0-9a-f]{24}$/.test(id) && token.length >= 16;

  async function run() {
    setState({ phase: 'working' });
    const r = action === 'confirm' ? await confirmEmail(id, token) : await unsubscribe(id, token);
    if (r.ok) setState({ phase: 'done', text: action === 'confirm' ? 'Confirmed. You will get the alerts you chose at this address, and every email has a link to stop them.' : 'Done. This address has been removed and will get no more alerts.' });
    else if (r.status === 404) setState({ phase: 'failed', text: action === 'confirm' ? 'This link is not valid any more. Unconfirmed requests are deleted after a day; ask for a new link on the Alerts page.' : 'Nothing to remove: this address is not subscribed any more.' });
    else setState({ phase: 'failed', text: r.error });
  }

  if (!valid) {
    return (
      <p role="alert" className="mt-4 text-sm text-accent-text">
        This link is incomplete. Open it again from the email, or manage your alerts on the <Link href="/alerts" className="underline">Alerts page</Link>.
      </p>
    );
  }
  return (
    <div className="mt-4">
      <p className="text-sm text-muted">{action === 'confirm' ? 'Press the button to start receiving the alerts you asked for at this address.' : 'Press the button to remove this address. It is deleted from our server.'}</p>
      {state.phase === 'done' || state.phase === 'failed' ? (
        <p role={state.phase === 'done' ? 'status' : 'alert'} className={`mt-4 text-sm ${state.phase === 'failed' ? 'text-accent-text' : ''}`} data-testid="manage-result">
          {state.text}
        </p>
      ) : (
        <button type="button" onClick={() => void run()} disabled={state.phase === 'working'} className="mt-4 min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
          {state.phase === 'working' ? 'Working…' : action === 'confirm' ? 'Confirm' : 'Stop emails'}
        </button>
      )}
    </div>
  );
}
