'use client';

import { EMPTY_RULES_FORM, RULE_LIMITS, RULE_PRESETS, type RulePreset, type RulesForm, applyRulePreset, rulePreset, rulesFormIsEmpty } from '@opening-cross/presets/rules';
import { useState } from 'react';
import { ProgramNotice } from '@/components/issuer/program-notice';
import { type RuleIssue, type RulesBuild, type ViewItem, formKeyForIssue, sizeStatement, TRANSACTION_LIMIT } from '@/lib/issuer-rules';
import { Chip, Fieldset, SmallButton, Text } from './fields';
import type { Verdict } from './use-rules-verdict';
import type { RemoteCheck, SizeResult } from '@/lib/issuer-rules';

type Kind = 'text' | 'check' | 'datetime';
type FieldSpec = { key: keyof RulesForm; label: string; hint: string; kind?: Kind; inputMode?: 'decimal' | 'numeric' };
type Group = { id: string; title: string; intro: string; fields: FieldSpec[]; list?: { key: 'insiders' | 'extraFeeds'; label: string; add: string; max: number; hint: string } };

const GROUPS: Group[] = [
  {
    id: 'ending',
    title: 'The ending',
    intro:
      'A call auction invites the order placed in the last second by someone who has read the book. These rules take that advantage away. The last stretch before the close is cut into equal buckets, each order belongs to the bucket of the moment it lands, and after the close the cluster draws which bucket is the last one counted. Orders in later buckets are not counted and are refunded in full.',
    fields: [
      { key: 'endingMins', label: 'Ending period, minutes', hint: 'The last stretch before the close, in whole minutes. It must be shorter than the call. Empty: no ending period.', inputMode: 'numeric' },
      { key: 'buckets', label: `Buckets in the ending period (1 to ${RULE_LIMITS.maxBuckets})`, hint: 'Equal slices of the ending period. A drawn end needs at least two.', inputMode: 'numeric' },
      { key: 'drawnEnd', label: 'Draw the last counted bucket after the close', hint: 'The draw uses the cluster’s own block hashes, sampled from four different leaders’ turns. It is randomness the cluster attests, not a verifiable random function; anyone can check the arithmetic.', kind: 'check' },
      { key: 'cancelCutoffMins', label: 'Cancel cutoff, minutes before the ending period', hint: 'After this, an order cannot be cancelled, so a decoy cannot be placed and withdrawn once the final period opens. It is still refunded in full if the cross does not print.', inputMode: 'numeric' },
      { key: 'extensionMaxMins', label: 'Longest extension, minutes', hint: 'If the cross fails a guard, the call opens again once, for a length drawn between the shortest and longest. Orders in the extension cannot be cancelled and the second clear is final. Empty: no extension.', inputMode: 'numeric' },
      { key: 'extensionMinMins', label: 'Shortest extension, minutes', hint: 'Needed when there is an extension; it cannot exceed the longest.', inputMode: 'numeric' },
    ],
  },
  {
    id: 'guards',
    title: 'Print guards the program checks at the clear',
    intro:
      'The guards above this section are turned into a minimum volume and a top price. These are checked by the program itself, on the volume that counts: declared insiders are left out. When one fails, nobody is charged and every bidder is refunded.',
    fields: [
      { key: 'minRaise', label: 'Minimum raise, in quote tokens', hint: 'Below this amount raised the cross does not print.', inputMode: 'decimal' },
      { key: 'maxDelivered', label: 'Hard cap on tokens sold', hint: 'A cap published before the first order, not a choice made after seeing the book. For a minting cross.', inputMode: 'decimal' },
      { key: 'declaredSupply', label: 'Declared total supply, in tokens', hint: 'The supply the float and value rules measure against. Required for a deferred-mint cross; otherwise the program reads it from the mint at the clear.', inputMode: 'decimal' },
      { key: 'minFloatPct', label: 'Minimum public float, %', hint: 'The share of all tokens that must end up with buyers, not counting declared insiders. This is checked against the supply at the clear; the float box above only raises the minimum volume.', inputMode: 'decimal' },
      { key: 'maxFdvRatio', label: 'Largest ratio of value to raise', hint: 'All tokens may be worth at most this many times the amount raised. 20 means a raise of 1,000,000 cannot value the coin above 20,000,000. At least 1.', inputMode: 'decimal' },
      { key: 'movePct', label: 'Largest price move from the anchor, %', hint: 'If the clearing price lands further than this from the anchor, nothing executes and every order is refunded. Place a new order in the follow-up cross.', inputMode: 'decimal' },
      { key: 'anchorPrice', label: 'Anchor price, per token', hint: 'What the move is measured from. Empty: the reopen reference, or the standard grid’s estimate below.', inputMode: 'decimal' },
    ],
  },
  {
    id: 'identity',
    title: 'Limits per verified identity',
    intro: 'These count a wallet that holds the cross’s gate pass, so they need a gate (below). They are how one application per person is enforced.',
    fields: [
      { key: 'identityMaxOrders', label: 'Orders per identity', hint: '1 means one application per identity.', inputMode: 'numeric' },
      { key: 'identityCap', label: 'Most quote an identity may have in open buy orders', hint: 'Cancelling an order frees the room.', inputMode: 'decimal' },
    ],
  },
  {
    id: 'alloc',
    title: 'Who is filled first when a level is oversubscribed',
    intro:
      'Better-priced orders always fill in full. Only the marginal level is rationed, and these reserve parts of it for classes of buyer. A reserve a class cannot fill goes to everyone else. They apply to crosses that mint their token.',
    fields: [
      { key: 'reserveSmallPct', label: 'Reserved for small verified buyers (class 1), %', hint: 'Needs the small-order cap and a gate.', inputMode: 'decimal' },
      { key: 'smallCap', label: 'Largest order that counts as small, in quote tokens', hint: 'Applies to wallets that hold the gate pass.', inputMode: 'decimal' },
      { key: 'lotteryLot', label: 'Lottery lot size, in tokens', hint: 'Draw winners among class 1: every class 1 order is exactly one lot. Empty: class 1 shares pro rata.', inputMode: 'decimal' },
      { key: 'reserveLockedPct', label: 'Reserved for buyers who accept a lockup (class 2), %', hint: 'Needs a minimum lockup.', inputMode: 'decimal' },
      { key: 'minLockDays', label: 'Shortest lockup a buyer may choose, days', hint: 'Up to four years. Locked fills are paid into a lock vault and released as they vest.', inputMode: 'numeric' },
      { key: 'lockVestDays', label: 'Vesting after the lockup, days', hint: 'Linear. Empty: all at once when the lock ends.', inputMode: 'numeric' },
      { key: 'reservePriorityPct', label: 'Reserved for priority buyers (class 3), %', hint: 'Needs an early-commitment deadline or a priority pass.', inputMode: 'decimal' },
      { key: 'earlyUntil', label: 'Early-commitment deadline', hint: 'Orders committed before this get priority. It improves priority, never price. It must fall inside the call.', kind: 'datetime' },
      { key: 'priorityGate', label: 'Priority pass (a gate mint address)', hint: 'Holders of this pass count as priority buyers.' },
      { key: 'class1CliffDays', label: 'Small-buyer fills unlock after, days', hint: 'Identity-bound vesting for class 1.', inputMode: 'numeric' },
      { key: 'class1VestDays', label: 'Small-buyer fills then vest over, days', hint: 'Linear.', inputMode: 'numeric' },
    ],
  },
  {
    id: 'neutrality',
    title: 'Insiders and your bond',
    intro:
      'Name the wallets that belong to your team. Their orders are tallied apart, their fills are locked, and they do not count toward the minimum volume, the raise or the float. You post a bond; anyone may challenge a wallet that was not declared during the challenge window after the clear, and an upheld challenge slashes the bond.',
    list: { key: 'insiders', label: 'Insider wallet', add: 'Add an insider', max: RULE_LIMITS.maxInsiders, hint: `Up to ${RULE_LIMITS.maxInsiders}. Each one adds 32 bytes to the creation transaction.` },
    fields: [
      { key: 'insiderCliffDays', label: 'Insider fills unlock after, days', hint: 'Up to four years.', inputMode: 'numeric' },
      { key: 'insiderVestDays', label: 'Insider fills then vest over, days', hint: 'Linear.', inputMode: 'numeric' },
      { key: 'bond', label: 'Bond, in quote tokens', hint: 'Taken from your quote token account when the cross is created and held until the challenge window closes.', inputMode: 'decimal' },
      { key: 'challengeDays', label: 'Challenge window, days', hint: 'From 1 hour to 30 days after the clear, in whole days here.', inputMode: 'numeric' },
    ],
  },
  {
    id: 'oracles',
    title: 'More than one oracle',
    intro: 'Your own oracle guard (above) compares the price with one Pyth feed. Add up to two more and the reference is the median of the usable prices; the cross does not print if too few agree. These widen that guard, so it must be switched on.',
    list: { key: 'extraFeeds', label: 'Extra Pyth feed id', add: 'Add a feed', max: RULE_LIMITS.maxExtraFeeds, hint: 'Each is 64 hexadecimal characters and adds 32 bytes to the creation transaction.' },
    fields: [
      { key: 'quorum', label: 'How many oracles must be fresh and verified', hint: 'From 1 to the number of oracles.', inputMode: 'numeric' },
      { key: 'maxSpreadPct', label: 'Largest spread between oracles, %', hint: 'If they differ by more, the cross does not print.', inputMode: 'decimal' },
      { key: 'offHoursWidenPct', label: 'Wider oracle band while the market is closed, %', hint: 'Follows a calendar’s sessions, so a calendar is needed (under stocks).', inputMode: 'decimal' },
    ],
  },
  {
    id: 'stocks',
    title: 'Tokenized stocks and halts',
    intro: 'For a reopen of a token that trades under a calendar. A halt binds a cross that names the halt state, and only a printing resume cross lifts it.',
    fields: [
      { key: 'standardGrid', label: 'Use the standard price grid', hint: 'The first price must be at least half the published estimate, steps at most one percent of it, and the estimate inside the grid.', kind: 'check' },
      { key: 'gridEstimate', label: 'Published price estimate, per token', hint: 'What the standard grid is measured against. Also the anchor of the move bound when no anchor is set.', inputMode: 'decimal' },
      { key: 'guardScaledUi', label: 'Void the cross if the share multiplier changes', hint: 'If a split or similar action changes a Token-2022 scaled-UI multiplier while the cross is open, it does not print.', kind: 'check' },
      { key: 'resumesHalt', label: 'This cross lifts a trading halt', hint: 'It names the halt state below and lifts it only if it prints.', kind: 'check' },
      { key: 'haltSource', label: 'Halt state it lifts or obeys (the base mint address)', hint: 'The halt state is keyed by the token’s mint.' },
      { key: 'feedsLenders', label: 'Feed the lender price', hint: 'A print can update the price lenders read, only if enough tokens trade.', kind: 'check' },
      { key: 'calendar', label: 'Calendar (a cross_calendar account address)', hint: 'The sessions that decide when the market is open. A cross on a calendar may only name oracle feeds the calendar approves.' },
    ],
  },
  {
    id: 'graduation',
    title: 'Graduation by holder vote',
    intro: 'Let your holders choose the venue the market opens on. This is set now, before the first order, and cannot be added or removed afterwards.',
    fields: [
      { key: 'governedGraduation', label: 'The market opens only on the venue holders vote for', hint: 'You then set a charter on the graduation page before the first order. It needs the graduation program and the batch 2 upgrade of the settlement program, which are built and proved but not on devnet yet: creating the cross is refused while they are not.', kind: 'check' },
    ],
  },
  {
    id: 'referral',
    title: 'Referral',
    intro: 'A referrer shares the protocol’s fee, not yours and not the bidders’. It is paid when the cross is finalized, and never on bids, cancels or refunds.',
    fields: [
      { key: 'referrer', label: 'Referrer wallet', hint: 'Its quote token account must exist when the cross is finalized.' },
      { key: 'referralSharePct', label: `Share of the protocol fee, % (up to ${RULE_LIMITS.maxReferralBps / 100})`, hint: 'Half the protocol fee at most.', inputMode: 'decimal' },
    ],
  },
];

