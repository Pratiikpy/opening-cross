'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Chip, Fieldset, SmallButton, Text } from '@/components/issue-wizard/fields';
import { TreasuryStateBadge } from '@/components/treasury/badges';
import { type ExtIssue, type ExtPreview, type TermsErrors, type TreasuryView, buildTerms, fmt, loadTreasury, pctOf, previewExt, termsKeyForIssue } from '@/lib/issuer-treasury-console';
import { readMintFull } from '@/lib/issuer-chain';
import { duration, utc } from '@/lib/treasury';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { EMPTY_TERMS, FLAGSHIP_FACTS, TERMS_INSIDER_SLOTS, TERMS_PRESETS, type TermsForm, applyTermsPreset, cloneTerms, termsPreset } from '@opening-cross/presets/treasury';
import { ConnectPrompt } from './connect-prompt';
import { WalletAction } from './issuer-action';
import { ProgramNotice } from './program-notice';
import { TreasuryDisclosure } from './treasury-disclosure';
import { TreasuryGrants } from './treasury-grants';
import { TreasuryMoney } from './treasury-money';
import { TreasuryVotes } from './treasury-votes';
import { type Ctx, Facts, NOT_AUTHORITY, Pill, Section, txPath } from './treasury-ui';

const SECTIONS: [string, string][] = [
  ['terms', 'Terms'],
  ['votes', 'Holder votes'],
  ['nav', 'NAV wall'],
  ['money', 'Distributions and revenue'],
  ['grants', 'Team grants'],
  ['disclosure', 'Disclosure'],
  ['winddown', 'Wind-down'],
];

