// The treasury wind-down (E7) as a person reads it: where the treasury is between "the spending attestation lapsed" and "the rest was swept",
// what a holder can still do, and when. Pure: the caller supplies the reads (GET /v1/treasuries/:address and /ext) and the clock.
//
// Rules of the program (docs/adr/0474-treasury-wind-down.md, docs/evidence/W2D-E7.md): once a treasury liquidates, holders redeem their share of
// the vault at the snapshot for at least 180 days. Only after that window can anyone sweep what is left, once, to a recovery account fixed when
// the treasury was extended. Funds are never pushed to holders: redemption burns the holder's coins, so it needs the holder's signature. A
// treasury extended without a window never sweeps, and redemption never expires. The first release (the program deployed today) has no window.
import { duration } from './treasury';
import { redemptionPayout } from './holder-value';
import { shortAddress } from './units';

export type WindDetail = {
  state: 'Active' | 'Liquidating';
  lapse: { lapsedSince: string | null; graceEndsAt: string | null };
  snapshot: { vault: string; supply: string } | null;
  balances: { vault: string | null };
  history: { redeemedPaid: string; redemptionCount: number } | null;
};
export type WindExt =
  | { extended: false }
  | { extended: true; terms: { windDown: { windowSecs: string; recovery: string } | null }; live: { windDown: { start: string; sweepOpensAt: string; swept: boolean } | null } };

export type Mode = 'first-release' | 'no-window' | 'window' | 'unknown';
export type Phase = 'active' | 'lapsing' | 'redeeming' | 'sweepable' | 'swept';
export type StepState = 'done' | 'now' | 'next' | 'never';
export type Step = { id: 'lapse' | 'liquidation' | 'redemption' | 'sweep'; title: string; when: number | null; state: StepState; text: string };
export type WindView = {
  mode: Mode;
  phase: Phase;
  headline: string;
  /** Seconds until the next change, when one is scheduled. */
  countdown: { label: string; secs: number } | null;
  steps: Step[];
  recovery: string | null;
  /** What a holder can still do, in the order they would do it. */
  holder: string[];
};