const setCount = (g: Group, f: RulesForm) =>
  g.fields.filter((x) => {
    const v = f[x.key];
    return typeof v === 'boolean' ? v : typeof v === 'string' ? v.trim() !== '' : false;
  }).length + (g.list ? f[g.list.key].filter((x) => x.trim() !== '').length : 0);

export type RulesPanelProps = {
  form: RulesForm;
  setForm: (f: RulesForm) => void;
  build: RulesBuild;
  check: Verdict<RemoteCheck>;
  size: Verdict<SizeResult>;
  view: ViewItem[];
  /** The check can be asked: both tokens read, the grid and the window valid. */
  checkable: boolean;
  /** Whether a wallet is connected (the size is measured for it). */
  walletConnected: boolean;
  hasGate: boolean;
  oracleOn: boolean;
  supplyMode: 'escrow' | 'mint';
};

/** The issues of the remote check by the form field they belong to; the ones with no field of their own are listed under the groups. */
export function issuesByField(issues: RuleIssue[]): { byKey: Partial<Record<keyof RulesForm, string>>; loose: RuleIssue[] } {
  const byKey: Partial<Record<keyof RulesForm, string>> = {};
  const loose: RuleIssue[] = [];
  for (const i of issues) {
    const k = formKeyForIssue(i.field);
    if (k && !byKey[k]) byKey[k] = i.message;
    else loose.push(i);
  }
  return { byKey, loose };
}

