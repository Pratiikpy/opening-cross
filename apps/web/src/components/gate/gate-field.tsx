'use client';

import { useEffect, useId, useState } from 'react';
import { API_URL } from '@/lib/api';
import { type AllowlistRoot, previewAllowlistRoot, publishAllowlist } from '@/lib/gate';
import { type GateFieldValue, type GatePresetView, type GateSummary, summarize } from '@/lib/gate-field';

const input = 'w-full rounded-lg border border-border-strong bg-bg px-3 py-2 font-mono text-xs';

/**
 * The gate choice in the issuer console: open, allowlist or attested wallet. For an allowlist the issuer pastes addresses and sees the
 * Merkle root to set on chain, and can publish the list so wallets can fetch their proofs. Controlled: the console owns `value` and
 * receives the summary (the `gateMint` to create the cross with, whether the choice is complete, what is missing).
 *
 * Mount: `<GateField value={gate} onChange={setGate} onSummary={setGateSummary} />`
 */
export function GateField({ value, onChange, onSummary }: { value: GateFieldValue; onChange: (v: GateFieldValue) => void; onSummary?: (s: GateSummary) => void }) {
  const id = useId();
  const [presets, setPresets] = useState<GatePresetView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [root, setRoot] = useState<AllowlistRoot | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [publishNote, setPublishNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/v1/gates/presets`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ presets: GatePresetView[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => live && setPresets(b.presets))
      .catch(() => live && setLoadError('The gate options could not be loaded from the API.'));
    return () => {
      live = false;
    };
  }, []);

  const preset = presets?.find((p) => p.id === value.preset);
  const wantsList = !!preset?.issuerBrings.includes('allowlist');

  // The root is computed by the API (one implementation of the tree), for the pasted list and the gate mint.
  useEffect(() => {
    if (!wantsList || !value.addresses.trim() || !value.gateMint.trim()) {
      setRoot(null);
      setRootError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void previewAllowlistRoot(value.gateMint.trim(), value.addresses).then((r) => {
        if (!live) return;
        if (r.ok) {
          setRoot(r.data);
          setRootError(null);
        } else {
          setRoot(null);
          setRootError(r.error);
        }
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [wantsList, value.addresses, value.gateMint]);

  const summary = summarize(value, preset, root?.root ?? null);
  const { complete, gateMint, allowlistRoot } = summary;
  const missingKey = summary.missing.join('|');
  useEffect(() => {
    onSummary?.({ gateMint, allowlistRoot, complete, missing: missingKey ? missingKey.split('|') : [] });
    // onSummary is the console's setter; it is stable for the lifetime of the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateMint, allowlistRoot, complete, missingKey]);

  const set = (patch: Partial<GateFieldValue>) => onChange({ ...value, ...patch });

  if (loadError) return <p role="alert" className="text-sm text-accent-text">{loadError}</p>;
  if (!presets) return <p role="status" className="text-sm text-muted">Loading gate options…</p>;

  return (
    <fieldset className="space-y-4 text-sm" data-testid="gate-field">
      <legend className="font-medium">Who may bid</legend>
      <div role="radiogroup" aria-label="Gate" className="grid gap-2 sm:grid-cols-3">
        {presets.map((p) => (
          <label key={p.id} className={`cursor-pointer rounded-[var(--radius-card)] border p-3 ${value.preset === p.id ? 'border-ink bg-surface' : 'border-border'} focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--focus)]`}>
            <input type="radio" name={`${id}-gate`} value={p.id} checked={value.preset === p.id} onChange={() => set({ preset: p.id })} className="sr-only" data-testid={`gate-option-${p.id}`} />
            <span className="block font-medium">{p.name}</span>
            <span className="mt-1 block text-xs text-muted">{p.summary}</span>
          </label>
        ))}
      </div>

      {preset?.gatedCross ? (
        <div className="space-y-3">
          <div>
            <label htmlFor={`${id}-mint`} className="block text-muted">Gate mint address</label>
            <input id={`${id}-mint`} className={input} value={value.gateMint} onChange={(e) => set({ gateMint: e.target.value })} spellCheck={false} autoComplete="off" data-testid="gate-mint-input" />
            <p className="mt-1 text-xs text-muted">The Token-2022 mint the gate is created for. The cross is created with it, and a wallet needs a pass for it to place an order.</p>
          </div>

          {wantsList ? (
            <div>
              <label htmlFor={`${id}-list`} className="block text-muted">Wallets allowed to bid</label>
              <textarea id={`${id}-list`} className={`${input} min-h-28`} value={value.addresses} onChange={(e) => set({ addresses: e.target.value })} spellCheck={false} placeholder="One address per line, or separated by commas or spaces" data-testid="gate-list-input" />
              {rootError ? (
                <p role="alert" className="mt-1 text-xs text-accent-text">{rootError}</p>
              ) : root ? (
                <div className="mt-2 space-y-1 text-xs" data-testid="gate-root" aria-live="polite">
                  <p>
                    <span className="text-muted">Merkle root </span>
                    <span className="break-all font-mono">{root.root}</span>
                  </p>
                  <p className="text-muted">
                    {root.count} wallet{root.count === 1 ? '' : 's'}
                    {root.duplicates ? `, ${root.duplicates} repeated entr${root.duplicates === 1 ? 'y' : 'ies'} counted once` : ''}
                    {root.invalidCount ? `, ${root.invalidCount} entr${root.invalidCount === 1 ? 'y is' : 'ies are'} not Solana addresses and ignored (first: ${root.invalid[0]!.entry.slice(0, 24)})` : ''}.
                  </p>
                </div>
              ) : value.addresses.trim() && !value.gateMint.trim() ? (
                <p className="mt-1 text-xs text-muted">Enter the gate mint first: the root depends on it.</p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                The chain stores only this root. Set it on the gate with <span className="font-mono">set_allowlist_root</span>, then publish the list so each wallet can fetch its proof. The API accepts a list only if it hashes to the root on chain.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={!root || publishing}
                  data-testid="gate-publish"
                  onClick={async () => {
                    setPublishing(true);
                    setPublishNote(null);
                    const r = await publishAllowlist(value.gateMint.trim(), value.addresses);
                    setPublishNote(r.ok ? { ok: true, text: `Published ${r.data.count} wallets. They can now claim passes.` } : { ok: false, text: r.error });
                    setPublishing(false);
                  }}
                  className="rounded-full border border-border-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50"
                >
                  {publishing ? 'Publishing…' : 'Publish list for wallets'}
                </button>
                {publishNote ? (
                  <p role={publishNote.ok ? 'status' : 'alert'} className={`text-xs ${publishNote.ok ? 'text-positive' : 'text-accent-text'}`}>
                    {publishNote.text}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {preset.issuerBrings.includes('sas-credential-and-schema') ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`${id}-cred`} className="block text-muted">Attestation credential</label>
                <input id={`${id}-cred`} className={input} value={value.credential} onChange={(e) => set({ credential: e.target.value })} spellCheck={false} autoComplete="off" data-testid="gate-credential-input" />
              </div>
              <div>
                <label htmlFor={`${id}-schema`} className="block text-muted">Attestation schema</label>
                <input id={`${id}-schema`} className={input} value={value.schema} onChange={(e) => set({ schema: e.target.value })} spellCheck={false} autoComplete="off" data-testid="gate-schema-input" />
              </div>
              <p className="text-xs text-muted sm:col-span-2">
                Whoever holds this credential decides what an attestation means. A wallet qualifies if it holds a live attestation under it.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {preset ? (
        <div className="rounded-[var(--radius-card)] bg-surface p-3 text-xs" data-testid="gate-summary">
          <p>
            <span className="text-muted">A bidder: </span>
            {preset.walletDoes}
          </p>
          {preset.issuerSteps.length ? (
            <p className="mt-1">
              <span className="text-muted">You, on the gate: </span>
              {preset.issuerSteps.join(', then ')}.
            </p>
          ) : null}
          <ul className="mt-2 list-disc space-y-1 pl-4 text-muted">
            {preset.limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {summary.missing.length ? <p className="mt-2 text-accent-text">Still needed: {summary.missing.join(' ')}</p> : null}
        </div>
      ) : null}
    </fieldset>
  );
}
