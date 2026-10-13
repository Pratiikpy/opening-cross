// The monitor: runs the checks, decides, and announces.
//
// Decision rule, in full:
//   * A CRITICAL finding is acted on only after the same finding (same check, same subject) has been seen on `consecutive`
//     passes in a row. One pass can be wrong (two reads of a moving chain, a rate-limited answer); several in a row are not.
//   * Acting means pausing new crosses and new orders with the guardian key (cross_core `set_paused(true)`), and only when the
//     monitor is armed. Unarmed, it records what it WOULD have done. A pause blocks nothing that returns money: reveals, clears,
//     claims, refunds and finalize all keep working (INVARIANTS I11).
//   * It never unpauses. Reopening the protocol after an incident is a person's decision.
//   * A check that fails to run is reported as a warning; it never counts towards a pause (no answer is not evidence).
//   * Warnings and info are announced once per subject until they clear, so a long-lived problem does not repeat every pass.
import type { Check, CheckContext, Finding, Notifier, Rpc } from './types.js';

export interface PauseAction {
  /** Whether the protocol is paused right now. */
  isPaused(): Promise<boolean>;
  /** Sends `set_paused(true)` signed by the guardian and returns the transaction signature once it is confirmed. */
  pause(): Promise<{ signature: string }>;
}

export type MonitorOptions = {
  rpc: Rpc;
  checks: readonly Check[];
  notifier: Notifier;
  /** Null means dry-run: decisions are recorded, nothing is sent. */
  pause: PauseAction | null;
  /** Passes in a row a critical finding must persist before the monitor acts on it. */
  consecutive?: number;
  clock?: () => number;
};

export type Decision =
  | { kind: 'would-pause'; findings: Finding[]; reason: string }
  | { kind: 'paused'; findings: Finding[]; signature: string }
  | { kind: 'already-paused'; findings: Finding[] }
  | { kind: 'pause-failed'; findings: Finding[]; error: string };

export type PassResult = { findings: Finding[]; decision: Decision | null; checkErrors: string[] };

const keyOf = (f: Finding) => `${f.check}|${f.subject}`;

export class Monitor {
  private readonly o: Required<Pick<MonitorOptions, 'consecutive'>> & MonitorOptions;
  private readonly streak = new Map<string, number>();
  private readonly announced = new Set<string>();
  private acted = false;
  private lastPaused: boolean | null = null;

  constructor(o: MonitorOptions) {
    this.o = { consecutive: 3, ...o };
    if (!Number.isInteger(this.o.consecutive) || this.o.consecutive < 1) throw new RangeError('consecutive must be a positive integer');
  }

  private now(): number {
    return this.o.clock?.() ?? Math.floor(Date.now() / 1000);
  }

  async pass(): Promise<PassResult> {
    const at = this.now();
    const memo = new Map<string, Promise<unknown>>();
    const ctx: CheckContext = { rpc: this.o.rpc, now: at, memo: <T>(key: string, fn: () => Promise<T>) => (memo.get(key) as Promise<T> | undefined) ?? (memo.set(key, fn()), memo.get(key) as Promise<T>) };
    const findings: Finding[] = [];
    const checkErrors: string[] = [];
    for (const check of this.o.checks) {
      try {
        findings.push(...(await check.run(ctx)));
      } catch (e) {
        const message = `${check.name} could not run: ${e instanceof Error ? e.message : String(e)}`;
        checkErrors.push(message);
        findings.push({ check: 'monitor', subject: `check-failed:${check.name}`, severity: 'warning', message, evidence: { check: check.name } });
      }
    }

    // Streaks: a critical finding that is present again counts one more; one that is gone starts over.
    const criticalNow = new Set(findings.filter((f) => f.severity === 'critical').map(keyOf));
    for (const k of [...this.streak.keys()]) if (!criticalNow.has(k)) this.streak.delete(k);
    for (const k of criticalNow) this.streak.set(k, (this.streak.get(k) ?? 0) + 1);

    // Announce what is new. A critical finding is announced on every pass it persists: it is the one thing that must not go quiet.
    const present = new Set(findings.map(keyOf));
    for (const k of [...this.announced]) if (!present.has(k)) this.announced.delete(k);
    for (const f of findings) {
      const k = keyOf(f);
      if (f.severity === 'critical' || !this.announced.has(k)) {
        this.announced.add(k);
        await this.o.notifier.notify({ kind: 'finding', at, body: { ...f, streak: this.streak.get(k) ?? 0, needed: f.severity === 'critical' ? this.o.consecutive : null } });
      }
    }

    // Report a pause someone else made or lifted, so the log is never wrong about the state of the protocol.
    if (this.o.pause) {
      const paused = await this.o.pause.isPaused().catch(() => null);
      if (paused !== null && this.lastPaused !== null && paused !== this.lastPaused) {
        await this.o.notifier.notify({ kind: 'incident', at, body: { event: paused ? 'protocol paused' : 'protocol unpaused', by: 'not this monitor' } });
      }
      if (paused !== null) this.lastPaused = paused;
    }

    const confirmed = findings.filter((f) => f.severity === 'critical' && (this.streak.get(keyOf(f)) ?? 0) >= this.o.consecutive);
    let decision: Decision | null = null;
    if (confirmed.length > 0 && !this.acted) {
      decision = await this.decide(confirmed, at);
      if (decision.kind !== 'pause-failed' && decision.kind !== 'would-pause') this.acted = true;
      // A dry run keeps saying so while the condition lasts; a failed pause is retried on the next pass.
    }
    return { findings, decision, checkErrors };
  }

  private async decide(confirmed: Finding[], at: number): Promise<Decision> {
    const reason = confirmed.map((f) => f.message).join('; ');
    if (!this.o.pause) {
      const d: Decision = { kind: 'would-pause', findings: confirmed, reason };
      await this.o.notifier.notify({ kind: 'decision', at, body: { decision: d.kind, reason, note: 'dry run: the monitor is not armed and sent nothing' } });
      return d;
    }
    try {
      if (await this.o.pause.isPaused()) {
        const d: Decision = { kind: 'already-paused', findings: confirmed };
        await this.o.notifier.notify({ kind: 'decision', at, body: { decision: d.kind, reason } });
        return d;
      }
      const sent = await this.o.pause.pause();
      // The decision is only "paused" if the chain says so.
      if (!(await this.o.pause.isPaused())) throw new Error(`transaction ${sent.signature} confirmed but the protocol is not paused`);
      const d: Decision = { kind: 'paused', findings: confirmed, signature: sent.signature };
      await this.o.notifier.notify({ kind: 'incident', at, body: { event: 'protocol paused by the monitor', signature: sent.signature, reason, findings: confirmed } });
      return d;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.o.notifier.notify({ kind: 'decision', at, body: { decision: 'pause-failed', error, reason } });
      return { kind: 'pause-failed', findings: confirmed, error };
    }
  }
}
