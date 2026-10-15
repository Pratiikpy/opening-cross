'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useEffect, useMemo, useState } from 'react';
import { useMint } from '@/lib/use-read';
import type { GateState } from '../_lib/chain';
import { type AdminForm, EMPTY_FORM, buildAdminRules, formFromPreset, formFromRules } from '../_lib/form';
import {
  PRESET_IDS,
  type PresetId,
  detectHookListVersion,
  findExtraMetasPda,
  initRules,
  preset as presetOf,
  setRules,
  updateHookMetas,
} from '../_lib/gate-client';
import { readAccounts } from '../_lib/rpc';
import { walletSigner } from '../_lib/unsigned';
import { Notice } from './notice';
import { Field, RunButton } from './run-button';

const PRESET_NAMES: Record<PresetId, string> = {
  'reg-d-506c': 'Regulation D, Rule 506(c): accredited investors',
  'reg-s': 'Regulation S: non-US persons',
  'reg-cf': 'Regulation Crowdfunding',
  mica: 'MiCA: EU and EEA residents',
  vara: 'VARA: United Arab Emirates',
  open: 'Open, screened',
};

const selectCls = 'mt-1 w-full rounded-[var(--radius-card)] border border-border-strong bg-bg px-3 py-2 text-sm';

/** The gate authority's rules form. Presets fill it in; counsel's exclusion list and every number are the issuer's to set. */
export function RulesForm({ gate, account, onChanged }: { gate: GateState; account: UiWalletAccount; onChanged: () => void }) {
  const { info: token } = useMint(gate.mint);
  const [quoteDecimals, setQuoteDecimals] = useState('6');
  const decimals = useMemo(() => ({ quote: /^\d{1,2}$/.test(quoteDecimals) ? Number(quoteDecimals) : 6, token: token ? token.decimals : null }), [quoteDecimals, token]);
  const [presetId, setPresetId] = useState<PresetId | 'current'>(gate.rules ? 'current' : 'reg-s');
  const [restricted, setRestricted] = useState('');
  const [form, setForm] = useState<AdminForm>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);

  // The form follows the chosen starting point until the issuer edits it.
  useEffect(() => {
    if (dirty) return;
    if (presetId === 'current' && gate.rules) setForm(formFromRules(gate.rules, decimals));
    else if (presetId !== 'current') setForm(formFromPreset(presetId, restricted.split(/[\s,;]+/).filter(Boolean), decimals.quote));
  }, [presetId, restricted, gate.rules, decimals, dirty]);

  const set = <K extends keyof AdminForm>(k: K, v: AdminForm[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const chosen = presetId === 'current' ? null : presetOf(presetId, { restrictedCountries: [] });
  const built = buildAdminRules(form, decimals);

  return (
    <section aria-labelledby="rules-form" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="rules-form">
      <h2 id="rules-form" className="font-mono text-xs uppercase tracking-widest text-muted">
        Issuer: gate rules
      </h2>
      <p className="mt-2 text-muted">
        {gate.rules
          ? 'This gate has compliance rules. Replacing them takes effect at once: wallets that no longer qualify cannot receive the token, and anyone can close their passes.'
          : 'Switching rules on closes the original grant paths (allowlist, attestation, direct grant) and issues passes only through the rules. Only the gate authority\'s signature is accepted on chain.'}
      </p>

      <label className="mt-4 block text-xs text-muted" htmlFor="preset">
        Starting point
      </label>
      <select
        id="preset"
        value={presetId}
        onChange={(e) => {
          setDirty(false);
          setPresetId(e.target.value as PresetId | 'current');
        }}
        className={selectCls}
        data-testid="preset"
      >
        {gate.rules ? <option value="current">The rules as they are now</option> : null}
        {PRESET_IDS.map((id) => (
          <option key={id} value={id}>
            {PRESET_NAMES[id]}
          </option>
        ))}
      </select>
      {chosen ? (
        <div className="mt-3 space-y-2" data-testid="preset-notes">
          <p className="text-muted">{chosen.summary}</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
            {chosen.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {chosen.sources.length ? <p className="text-xs text-muted">Sources: {chosen.sources.join('; ')}.</p> : null}
          <Notice tone="warn" title="A template, not legal advice">
            Counsel must approve the rules for the actual offering before it takes public money. The templates ship no list of excluded jurisdictions: counsel supplies it.
          </Notice>
          <Field id="restricted" label="Jurisdictions counsel excludes (ISO codes, comma separated)" value={restricted} onChange={(v) => { setDirty(false); setRestricted(v); }} placeholder="e.g. KP, IR" />
        </div>
      ) : null}

      <fieldset className="mt-5 grid gap-3 sm:grid-cols-2">
        <legend className="font-mono text-xs uppercase tracking-widest text-muted">Who</legend>
        <div>
          <label className="block text-xs text-muted" htmlFor="countryPolicy">
            Country rule
          </label>
          <select id="countryPolicy" value={form.countryPolicy} onChange={(e) => set('countryPolicy', e.target.value as AdminForm['countryPolicy'])} className={selectCls} data-testid="countryPolicy">
            <option value="off">No country rule</option>
            <option value="allow">Only these countries</option>
            <option value="deny">Not these countries</option>
          </select>
        </div>
        <Field id="countries" label="Countries (ISO codes)" value={form.countries} onChange={(v) => set('countries', v)} placeholder="e.g. IN, GB" />
        <div>
          <label className="block text-xs text-muted" htmlFor="minTier">
            Minimum investor tier
          </label>
          <select id="minTier" value={form.minTier} onChange={(e) => set('minTier', e.target.value as AdminForm['minTier'])} className={selectCls} data-testid="minTier">
            <option value="0">Any</option>
            <option value="1">Retail or above</option>
            <option value="2">Accredited or above</option>
            <option value="3">Qualified</option>
          </select>
        </div>
        <div className="space-y-1 pt-5">
          {([['kyc', 'Identity (KYC) verified'], ['sanctions', 'Sanctions screened'], ['accredited', 'Accredited investor'], ['oneIdentity', 'One wallet per verified person']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={form[k]} onChange={(e) => set(k, e.target.checked)} data-testid={k} />
              {label}
            </label>
          ))}
        </div>
        <Field id="maxPasses" label="Investor cap (holders)" value={form.maxPasses} onChange={(v) => set('maxPasses', v)} placeholder="none" />
        <Field id="defaultCap" label="Per-person limit per cross (whole quote tokens)" value={form.defaultCap} onChange={(v) => set('defaultCap', v)} placeholder="none" />
        <Field id="quoteDecimals" label="Quote token decimals" value={quoteDecimals} onChange={setQuoteDecimals} hint="6 for USDC" />
      </fieldset>

      <fieldset className="mt-5 grid gap-3 sm:grid-cols-2">
        <legend className="font-mono text-xs uppercase tracking-widest text-muted">Attesters and passes</legend>
        <Field id="identityCredential" label="Identity attester: SAS credential" value={form.identityCredential} onChange={(v) => set('identityCredential', v)} mono />
        <Field id="identitySchema" label="Identity attester: oc-identity schema" value={form.identitySchema} onChange={(v) => set('identitySchema', v)} mono />
        <Field id="accreditationCredential" label="Accreditation attester: SAS credential (optional)" value={form.accreditationCredential} onChange={(v) => set('accreditationCredential', v)} mono />
        <Field id="accreditationSchema" label="Accreditation attester: oc-accreditation schema" value={form.accreditationSchema} onChange={(v) => set('accreditationSchema', v)} mono />
        <Field id="allowlistRoot" label="Terms allowlist root (optional)" value={form.allowlistRoot} onChange={(v) => set('allowlistRoot', v)} mono />
        <Field id="issuanceStart" label="Passes claimable from (UTC date)" value={form.issuanceStart} onChange={(v) => set('issuanceStart', v)} placeholder="yyyy-mm-dd" />
        <Field id="issuanceEnd" label="Passes claimable until (UTC date)" value={form.issuanceEnd} onChange={(v) => set('issuanceEnd', v)} placeholder="yyyy-mm-dd" />
        {gate.rules ? null : <Field id="preexistingPasses" label="Passes already issued before the rules" value={form.preexistingPasses} onChange={(v) => set('preexistingPasses', v)} hint="Counted against the investor cap." />}
      </fieldset>

      <fieldset className="mt-5 grid gap-3 sm:grid-cols-2">
        <legend className="font-mono text-xs uppercase tracking-widest text-muted">After the sale</legend>
        <Field id="lockDays" label="Resale lock (days)" value={form.lockDays} onChange={(v) => set('lockDays', v)} placeholder="none" />
        <Field id="lockDelegate" label="Lock keeper (applies the lock after each cross)" value={form.lockDelegate} onChange={(v) => set('lockDelegate', v)} mono />
        <Field id="affiliateWindowDays" label="Insider volume window (days)" value={form.affiliateWindowDays} onChange={(v) => set('affiliateWindowDays', v)} placeholder="none" />
        <Field id="affiliateMax" label="Insider volume limit per window (whole tokens)" value={form.affiliateMax} onChange={(v) => set('affiliateMax', v)} placeholder="none" hint={token ? `${token.decimals} decimals` : 'Reading the token…'} />
        <div className="sm:col-span-2">
          <p className="text-xs text-muted">Insider blackouts: insiders cannot move tokens from the first date until trading resumes on the second (UTC). Up to four.</p>
          {form.blackouts.map((w, i) => (
            <div key={i} className="mt-2 grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field id={`blackoutStart${i}`} label="Starts" value={w.start} onChange={(v) => set('blackouts', form.blackouts.map((x, j) => (j === i ? { ...x, start: v } : x)))} placeholder="yyyy-mm-dd" />
              <Field id={`blackoutResumes${i}`} label="Trading resumes" value={w.resumes} onChange={(v) => set('blackouts', form.blackouts.map((x, j) => (j === i ? { ...x, resumes: v } : x)))} placeholder="yyyy-mm-dd" />
              <button type="button" onClick={() => set('blackouts', form.blackouts.filter((_, j) => j !== i))} className="rounded-full border border-border-strong px-4 py-2 text-xs" aria-label={`Remove blackout ${i + 1}`}>
                Remove
              </button>
            </div>
          ))}
          {form.blackouts.length < 4 ? (
            <button type="button" onClick={() => set('blackouts', [...form.blackouts, { start: '', resumes: '' }])} className="mt-2 rounded-full border border-border-strong px-4 py-2 text-xs" data-testid="add-blackout">
              Add a blackout
            </button>
          ) : null}
        </div>
      </fieldset>

      {!built.ok ? (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-accent-text" data-testid="form-problems">
          {built.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 max-w-xs">
        <RunButton
          account={account}
          label={gate.rules ? 'Replace the rules' : 'Switch on the rules'}
          testId="submit-rules"
          disabled={!built.ok}
          build={async () => {
            const b = buildAdminRules(form, decimals);
            if (!b.ok) throw new Error(b.problems.join(' '));
            const authority = walletSigner(account.address);
            const mint = gate.mint as never;
            if (gate.rules) return [await setRules({ authority, mint, rules: b.rules })];
            // A hooked mint needs its hook list rewritten in the same transaction, or transfers stop until it is.
            const [list] = await findExtraMetasPda({ mint });
            const [existing] = await readAccounts([list]);
            const needsHookUpdate = existing != null && detectHookListVersion(existing.data) === 1;
            return needsHookUpdate
              ? [await initRules({ authority, mint, rules: b.rules }), await updateHookMetas({ payer: authority, authority, mint })]
              : [await initRules({ authority, mint, rules: b.rules })];
          }}
          onDone={() => {
            setDirty(false);
            onChanged();
          }}
        />
      </div>
    </section>
  );
}