export function RulesPanel(p: RulesPanelProps) {
  const { form, setForm, build } = p;
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const remote = p.check.state === 'done' && p.check.result.ok ? issuesByField(p.check.result.issues) : { byKey: {}, loose: [] as RuleIssue[] };
  const set = <K extends keyof RulesForm>(k: K, v: RulesForm[K]) => setForm({ ...form, [k]: v });
  const empty = rulesFormIsEmpty(form);

  const apply = (pr: RulePreset) => {
    setForm(applyRulePreset(pr));
    setApplied(pr.id);
    const needs = pr.needs.map((n) => ({ gate: 'a gate', mint: 'a minting cross', oracle: 'the oracle guard switched on', calendar: 'a calendar' })[n]);
    const mine = pr.yoursToFill.length ? ` You still fill in: ${pr.yoursToFill.map((k) => GROUPS.flatMap((g) => g.fields).find((f) => f.key === k)?.label ?? GROUPS.find((g) => g.list?.key === k)?.list?.label ?? k).join('; ')}.` : '';
    setPresetNote(`${pr.name}. These values are conventions of this product and every one stays editable.${needs.length ? ` It relies on ${needs.join(' and ')}.` : ''}${mine}`);
  };

  return (
    <Fieldset legend="Rules (optional)" id="rules" note="Rules are written into the cross in the same transaction that creates it, and nothing in them can be changed afterwards. Leave every field empty and the cross is created exactly as it is today.">
      <ProgramNotice which="crossCore" what="The rules extension" />
      <div className="space-y-2" data-testid="rule-presets">
        <p className="text-sm font-medium">Start from a preset</p>
        <div className="flex flex-wrap gap-2">
          {RULE_PRESETS.map((pr) => (
            <SmallButton key={pr.id} testId={`rule-preset-${pr.id}`} pressed={applied === pr.id} onClick={() => apply(pr)}>
              {pr.name}
            </SmallButton>
          ))}
        </div>
        {applied && rulePreset(applied) ? <p className="text-sm text-muted">{rulePreset(applied)!.summary}</p> : <p className="text-sm text-muted">A preset fills the fields below with a starting shape. It never chooses an amount that belongs to your token.</p>}
        {presetNote ? (
          <p role="status" className="text-xs text-muted" data-testid="rule-preset-note">
            {presetNote}
          </p>
        ) : null}
        {!empty ? (
          <SmallButton
            testId="rules-clear"
            onClick={() => {
              setForm({ ...EMPTY_RULES_FORM, insiders: [], extraFeeds: [] });
              setApplied(null);
              setPresetNote(null);
            }}
          >
            Clear every rule
          </SmallButton>
        ) : null}
      </div>

      <div className="space-y-3">
        {GROUPS.map((g) => {
          const n = setCount(g, form);
          return (
            <details key={g.id} className="rounded-lg border border-border" open={n > 0 ? true : undefined} data-testid={`rules-group-${g.id}`}>
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="font-medium">{g.title}</span>
                <Chip tone={n > 0 ? 'warn' : 'info'}>{n > 0 ? `${n} set` : 'off'}</Chip>
              </summary>
              <div className="space-y-4 border-t border-border p-4">
                <p className="text-sm text-muted">{g.intro}</p>
                {g.list ? (
                  <div className="space-y-3">
                    {form[g.list.key].map((v, i) => (
                      <div key={i} className="grid grid-cols-[1fr_auto] items-end gap-3">
                        <Text label={`${g.list!.label} ${i + 1}`} value={v} onChange={(x) => set(g.list!.key, form[g.list!.key].map((y, j) => (j === i ? x : y)))} error={build.errors[`${g.list!.key}.${i}` as `insiders.${number}`] ?? (i === 0 ? remote.byKey[g.list!.key] : undefined)} />
                        <button type="button" className="mb-1 min-h-11 min-w-11 px-1 py-1 text-sm text-muted underline" aria-label={`Remove ${g.list!.label.toLowerCase()} ${i + 1}`} onClick={() => set(g.list!.key, form[g.list!.key].filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </div>
                    ))}
                    <p className="text-xs text-muted">{g.list.hint}</p>
                    {form[g.list.key].length < g.list.max ? (
                      <SmallButton testId={`add-${g.list.key}`} onClick={() => set(g.list!.key, [...form[g.list!.key], ''])}>
                        {g.list.add}
                      </SmallButton>
                    ) : null}
                  </div>
                ) : null}
                {g.fields.map((f) => {
                  const err = build.errors[f.key] ?? remote.byKey[f.key];
                  if (f.kind === 'check') {
                    const on = form[f.key] as boolean;
                    return (
                      <div key={f.key} className="text-sm">
                        <label className="flex min-h-11 items-center gap-3">
                          <input type="checkbox" className="size-5" checked={on} onChange={(e) => set(f.key, e.target.checked as never)} data-testid={`rule-${f.key}`} />
                          <span className="font-medium">{f.label}</span>
                        </label>
                        <p className="ml-8 text-xs text-muted">{f.hint}</p>
                        {err ? <p className="ml-8 mt-1 text-xs text-accent-text">{err}</p> : null}
                      </div>
                    );
                  }
                  return (
                    <div key={f.key} data-testid={`rule-field-${f.key}`}>
                      <Text label={f.label} value={form[f.key] as string} onChange={(v) => set(f.key, v as never)} error={err} hint={f.hint} type={f.kind === 'datetime' ? 'datetime-local' : 'text'} {...(f.inputMode ? { inputMode: f.inputMode } : {})} mono={f.kind !== 'datetime' && f.inputMode !== undefined} />
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>

      <Verdicts {...p} issues={remote.loose} />
      <BidderView view={p.view} active={build.active} />
    </Fieldset>
  );
}

function Verdicts({ check, size, build, checkable, walletConnected, issues, hasGate, oracleOn, supplyMode }: RulesPanelProps & { issues: RuleIssue[] }) {
  const localErrors = Object.values(build.errors);
  return (
    <div className="space-y-3" data-testid="rules-verdicts">
      <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid="rules-check" role="status">
        <p className="font-medium">Are these rules accepted?</p>
        {!build.active ? (
          <p className="mt-1 text-muted">No rule is set, so there is nothing to check. The cross is created as it is today.</p>
        ) : localErrors.length > 0 ? (
          <p className="mt-1 text-muted" data-state="unreadable">
            {localErrors.length === 1 ? 'One field' : `${localErrors.length} fields`} cannot be read yet. The message is on the field.
          </p>
        ) : !checkable ? (
          <p className="mt-1 text-muted" data-state="waiting">
            The rules are checked by the same function that checks them when the cross is created, but it needs the two tokens read and the grid and the call window valid. Check both tokens and finish those fields.
          </p>
        ) : check.state === 'pending' || check.state === 'idle' ? (
          <p className="mt-1 text-muted" data-state="pending">
            Checking…
          </p>
        ) : !check.result.ok ? (
          <p className="mt-1 text-accent-text" data-state="unavailable">
            {check.result.error} Create stays off until the rules have been checked.
          </p>
        ) : check.result.issues.length === 0 ? (
          <p className="mt-1 text-muted" data-state="ok">
            <span className="font-medium text-positive">Accepted.</span> Every check the program makes on the rules themselves passes. It cannot see what is on chain, such as whether the halt state or the calendar you name exists; the program checks that when the cross is created.
          </p>
        ) : (
          <ul className="mt-2 space-y-2" data-state="refused">
            {check.result.issues.map((i, n) => (
              <li key={n} className="flex items-start gap-3" data-testid={`rule-issue-${i.code}`}>
                <Chip tone="block">Refused</Chip>
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-xs text-muted">{i.field}</span>
                  <br />
                  {i.message}
                </span>
              </li>
            ))}
          </ul>
        )}
        {issues.length > 0 ? <p className="mt-2 text-xs text-muted">Not tied to one field above: {issues.map((i) => i.code).join(', ')}.</p> : null}
        {build.active ? (
          <p className="mt-2 text-xs text-muted">
            {hasGate ? 'A gate is set.' : 'No gate is set: limits per identity and the small-buyer class need one.'} {oracleOn ? 'The oracle guard is on.' : 'The oracle guard is off: extra oracles need it.'} {supplyMode === 'mint' ? 'This cross mints its token.' : 'This cross sells from escrow: classes and the cap need a minting cross.'}
          </p>
        ) : null}
      </div>

      {build.active ? <SizeBox size={size} walletConnected={walletConnected} /> : null}
    </div>
  );
}

function SizeBox({ size, walletConnected }: { size: Verdict<SizeResult>; walletConnected: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid="rules-size" role="status">
      <p className="font-medium">Does it fit in a transaction?</p>
      {!walletConnected ? (
        <p className="mt-1 text-muted">A transaction holds at most {TRANSACTION_LIMIT} bytes. The creation and the rules must share one, and each insider and each extra oracle feed adds 32 bytes. Connect a wallet to measure this cross exactly.</p>
      ) : size.state === 'idle' ? (
        <p className="mt-1 text-muted">Measured once the rules are accepted.</p>
      ) : size.state === 'pending' ? (
        <p className="mt-1 text-muted">Measuring…</p>
      ) : size.result.ok ? (
        <SizeOk r={size.result} />
      ) : (
        <p className="mt-1 text-accent-text" data-state={size.result.reason === 'TX_TOO_LARGE' ? 'too-large' : 'error'}>
          {size.result.error}
        </p>
      )}
    </div>
  );
}

function SizeOk({ r }: { r: Extract<SizeResult, { ok: true }> }) {
  const s = sizeStatement(r);
  return (
    <>
      <p className={`mt-1 ${s.tone === 'ok' ? 'text-muted' : 'text-ink'}`} data-state={r.sizes.firstTransactions === 1 ? 'one' : 'two'}>
        {s.text}
      </p>
      <p className="mt-2 text-xs text-muted">
        The creation and the rules alone are {r.sizes.createAndRules} bytes of the {TRANSACTION_LIMIT}. {r.transactions} transactions in all, counting the accounts for every shard and bucket. Each is signed in your wallet, one after the other.
      </p>
    </>
  );
}

function BidderView({ view, active }: { view: ViewItem[]; active: boolean }) {
  return (
    <section className="rounded-lg border border-border p-4" aria-label="What bidders will see" data-testid="bidder-view">
      <p className="font-medium">What bidders will see</p>
      {!active || view.length === 0 ? (
        <p className="mt-1 text-sm text-muted">With no rules, bidders see the plain call: the grid, the window, the guards above and the fee.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">This is written from the rules as they will be committed, not from the form, so it says what the program will do for a bidder.</p>
          <ul className="mt-3 space-y-3">
            {view.map((v) => (
              <li key={v.id} className="rounded-lg bg-surface p-3 text-sm" data-testid={`view-${v.id}`}>
                <p className="font-medium">{v.title}</p>
                <p className="mt-0.5 text-muted">{v.text}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
