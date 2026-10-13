'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fmt, pctOf, sha256Hex } from '@/lib/issuer-treasury-console';
import { duration, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { WalletAction } from './issuer-action';
import { type Ctx, Facts, NOT_AUTHORITY, NotEnabled, Pill, Section, txPath } from './treasury-ui';

/** Disclosure requests, the IP assignment gate and the wind-down window. */
export function TreasuryDisclosure({ ctx }: { ctx: Ctx }) {
  if (!ctx.view.ext.extended) return null;
  return (
    <>
      <Disclosure ctx={ctx} />
      <Assignment ctx={ctx} />
      <WindDown ctx={ctx} />
    </>
  );
}

function Disclosure({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  const [text, setText] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (text.trim() === '') setHash(null);
    else void sha256Hex(text.trim()).then((h) => live && setHash(h));
    return () => {
      live = false;
    };
  }, [text]);
  if (!e.extended) return null;
  const d = e.terms.disclosure;
  if (!d) {
    return (
      <Section id="disclosure" title="Disclosure" intro="Holders can ask the team to account for itself.">
        <NotEnabled>This treasury was extended without a disclosure feed, and that cannot be added now.</NotEnabled>
      </Section>
    );
  }
  const l = e.live;
  const overdue = l.disclosureDeadline !== null && ctx.now > Number(l.disclosureDeadline);
  return (
    <Section
      id="disclosure"
      title="Disclosure"
      intro={`A holder with at least ${pctOf(d.requestMinBps)} of the supply can ask for a disclosure. From then the team has ${duration(d.periodSecs)} to post one, and if it does not, it cannot spend until it does. Only the hash of what you post goes on chain; the text itself you publish where holders can read it, and they can check it against the hash.`}
    >
      <div data-testid="disclosure-state">
        <Facts
          rows={[
            ['Posted so far', String(l.disclosures)],
            ['Last posted', l.lastDisclosureAt ? utc(l.lastDisclosureAt) : 'never'],
            ['A holder is asking since', l.disclosureRequestOpenSince ? utc(l.disclosureRequestOpenSince) : 'nobody is'],
            ['Spending stops after', l.disclosureDeadline ? `${utc(l.disclosureDeadline)}${overdue ? ' (passed: the team cannot spend until it posts)' : ''}` : 'no deadline is running'],
          ]}
        />
      </div>
      <div className="space-y-3 rounded-lg border border-border p-4" data-testid="disclosure-form">
        <p className="font-medium">Post a disclosure</p>
        <label className="block text-sm">
          <span className="text-muted">The disclosure, as you will publish it</span>
          <textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
        </label>
        <p className="break-all text-xs text-muted" data-testid="disclosure-hash">
          {hash ? <>SHA-256: <span className="font-mono">{hash}</span></> : 'Its SHA-256 appears here as you type. Change one letter and the hash changes.'}
        </p>
        <WalletAction
          account={ctx.account}
          label="Post this disclosure"
          variant="secondary"
          path={txPath(ctx.address, 'post-disclosure')}
          needs="treasury"
          what="The disclosure feed"
          testId="post-disclosure"
          disabled={!hash || !ctx.isAuthority}
          disabledReason={!ctx.isAuthority ? NOT_AUTHORITY : 'Write the disclosure first.'}
          body={() => ({ authority: ctx.account?.address, hash })}
          onDone={() => ctx.reload()}
        />
        <p className="text-xs text-muted">
          For a written update that holders can read and check on chain, sign one from <Link className="underline underline-offset-4" href="/issuer/disclosures">Disclosures and Q&amp;A</Link>.
        </p>
      </div>
    </Section>
  );
}

function Assignment({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (!e.extended) return null;
  const a = e.terms.assignment;
  if (!a) return null;
  const done = e.live.assigned === true;
  return (
    <Section id="assignment" title="Assignment of IP and assets" intro="Until counsel’s attestation that the company’s IP and assets are assigned has been recorded, no team outflow works: not the allowance, not an executed proposal, not a tranche. Recording it is open to anyone once the attestation exists.">
      <div className="flex flex-wrap items-center gap-3" data-testid="assignment-state">
        <Pill tone={done ? 'ok' : 'warn'}>{done ? 'Recorded' : 'Not recorded'}</Pill>
        <span className="text-sm text-muted">Counsel signs under credential {shortAddress(a.credential)} and schema {shortAddress(a.schema)}.</span>
      </div>
      {done ? null : (
        <div className="max-w-sm">
          <WalletAction account={ctx.account} label="Record counsel’s attestation" variant="secondary" path={txPath(ctx.address, 'record-assignment')} needs="treasury" what="The assignment gate" testId="record-assignment" body={() => ({ payer: ctx.account?.address })} onDone={() => ctx.reload()} />
        </div>
      )}
    </Section>
  );
}

function WindDown({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (!e.extended) return null;
  const w = e.terms.windDown;
  const liquidating = ctx.view.detail.state === 'Liquidating';
  const lapse = ctx.view.detail.lapse;
  if (!w) {
    return (
      <Section id="winddown" title="Wind-down" intro="After a liquidation, holders redeem what the vault holds.">
        <NotEnabled>This treasury was extended without a wind-down window, and that cannot be added now. Holders can still redeem at the liquidation snapshot.</NotEnabled>
      </Section>
    );
  }
  const live = e.live.windDown;
  return (
    <Section
      id="winddown"
      title="Wind-down"
      intro={`If the attestation that releases your allowance lapses and the grace period passes, anyone can trigger a liquidation. Holders can then redeem their share of the vault for at least ${duration(w.windowSecs)}. Only after that can the rest be swept, and only to ${shortAddress(w.recovery)}, which was fixed at extension.`}
    >
      <div data-testid="winddown-state">
        <Facts
          rows={[
            ['Treasury', liquidating ? 'liquidating' : 'active'],
            ['Attestation lapsed since', lapse.lapsedSince ? utc(lapse.lapsedSince) : 'it has not lapsed'],
            ['Liquidation can be triggered from', lapse.graceEndsAt ? utc(lapse.graceEndsAt) : 'not applicable'],
            ['Redemption window', live ? `from ${utc(live.start)} until ${utc(live.sweepOpensAt)}` : 'not started'],
            ['Swept to the recovery account', live ? (live.swept ? 'yes' : 'not yet') : 'not yet'],
            ['In the vault', fmt(ctx.view.detail.balances.vault, ctx.quoteDecimals, 'quote')],
          ]}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {!liquidating ? (
          <WalletAction account={ctx.account} label="Trigger the liquidation" variant="secondary" path={txPath(ctx.address, 'trigger-liquidation')} testId="trigger-liquidation" body={() => ({ payer: ctx.account?.address })} onDone={() => ctx.reload()} />
        ) : (
          <WalletAction account={ctx.account} label="Sweep what is left to the recovery account" variant="secondary" path={txPath(ctx.address, 'sweep-unclaimed')} needs="treasury" what="The wind-down window" testId="sweep-unclaimed" disabled={live?.swept === true} disabledReason="Already swept." body={() => ({ payer: ctx.account?.address })} onDone={() => ctx.reload()} />
        )}
      </div>
      <p className="text-xs text-muted">{liquidating ? 'Holders redeem on the holder page. Sweeping before the window ends is refused by the program.' : 'Triggering a liquidation exists in the program deployed today. It is refused until the attestation has lapsed and its grace period has passed.'}</p>
    </Section>
  );
}
