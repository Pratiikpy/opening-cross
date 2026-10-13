'use client';

import { isAddress } from '@solana/kit';
import { useState } from 'react';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { type GrantRead, atomsOf, fmt, pctOf } from '@/lib/issuer-treasury-console';
import { duration, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { WalletAction } from './issuer-action';
import { type Ctx, Facts, NOT_AUTHORITY, Pill, Section, txPath } from './treasury-ui';

const STATUS: Record<GrantRead['status'], { tone: 'ok' | 'warn' | 'block' | 'info'; label: string; sentence: (g: GrantRead) => string }> = {
  locked: { tone: 'warn', label: 'Locked', sentence: (g) => `Nothing can be released before ${utc(g.lockupEnd)}.` },
  releasing: { tone: 'ok', label: 'Releasing', sentence: (g) => `The lockup is over. Anyone can release a milestone that is ready, until ${utc(g.expiresAt)}.` },
  expirable: { tone: 'block', label: 'Expired', sentence: (g) => `It expired at ${utc(g.expiresAt)}. Anyone can burn what was never released.` },
  expired: { tone: 'info', label: 'Burned', sentence: () => 'The unreleased part was burned.' },
};

type Row = { bps: string; attest: boolean };

/** Team grants: coins escrowed for the team that release by milestone, never before the lockup the terms fixed. */
export function TreasuryGrants({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  const [beneficiary, setBeneficiary] = useState('');
  const [total, setTotal] = useState('');
  const [lockupEnd, setLockupEnd] = useState('');
  const [expiry, setExpiry] = useState('');
  const [credential, setCredential] = useState('');
  const [schema, setSchema] = useState('');
  const [rows, setRows] = useState<Row[]>([{ bps: '100', attest: false }]);
  if (!e.extended) return null;
  const minLock = Number(e.terms.grants.minLockupSecs);
  const earliest = ctx.now + minLock;
  const lockTs = lockupEnd ? Math.floor(new Date(lockupEnd).getTime() / 1000) : null;
  const expTs = expiry ? Math.floor(new Date(expiry).getTime() / 1000) : null;
  const t = total.trim() === '' ? null : atomsOf(total, ctx.coinDecimals, 'The grant');
  const pcts = rows.map((r) => (/^\d{1,3}(\.\d{1,2})?$/.test(r.bps.trim()) ? Math.round(Number(r.bps) * 100) : null));
  const sum = pcts.reduce<number>((a, b) => a + (b ?? 0), 0);
  const errs = {
    beneficiary: beneficiary.trim() !== '' && !isAddress(beneficiary.trim()) ? 'This is not a Solana address.' : undefined,
    total: t && !t.ok ? t.error : undefined,
    lockupEnd: lockTs !== null && lockTs < earliest ? `The terms lock a grant for at least ${duration(String(minLock))}: the earliest end is ${utc(earliest)}.` : undefined,
    expiry: expTs !== null && lockTs !== null && expTs <= lockTs ? 'A grant expires after its lockup ends.' : undefined,
    credential: credential.trim() !== '' && !isAddress(credential.trim()) ? 'This is not a Solana address.' : undefined,
    schema: schema.trim() !== '' && !isAddress(schema.trim()) ? 'This is not a Solana address.' : undefined,
  };
  const ready =
    isAddress(beneficiary.trim()) && t?.ok === true && lockTs !== null && expTs !== null && !errs.lockupEnd && !errs.expiry && isAddress(credential.trim()) && isAddress(schema.trim()) && pcts.every((p) => p !== null && p > 0) && sum <= 10_000 && rows.length >= 1;
  const wallet = ctx.account?.address;
  return (
    <Section
      id="grants"
      title="Team grants"
      intro={`Coins for the team are escrowed in a grant that releases by milestone. Nothing can be released before the grant’s lockup, and a lockup is at least ${duration(String(minLock))}. A milestone can need an attestation from an attester you name. A grant that is not released by its expiry is burned, so unvested coins never sit idle. Anyone can crank a release once it is due.`}
    >
      <Facts rows={[['Grants so far', e.live.grants], ['Coins escrowed and not yet released', fmt(e.live.grantsUnreleased, ctx.coinDecimals, 'coins')]]} />
      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="grant-form">
        <p className="font-medium">Create a grant</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Text label="Beneficiary wallet" value={beneficiary} onChange={setBeneficiary} error={errs.beneficiary} />
          <Text label="Coins to escrow" value={total} onChange={setTotal} inputMode="decimal" error={errs.total} hint="Taken from the authority wallet’s coin account." />
          <Text label="Lockup ends" type="datetime-local" mono={false} value={lockupEnd} onChange={setLockupEnd} error={errs.lockupEnd} hint={`Earliest: ${utc(earliest)}.`} />
          <Text label="Expires" type="datetime-local" mono={false} value={expiry} onChange={setExpiry} error={errs.expiry} hint="What is not released by then is burned." />
          <Text label="Attester credential" value={credential} onChange={setCredential} error={errs.credential} hint="A Solana Attestation Service credential, for milestones that need an attestation." />
          <Text label="Attester schema" value={schema} onChange={setSchema} error={errs.schema} />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Milestones (up to 4)</p>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
              <Text label={`Milestone ${i + 1}: share of the grant, %`} value={r.bps} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, bps: v } : x)))} inputMode="decimal" error={pcts[i] === null ? 'A percentage with at most two decimals.' : undefined} />
              <label className="mb-1 flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-5" checked={r.attest} onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, attest: ev.target.checked } : x)))} />
                Needs an attestation
              </label>
              <button type="button" className="mb-1 min-h-11 min-w-11 px-1 py-1 text-sm text-muted underline" disabled={rows.length === 1} aria-label={`Remove milestone ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {rows.length < 4 ? (
            <SmallButton testId="add-milestone" onClick={() => setRows([...rows, { bps: '', attest: false }])}>
              Add a milestone
            </SmallButton>
          ) : null}
          <p className={`text-xs ${sum > 10_000 ? 'text-accent-text' : 'text-muted'}`} data-testid="milestone-sum">
            {sum > 10_000 ? `The milestones add up to ${pctOf(sum)}; they can add up to at most 100%.` : `The milestones release ${pctOf(sum)} of the grant${sum < 10_000 ? `; the other ${pctOf(10_000 - sum)} is never released and is burned at expiry` : ''}.`}
          </p>
        </div>
        <WalletAction
          account={ctx.account}
          label="Create the grant"
          variant="secondary"
          path={txPath(ctx.address, 'create-grant')}
          needs="treasury"
          what="Team grants"
          testId="create-grant"
          disabled={!ready || !ctx.isAuthority}
          disabledReason={!ctx.isAuthority ? NOT_AUTHORITY : 'Fill in the grant.'}
          body={() => ({
            authority: wallet,
            beneficiary: beneficiary.trim(),
            total: t && t.ok ? t.atoms : '0',
            lockupEnd: String(lockTs),
            expiryTs: String(expTs),
            milestones: rows.map((r, i) => ({ bps: pcts[i], requiresAttestation: r.attest })),
            credential: credential.trim(),
            schema: schema.trim(),
          })}
          onDone={() => ctx.reload()}
        />
      </div>
      <ul className="space-y-4" aria-label="Grants" data-testid="grants">
        {ctx.view.grants.length === 0 && ctx.view.unread.every((u) => !u.startsWith('grants')) ? <li className="text-sm text-muted">No grant has been made.</li> : null}
        {ctx.view.grants.map((g) => {
          const st = STATUS[g.status];
          return (
            <li key={g.id} className="rounded-lg border border-border p-4" data-testid={`grant-${g.id}`} data-status={g.status}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={st.tone}>{st.label}</Pill>
                <span className="font-medium">Grant #{g.id}</span>
                <span className="font-mono text-xs text-muted">to {shortAddress(g.beneficiary)}</span>
              </div>
              <p className="mt-2 text-sm text-muted">{st.sentence(g)}</p>
              <Facts rows={[['Total', fmt(g.total, ctx.coinDecimals, 'coins')], ['Released', fmt(g.released, ctx.coinDecimals, 'coins')]]} />
              <ul className="mt-3 space-y-2">
                {g.milestones.map((m) => (
                  <li key={m.index} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface p-3 text-sm">
                    <span>
                      Milestone {m.index + 1}: {pctOf(m.bps)}, {fmt(m.amount, ctx.coinDecimals, 'coins')}
                      {m.requiresAttestation ? ', needs an attestation' : ''}
                    </span>
                    {m.released ? (
                      <Pill tone="info">Released</Pill>
                    ) : (
                      <div className="w-56">
                        <WalletAction account={ctx.account} label={`Release milestone ${m.index + 1}`} variant="secondary" path={txPath(ctx.address, 'release-milestone')} needs="treasury" what="Team grants" testId={`release-${g.id}-${m.index}`} disabled={g.status === 'expired' || g.burned} body={() => ({ cranker: wallet, grant: g.address, index: m.index })} onDone={() => ctx.reload()} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {!g.burned ? (
                <div className="mt-3 max-w-xs">
                  <WalletAction account={ctx.account} label="Burn what was never released" variant="secondary" path={txPath(ctx.address, 'expire-grant')} needs="treasury" what="Team grants" testId={`expire-${g.id}`} body={() => ({ cranker: wallet, grant: g.address })} onDone={() => ctx.reload()} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