export function TreasuryConsole({ address }: { address: string }) {
  const { account } = useWallet();
  const [view, setView] = useState<TreasuryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coinDecimals, setCoinDecimals] = useState<number | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((r) => r + 1), []);

  useEffect(() => {
    let live = true;
    void loadTreasury(address).then(async (r) => {
      if (!live) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError(null);
      setView(r.data);
      setNow(Math.floor(Date.now() / 1000));
      const coin = await readMintFull(r.data.detail.terms.coinMint);
      if (live) setCoinDecimals(coin.ok ? coin.decimals : null);
    });
    return () => {
      live = false;
    };
  }, [address, rev]);

  if (error) {
    return (
      <p role="alert" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-accent-text" data-testid="treasury-error">
        {error}
      </p>
    );
  }
  if (!view) {
    return (
      <p role="status" className="mt-8 text-sm text-muted">
        Reading the treasury…
      </p>
    );
  }
  const d = view.detail;
  const ctx: Ctx = { address, view, account, quoteDecimals: d.terms.quoteDecimals, coinDecimals, isAuthority: account?.address === d.terms.authority, now, reload };
  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-[var(--radius-card)] border border-border p-5" data-testid="treasury-header">
        <div className="flex flex-wrap items-center gap-2">
          <TreasuryStateBadge state={d.state} />
          {view.ext.extended ? <Pill tone="ok">Extended</Pill> : <Pill tone="warn">Not extended</Pill>}
          <span className="font-mono text-xs text-muted">{shortAddress(address)}</span>
        </div>
        <div className="mt-4">
          <Facts
            rows={[
              ['In the vault', fmt(d.balances.vault, ctx.quoteDecimals, 'quote')],
              ['Coins in existence', d.balances.coinSupply ?? 'unavailable'],
              ['Authority', <span key="a" className="break-all">{d.terms.authority}</span>],
              ['This wallet', account ? (ctx.isAuthority ? 'is the authority' : 'is not the authority: you can read everything, and sign only what any holder may') : 'not connected'],
            ]}
          />
        </div>
        <nav aria-label="Sections" className="mt-4 flex flex-wrap gap-2">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface">
              {label}
            </a>
          ))}
          <Link href={`/treasury/${address}`} className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface">
            Open the holder page
          </Link>
        </nav>
      </div>
      {!account ? <ConnectPrompt what="the actions you can sign here. Everything below is read-only until a wallet is connected, and the actions are for" /> : null}
      <ProgramNotice which="treasury" what="The treasury extension (votes, NAV redemption, distributions, revenue rounds, grants, disclosure, wind-down)" />
      {view.unread.length > 0 ? (
        <p role="alert" className="rounded-[var(--radius-card)] border border-border p-4 text-sm text-accent-text" data-testid="unread">
          Could not read: {view.unread.join('; ')}. They are shown as unread, not as empty.
        </p>
      ) : null}
      <Terms ctx={ctx} />
      {view.ext.extended ? (
        <>
          <TreasuryVotes ctx={ctx} part="votes" />
          <TreasuryVotes ctx={ctx} part="nav" />
          <TreasuryMoney ctx={ctx} />
          <TreasuryGrants ctx={ctx} />
          <TreasuryDisclosure ctx={ctx} />
        </>
      ) : (
        <p className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="needs-extension">
          Holder votes, the NAV wall, distributions, revenue rounds, team grants, disclosure requests and the wind-down window all begin when the treasury is extended. Extend it above first; until then this treasury has its allowance spending, lapse and liquidation only.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the terms

function Terms({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (e.extended) return <FixedTerms ctx={ctx} />;
  if (ctx.view.detail.state !== 'Active') {
    return (
      <Section id="terms" title="Extend this treasury" intro="A liquidating treasury cannot be extended.">
        <p className="text-sm text-muted">Holders can still redeem at the liquidation snapshot.</p>
      </Section>
    );
  }
  return <Extend ctx={ctx} />;
}

function FixedTerms({ ctx }: { ctx: Ctx }) {
  const e = ctx.view.ext;
  if (!e.extended) return null;
  const t = e.terms;
  const q = ctx.quoteDecimals;
  const none = 'off';
  return (
    <Section id="terms" title="Terms, fixed for good" intro="The treasury was extended once. The program enforces these terms and nothing can change them, for you or for anyone else.">
      <div data-testid="fixed-terms" className="space-y-4">
        <Facts
          rows={[
            ['Holder votes', t.governance ? `${duration(t.governance.votePeriodSecs)} vote, ${duration(t.governance.timelockSecs)} timelock, ${pctOf(t.governance.quorumBps)} quorum, ${pctOf(t.governance.thresholdBps)} majority` : none],
            ['Largest proposal', t.governance ? `${pctOf(t.governance.maxProposalBps)} of the vault; a proposer holds at least ${pctOf(t.governance.proposerMinBps)} of the supply` : none],
            ['NAV window', t.nav ? `${duration(t.nav.periodSecs)} periods, at most ${pctOf(t.nav.capBps)} of the supply redeemed in one` : none],
            ['Excluded from NAV', t.nav ? (t.nav.insiders.length ? t.nav.insiders.map(shortAddress).join(', ') + ' and the authority' : 'the authority') : none],
            ['Distributions', t.distributions.streamSecs === '0' ? 'paid out at once' : `streamed over ${duration(t.distributions.streamSecs)}`],
            ['Revenue rounds', t.revenue ? `${pctOf(t.revenue.shareBps)} of attested revenue, a round each ${duration(t.revenue.roundSecs)}, ${duration(t.revenue.payGraceSecs)} to pay, from ${utc(t.revenue.start)}` : none],
            ['Revenue tranche', t.revenue && t.revenue.trancheAmount !== '0' ? `${fmt(t.revenue.trancheAmount, q, 'quote')} released to the team when a round’s revenue reaches ${fmt(t.revenue.trancheMinRevenue, q, 'quote')}` : none],
            ['Team grants lock for at least', duration(t.grants.minLockupSecs)],
            ['Disclosure', t.disclosure ? `due ${duration(t.disclosure.periodSecs)} after a holder with ${pctOf(t.disclosure.requestMinBps)} of the supply asks` : none],
            ['Assignment of IP and assets', t.assignment ? 'required before the team can take anything out' : none],
            ['Wind-down', t.windDown ? `${duration(t.windDown.windowSecs)} for holders to redeem, then the rest goes to ${shortAddress(t.windDown.recovery)}` : none],
          ]}
        />
      </div>
    </Section>
  );
}

const GROUPS: { id: string; title: string; intro: string; fields: { key: keyof TermsForm; label: string; hint: string; kind?: 'check' | 'datetime' }[] }[] = [
  {
    id: 'votes',
    title: 'Holder votes',
    intro: 'Holders may vote to spend above the allowance. A passed proposal waits out a timelock, then anyone can run it. Leave the vote period empty and there are no holder votes.',
    fields: [
      { key: 'votePeriodDays', label: 'A vote lasts, days (at least 3)', hint: 'Whole days.' },
      { key: 'timelockDays', label: 'Timelock after a passed vote, days (at least 1)', hint: 'Time for holders to react before money moves.' },
      { key: 'quorumPct', label: 'Quorum, % of the supply (10 to 100)', hint: 'Votes cast must reach this share of the coins in circulation.' },
      { key: 'thresholdPct', label: 'Majority needed, % of votes cast (above 50)', hint: 'Above half and below all.' },
      { key: 'maxProposalPct', label: 'Largest single proposal, % of the vault', hint: 'A proposal cannot ask for more than this share of what the vault holds.' },
      { key: 'proposerMinPct', label: 'A proposer holds at least, % of the supply', hint: 'The authority may always propose.' },
    ],
  },
  {
    id: 'nav',
    title: 'NAV redemption wall',
    intro: 'When open, holders can burn coins for their share of the vault, up to a cap each period. It opens only by a holder vote, or when a revenue round is missed. The team and the insiders named here cannot redeem. Leave the period empty and there is no NAV window.',
    fields: [
      { key: 'navPeriodDays', label: 'A NAV period lasts, days', hint: 'The cap resets each period.' },
      { key: 'navCapPct', label: 'Most that can be redeemed in a period, % of the supply', hint: 'The wall: a run on the vault is slowed to this.' },
    ],
  },
  {
    id: 'dist',
    title: 'Distributions',
    intro: 'Anyone may add quote tokens for holders who stake their coins. They are streamed over the length below so that staking for one block to catch a deposit pays nothing. Leave empty for no stream.',
    fields: [{ key: 'streamHours', label: 'Stream over, hours (at least 1)', hint: 'Whole hours.' }],
  },
  {
    id: 'revenue',
    title: 'Revenue rounds',
    intro: 'Holders are owed a share of revenue that an attester you name signs for each round. The team pays it in; if a round is not paid in time it is marked missed and a NAV window opens. Leave the share empty for no rounds.',
    fields: [
      { key: 'revSharePct', label: 'Holders’ share of attested revenue, %', hint: 'Fixed for good.' },
      { key: 'revCredential', label: 'Revenue attester: credential address', hint: 'The Solana Attestation Service credential that signs each round’s revenue.' },
      { key: 'revSchema', label: 'Revenue attester: schema address', hint: 'The schema of that attestation (a revenue figure).' },
      { key: 'roundDays', label: 'A round lasts, days', hint: 'Whole days.' },
      { key: 'revStart', label: 'The first round starts', hint: 'Now or later: a start in the past would let anyone mark round zero missed at once.', kind: 'datetime' },
      { key: 'payGraceDays', label: 'Days to pay after a round ends', hint: 'After this a round can be marked missed.' },
      { key: 'trancheMinRevenue', label: 'Tranche: revenue a round must reach, in quote tokens (optional)', hint: 'A tranche is a fixed amount released to the team when a round’s revenue reaches this.' },
      { key: 'trancheAmount', label: 'Tranche: amount released, in quote tokens (optional)', hint: 'Needs revenue rounds.' },
    ],
  },
  {
    id: 'grants',
    title: 'Team grants',
    intro: 'Coins for the team are escrowed in grants that release by milestone. A grant cannot unlock before this lockup, whatever its milestones say.',
    fields: [{ key: 'minLockupDays', label: 'Shortest lockup of a grant, days', hint: 'Whole days.' }],
  },
  {
    id: 'disclosure',
    title: 'Disclosure',
    intro: 'A holder with enough coins may ask for a disclosure. The team then has this long to post one, and until it does, it cannot spend. Leave the period empty for none.',
    fields: [
      { key: 'disclosurePeriodDays', label: 'Time to answer a request, days (at least 1)', hint: 'After this the team cannot spend until it posts.' },
      { key: 'requestMinPct', label: 'A requester holds at least, % of the supply', hint: 'Keeps a dust holder from stopping spending.' },
    ],
  },
  {
    id: 'assignment',
    title: 'Assignment of IP and assets',
    intro: 'When required, no team outflow works until counsel’s attestation that the company’s IP and assets are assigned has been recorded.',
    fields: [
      { key: 'assignRequired', label: 'Require the assignment before the team can take anything out', hint: 'Without counsel’s credential and schema the gate can never open.', kind: 'check' },
      { key: 'assignCredential', label: 'Counsel’s credential address', hint: 'A Solana Attestation Service credential.' },
      { key: 'assignSchema', label: 'Counsel’s schema address', hint: 'The schema of the assignment attestation.' },
    ],
  },
  {
    id: 'winddown',
    title: 'Wind-down',
    intro: 'After a liquidation, holders can redeem for at least this long. Then what is left is swept to the recovery account, which cannot be changed. Leave empty for no wind-down window.',
    fields: [
      { key: 'windowDays', label: 'Holders can redeem for, days (at least 180)', hint: 'Whole days.' },
      { key: 'recovery', label: 'Recovery account for what is not redeemed', hint: 'Prefer an account holders control, such as a multisig.' },
    ],
  },
];

const FLAGSHIP_KEYS: (keyof TermsForm)[] = ['revSharePct', 'revCredential', 'revSchema', 'revStart', 'assignCredential', 'assignSchema', 'recovery'];

function Extend({ ctx }: { ctx: Ctx }) {
  const authority = ctx.view.detail.terms.authority;
  const [presetId, setPresetId] = useState<string>('governed');
  const preset = termsPreset(presetId);
  const [form, setForm] = useState<TermsForm>(() => applyTermsPreset(termsPreset('governed')!));
  const [custom, setCustom] = useState(false);
  const [preview, setPreview] = useState<ExtPreview | 'pending' | null>(null);
  const [ack, setAck] = useState(false);
  const kind = !custom && preset?.kind === 'flagship' ? 'flagship' : 'custom';
  const built = buildTerms(form, kind, authority, ctx.quoteDecimals);
  const key = built.body ? JSON.stringify(built.body) : null;
  const set = <K extends keyof TermsForm>(k: K, v: TermsForm[K]) => setForm({ ...form, [k]: v });

  useEffect(() => {
    if (!key) {
      setPreview(null);
      return;
    }
    setPreview('pending');
    const ctl = new AbortController();
    const t = setTimeout(() => {
      previewExt(ctx.address, JSON.parse(key) as Record<string, unknown>, ctl.signal).then(setPreview, () => undefined);
    }, 450);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [key, ctx.address]);

  const issues: ExtIssue[] = preview && preview !== 'pending' ? preview.issues : [];
  const refused = issues.filter((i) => i.severity === 'refused');
  const advice = issues.filter((i) => i.severity === 'advice');
  const byKey: Partial<Record<keyof TermsForm, string>> = {};
  for (const i of issues) {
    const k = termsKeyForIssue(i.field);
    if (k && !byKey[k]) byKey[k] = i.message;
  }
  const previewFailed = preview && preview !== 'pending' && !preview.ok && refused.length === 0 ? preview : null;
  const ready = Boolean(built.body) && preview !== null && preview !== 'pending' && preview.ok && refused.length === 0 && (advice.length === 0 || ack);
  const err = (k: keyof TermsForm): string | undefined => (built.errors as TermsErrors)[k] ?? byKey[k];
  const apply = (id: string) => {
    const p = termsPreset(id);
    if (!p) return;
    setPresetId(id);
    setCustom(false);
    setForm(applyTermsPreset(p));
    setAck(false);
  };
  const shown = kind === 'flagship' ? GROUPS.filter((g) => g.fields.some((f) => FLAGSHIP_KEYS.includes(f.key))).map((g) => ({ ...g, fields: g.fields.filter((f) => FLAGSHIP_KEYS.includes(f.key)) })) : GROUPS;
  const wallet = ctx.account?.address;

  return (
    <Section id="terms" title="Extend this treasury" intro="One time only. Extending adds holder votes, a NAV wall, distributions, revenue rounds, team grants, disclosure requests and a wind-down window, and fixes their terms for good: the program enforces them and nothing can change them, not even for you.">
      <div className="space-y-4" data-testid="extend">
        <div className="space-y-2">
          <p className="text-sm font-medium">Start from</p>
          <div className="flex flex-wrap gap-2">
            {TERMS_PRESETS.map((p) => (
              <SmallButton key={p.id} testId={`terms-preset-${p.id}`} pressed={!custom && presetId === p.id} onClick={() => apply(p.id)}>
                {p.name}
              </SmallButton>
            ))}
            <SmallButton
              testId="terms-custom"
              pressed={custom}
              onClick={() => {
                setCustom(true);
                setForm(cloneTerms(EMPTY_TERMS));
                setAck(false);
              }}
            >
              Choose every term
            </SmallButton>
          </div>
          {!custom && preset ? <p className="text-sm text-muted">{preset.summary}</p> : <p className="text-sm text-muted">Every term is yours to set. A term left empty is off for good.</p>}
        </div>

        {kind === 'flagship' ? (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid="flagship-facts">
            <p className="font-medium">What this preset fixes</p>
            <p className="mt-1 text-muted">
              Votes last {FLAGSHIP_FACTS.votePeriodDays} days with a {FLAGSHIP_FACTS.timelockDays}-day timelock, a {FLAGSHIP_FACTS.quorumPct}% quorum and a {FLAGSHIP_FACTS.thresholdPct}% majority; a proposal may ask for {FLAGSHIP_FACTS.maxProposalPct}% of the vault and a proposer holds {FLAGSHIP_FACTS.proposerMinPct}% of the supply. The NAV window runs in {FLAGSHIP_FACTS.navPeriodDays}-day periods capped at {FLAGSHIP_FACTS.navCapPct}% of the supply. Distributions stream over {FLAGSHIP_FACTS.streamDays} days. Team grants lock for {FLAGSHIP_FACTS.minLockupDays} days. Revenue rounds last {FLAGSHIP_FACTS.roundDays} days with {FLAGSHIP_FACTS.payGraceDays} days to pay. A disclosure is due {FLAGSHIP_FACTS.disclosurePeriodDays} days after a holder with {FLAGSHIP_FACTS.requestMinPct}% asks. The IP assignment is required, and holders can redeem for {FLAGSHIP_FACTS.windowDays} days after a liquidation. You supply the rest below.
            </p>
          </div>
        ) : null}

        <div className="space-y-3">
          {shown.map((g) => (
            <Fieldset key={g.id} legend={g.title} id={`terms-${g.id}`} note={kind === 'flagship' ? undefined : g.intro}>
              {g.fields.map((f) =>
                f.kind === 'check' ? (
                  <div key={f.key} className="text-sm">
                    <label className="flex min-h-11 items-center gap-3">
                      <input type="checkbox" className="size-5" checked={form[f.key] as boolean} onChange={(e) => set(f.key, e.target.checked as never)} data-testid={`term-${f.key}`} />
                      <span className="font-medium">{f.label}</span>
                    </label>
                    <p className="ml-8 text-xs text-muted">{f.hint}</p>
                  </div>
                ) : (
                  <div key={f.key} data-testid={`term-field-${f.key}`}>
                    <Text label={f.label} value={form[f.key] as string} onChange={(v) => set(f.key, v as never)} error={err(f.key)} hint={f.hint} type={f.kind === 'datetime' ? 'datetime-local' : 'text'} />
                  </div>
                ),
              )}
              {kind === 'custom' && g.id === 'nav' ? (
                <InsidersField form={form} set={set} errors={built.errors} />
              ) : null}
            </Fieldset>
          ))}
          {kind === 'flagship' && !shown.some((g) => g.id === 'nav') ? (
            <Fieldset legend="Left out of the NAV window" id="terms-insiders" note="The authority is always excluded. Name up to four more wallets (founders, early investors) that cannot redeem at NAV.">
              <InsidersField form={form} set={set} errors={built.errors} />
            </Fieldset>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-surface p-4 text-sm" role="status" data-testid="terms-verdict">
          <p className="font-medium">Does the program accept these terms?</p>
          {!built.body ? (
            <p className="mt-1 text-muted">{Object.keys(built.errors).length ? 'A field cannot be read yet. The message is on the field.' : 'Fill in the terms.'}</p>
          ) : preview === 'pending' || preview === null ? (
            <p className="mt-1 text-muted">Checking…</p>
          ) : previewFailed ? (
            <p className="mt-1 text-accent-text" data-state={previewFailed.reason ?? 'error'}>
              {previewFailed.error}
            </p>
          ) : refused.length > 0 ? (
            <ul className="mt-2 space-y-2" data-state="refused">
              {refused.map((i, n) => (
                <li key={n} className="flex items-start gap-3" data-testid={`terms-issue-${i.code}`}>
                  <Chip tone="block">Refused</Chip>
                  <span className="min-w-0 flex-1">{i.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div data-state={advice.length ? 'advice' : 'ok'}>
              <p className="mt-1 text-muted">
                <span className="font-medium text-positive">Accepted.</span> {advice.length ? 'The program accepts these terms, but read this first.' : 'The program accepts these terms.'}
              </p>
              {advice.length ? (
                <>
                  <ul className="mt-2 space-y-2">
                    {advice.map((i, n) => (
                      <li key={n} className="flex items-start gap-3" data-testid={`terms-advice-${i.code}`}>
                        <Chip tone="warn">Unusable</Chip>
                        <span className="min-w-0 flex-1">{i.message}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="mt-3 flex min-h-11 items-center gap-3">
                    <input type="checkbox" className="size-5" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="terms-ack" />
                    <span>I understand and want these terms fixed as they are.</span>
                  </label>
                </>
              ) : null}
            </div>
          )}
        </div>

        <WalletAction
          account={ctx.account}
          label="Extend the treasury"
          path={txPath(ctx.address, 'init-ext')}
          needs="treasury"
          what="The treasury extension"
          testId="extend-treasury"
          disabled={!ready || !ctx.isAuthority || wallet === undefined}
          disabledReason={!ctx.isAuthority ? NOT_AUTHORITY : !ready ? 'Fill in the terms until the program accepts them.' : undefined}
          body={() => ({ ...built.body, authority: wallet })}
          onDone={() => ctx.reload()}
        />
      </div>
    </Section>
  );
}

function InsidersField({ form, set, errors }: { form: TermsForm; set: <K extends keyof TermsForm>(k: K, v: TermsForm[K]) => void; errors: TermsErrors }) {
  return (
    <div className="space-y-3" data-testid="insiders">
      {form.insiders.map((v, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label={`Excluded from NAV: wallet ${i + 1}`} value={v} onChange={(x) => set('insiders', form.insiders.map((y, j) => (j === i ? x : y)))} error={errors[`insiders.${i}` as `insiders.${number}`]} />
          <button type="button" className="mb-1 min-h-11 min-w-11 px-1 py-1 text-sm text-muted underline" aria-label={`Remove wallet ${i + 1}`} onClick={() => set('insiders', form.insiders.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      {form.insiders.length < TERMS_INSIDER_SLOTS ? (
        <SmallButton testId="add-term-insider" onClick={() => set('insiders', [...form.insiders, ''])}>
          Name a wallet that cannot redeem at NAV
        </SmallButton>
      ) : null}
    </div>
  );
}
