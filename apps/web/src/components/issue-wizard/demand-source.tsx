'use client';

import { useState } from 'react';
import { apiRead } from '@/lib/issuer-data';
import { type DemandMap, demandRows } from '@/lib/issuer-board';
import { type Derived, type Row } from '@/lib/issuer-wizard';
import { SmallButton, Text } from './fields';

/** Loads the soft commits on a draft listing as simulator demand: the sizing tool of A3. */
export function DemandSource({ derived, onLoad }: { derived: Derived; onLoad: (rows: Row[]) => void }) {
  const [id, setId] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setNote(null);
    const key = id.trim().replace(/^.*\/draft\//, '').replace(/[/?#].*$/, '');
    if (!/^[0-9a-f]{64}$/.test(key)) return setNote({ ok: false, text: 'A draft id is 64 characters of 0 to 9 and a to f. Paste the id or the draft’s link.' });
    setBusy(true);
    const r = await apiRead<DemandMap>(`/v1/issuer/drafts/${key}`);
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.error });
    const rows = demandRows(r.data, derived.baseDecimals, derived.quoteDecimals);
    if (typeof rows === 'string') return setNote({ ok: false, text: rows });
    if (rows.length === 0) return setNote({ ok: false, text: 'That draft has no soft commits yet.' });
    onLoad(rows);
    setNote({ ok: true, text: `Loaded ${r.data.commits.wallets} soft ${r.data.commits.wallets === 1 ? 'commit' : 'commits'} as ${rows.length} demand ${rows.length === 1 ? 'row' : 'rows'}. A soft commit is interest, not a bid: real bids will be fewer.` });
  };
  return (
    <div className="rounded-lg border border-border p-4" data-testid="demand-source">
      <p className="text-sm font-medium">Use real interest from a draft listing</p>
      <p className="text-xs text-muted">If you shared a draft and people soft-committed, load what they said as the demand.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Text label="Draft id or link" value={id} onChange={setId} />
        <SmallButton testId="load-demand" onClick={() => void load()} disabled={busy || id.trim() === ''}>
          {busy ? 'Loading…' : 'Load soft commits'}
        </SmallButton>
      </div>
      {note ? (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${note.ok ? 'text-muted' : 'text-accent-text'}`} data-testid="demand-note">
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