const n = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function windDownView(d: WindDetail, e: WindExt | null, now: number): WindView {
  const liquidating = d.state === 'Liquidating';
  const window = e && e.extended ? e.terms.windDown : null;
  const live = e && e.extended ? e.live.windDown : null;
  const mode: Mode = e === null ? 'unknown' : !e.extended ? 'first-release' : window ? 'window' : 'no-window';
  const lapsedAt = n(d.lapse.lapsedSince);
  const graceEnds = n(d.lapse.graceEndsAt);
  const winSecs = window ? Number(window.windowSecs) : null;
  const start = live ? Number(live.start) : null;
  const sweepAt = live ? Number(live.sweepOpensAt) : winSecs !== null && start !== null ? start + winSecs : null;
  const swept = live?.swept === true;

  let phase: Phase;
  if (!liquidating) phase = lapsedAt !== null ? 'lapsing' : 'active';
  else if (swept) phase = 'swept';
  else if (sweepAt !== null && now >= sweepAt) phase = 'sweepable';
  else phase = 'redeeming';

  const steps: Step[] = [];
  steps.push({
    id: 'lapse',
    title: 'The spending attestation lapses',
    when: lapsedAt,
    state: liquidating || lapsedAt !== null ? 'done' : 'next',
    text: lapsedAt !== null ? `Recorded at ${stamp(lapsedAt)}. The team can no longer spend, and a grace period starts.` : 'While the attestation is live the team spends within its allowance. If it lapses, the team can no longer spend and a grace period starts.',
  });
  steps.push({
    id: 'liquidation',
    title: 'Anyone triggers the liquidation',
    when: graceEnds,
    state: liquidating ? 'done' : lapsedAt !== null && graceEnds !== null && now >= graceEnds ? 'now' : 'next',
    text: liquidating
      ? 'The vault was snapshotted. Spending, staking, deposits and new proposals closed for good; unstaking, reclaiming votes, claiming and redeeming stay open.'
      : graceEnds !== null
        ? now >= graceEnds
          ? 'The grace period is over: anyone can trigger the liquidation now.'
          : `The grace period ends at ${stamp(graceEnds)}. From then on, anyone can trigger it.`
        : 'Once the attestation has lapsed and the grace period has passed, anyone can trigger it.',
  });
  if (mode === 'first-release') {
    steps.push({ id: 'redemption', title: 'Holders redeem', when: null, state: liquidating ? 'now' : 'next', text: 'This treasury runs the first release of the program, which has no wind-down window: redemption at the snapshot stays open and nothing is ever swept.' });
  } else if (mode === 'no-window') {
    steps.push({ id: 'redemption', title: 'Holders redeem', when: null, state: liquidating ? 'now' : 'next', text: 'This treasury was extended without a wind-down window, and that cannot be added now. Redemption at the snapshot never expires and nothing is ever swept.' });
  } else if (mode === 'window') {
    steps.push({
      id: 'redemption',
      title: `Holders redeem for at least ${duration(window!.windowSecs)}`,
      when: start,
      state: !liquidating ? 'next' : phase === 'redeeming' ? 'now' : 'done',
      text: liquidating ? `The window opened at ${start !== null ? stamp(start) : 'the liquidation'} and ${phase === 'redeeming' ? `closes at ${sweepAt !== null ? stamp(sweepAt) : 'a time this page could not read'}` : `closed at ${sweepAt !== null ? stamp(sweepAt) : 'a time this page could not read'}`}. Holders redeem their share of the vault by burning their coins; nothing is pushed to anyone.` : `Opens when the liquidation is triggered and lasts ${duration(window!.windowSecs)}. Holders redeem their share of the vault by burning their coins.`,
    });
    steps.push({
      id: 'sweep',
      title: 'Anyone sweeps what is left, once',
      when: sweepAt,
      state: swept ? 'done' : phase === 'sweepable' ? 'now' : 'next',
      text: swept ? `Swept to ${shortAddress(window!.recovery)}. Redemption is refused from here on.` : `Only after the window can the remainder be swept, and only to ${shortAddress(window!.recovery)}, an account fixed when the treasury was extended. Sweeping early is refused by the program.`,
    });
  }

  let headline: string;
  let countdown: WindView['countdown'] = null;
  switch (phase) {
    case 'active':
      headline = 'The treasury is active. Nothing is winding down.';
      break;
    case 'lapsing':
      headline = graceEnds !== null && now >= graceEnds ? 'The attestation lapsed and the grace period is over. Anyone can trigger the liquidation.' : 'The spending attestation has lapsed. The grace period is running.';
      if (graceEnds !== null && now < graceEnds) countdown = { label: 'until the liquidation can be triggered', secs: graceEnds - now };
      break;
    case 'redeeming':
      headline = mode === 'window' ? 'Liquidating. Holders can redeem; nothing can be swept yet.' : 'Liquidating. Holders can redeem at the snapshot, and redemption never expires.';
      if (mode === 'window' && sweepAt !== null) countdown = { label: 'until the redemption window ends', secs: sweepAt - now };
      break;
    case 'sweepable':
      headline = 'The redemption window is over. Anyone can sweep what is left to the recovery account.';
      break;
    case 'swept':
      headline = 'Wound down. The unclaimed remainder was swept to the recovery account and redemption is closed.';
      break;
  }

  const holder: string[] = [];
  if (liquidating) {
    if (phase === 'swept') holder.push('Redemption is closed. A holder who did not redeem in the window can no longer recover their share from the treasury.');
    else {
      holder.push('Redeem your coins for your share of the snapshot. It needs your signature because redeeming burns your coins.');
      if (mode === 'window' && phase === 'redeeming') holder.push('Redeem before the window ends: after the sweep the program refuses redemption.');
      if (phase === 'sweepable') holder.push('The window is over but nothing has been swept yet, so redemption still works. It stops the moment someone sweeps.');
    }
  }
  return { mode, phase, headline, countdown, steps, recovery: window?.recovery ?? null, holder };
}

const stamp = (secs: number): string => `${new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/** What `coins` redeem for at the snapshot, rounded down as the program does; null before a snapshot exists. */
export const entitlement = (coins: bigint, d: Pick<WindDetail, 'snapshot'>): bigint | null => redemptionPayout(coins, d.snapshot);
