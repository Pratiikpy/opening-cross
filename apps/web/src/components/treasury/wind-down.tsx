'use client';

import { useEffect, useState } from 'react';
import { useClock } from '@/components/calendar/use-clock';
import { Text } from '@/components/issue-wizard/fields';
import { WalletAction } from '@/components/issuer/issuer-action';
import { Pill } from '@/components/issuer/treasury-ui';
import { apiRead } from '@/lib/issuer-data';
import { readMintFull } from '@/lib/issuer-chain';
import { atomsOf } from '@/lib/issuer-treasury-console';
import { readHeld } from '@/lib/series-load';
import { type WindDetail, type WindExt, type WindView, entitlement, windDownView } from '@/lib/winddown';
import { duration } from '@/lib/treasury';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const STEP_TONE = { done: 'ok', now: 'warn', next: 'info', never: 'info' } as const;
const STEP_TEXT = { done: 'Done', now: 'Now', next: 'Not yet', never: 'Never' } as const;
const PHASE_TONE = { active: 'info', lapsing: 'warn', redeeming: 'warn', sweepable: 'block', swept: 'info' } as const;
const PHASE_TEXT = { active: 'Active', lapsing: 'Lapsed', redeeming: 'Redemption open', sweepable: 'Window over', swept: 'Wound down' } as const;

/**
 * The wind-down as a timeline: from the lapse of the spending attestation, through the liquidation and the redemption window, to the sweep.
 * Read from the treasury's own reads; the holder can see what their coins redeem for and redeem them, and anyone can trigger or sweep when
 * the program allows it. Nothing here is offered that the program would refuse.
 */
export function WindDown({ treasury, coinMint, quoteDecimals, detail }: { treasury: string; coinMint: string; quoteDecimals: number; detail: WindDetail }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const now = useClock(Math.floor(Date.now() / 1000));
  const [rev, setRev] = useState(0);
  const [ext, setExt] = useState<WindExt | null | undefined>(undefined);
  const [live, setLive] = useState(detail);
  const [coin, setCoin] = useState<{ decimals: number; program: string } | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [amount, setAmount] = useState('');

  useEffect(() => {
    let on = true;
    void Promise.all([apiRead<WindExt>(`/v1/treasuries/${treasury}/ext`), apiRead<{ state: 'Active' | 'Liquidating'; lapse: WindDetail['lapse']; snapshot: WindDetail['snapshot']; balances: { vault: string | null }; history: WindDetail['history'] }>(`/v1/treasuries/${treasury}`)]).then(([e, d]) => {
      if (!on) return;
      setExt(e.ok ? e.data : null);
      if (d.ok) setLive({ state: d.data.state, lapse: d.data.lapse, snapshot: d.data.snapshot, balances: { vault: d.data.balances.vault }, history: d.data.history });
    });
    return () => {
      on = false;
    };
  }, [treasury, rev]);
  useEffect(() => {
    let on = true;
    void readMintFull(coinMint).then((m) => on && setCoin(m.ok ? { decimals: m.decimals, program: m.program } : null));
    return () => {
      on = false;
    };
  }, [coinMint]);
  useEffect(() => {
    if (!wallet || !coin) {
      setHeld(null);
      return;
    }
    let on = true;
    void readHeld(wallet, coinMint, coin.program).then((h) => on && setHeld(h.ok ? h.amount : null));
    return () => {
      on = false;
    };
  }, [wallet, coin, coinMint, rev]);

  if (ext === undefined) {
    return (
      <section aria-labelledby="winddown-h" className="mt-12">
        <h2 id="winddown-h" className="text-2xl font-semibold tracking-tight">
          Wind-down
        </h2>
        <p role="status" className="mt-3 text-sm text-muted">
          Reading the wind-down window…
        </p>
      </section>
    );
  }
  const v: WindView = windDownView(live, ext, now);
  const liquidating = live.state === 'Liquidating';
  const q = (atoms: bigint) => `${formatAtoms(atoms, quoteDecimals)} quote`;
  const entitled = held !== null ? entitlement(held, live) : null;
  const parsed = amount.trim() === '' ? null : atomsOf(amount, coin?.decimals ?? null, 'The amount');
  const over = parsed !== null && parsed.ok && held !== null && BigInt(parsed.atoms) > held;
  const a = over ? ({ ok: false, error: `This wallet holds only ${formatAtoms(held!, coin?.decimals ?? 0)} coins.` } as const) : parsed;
  const amountAtoms = a === null ? (held !== null && held > 0n ? held.toString() : null) : a.ok ? a.atoms : null;
  const sweepOk = v.phase === 'sweepable';
  const triggerOk = !liquidating && v.phase === 'lapsing' && live.lapse.graceEndsAt !== null && now >= Number(live.lapse.graceEndsAt);
  const reload = () => setRev((r) => r + 1);

  return (
    <section aria-labelledby="winddown-h" className="mt-12" data-testid="wind-down" data-phase={v.phase} data-mode={v.mode}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="winddown-h" className="text-2xl font-semibold tracking-tight">
          Wind-down
        </h2>
        <Pill tone={PHASE_TONE[v.phase]} testId="winddown-phase">
          {PHASE_TEXT[v.phase]}
        </Pill>
      </div>
      <p className="mt-3 max-w-2xl text-sm" data-testid="winddown-headline">
        {v.headline}
      </p>
      {v.countdown ? (
        <p className="mt-2 text-sm text-muted" role="timer" data-testid="winddown-countdown">
          {duration(String(Math.max(0, v.countdown.secs)))} {v.countdown.label}.
        </p>
      ) : null}

      <ol className="mt-5 space-y-3" data-testid="winddown-steps">
        {v.steps.map((s, i) => (
          <li key={s.id} className="flex gap-4 rounded-[var(--radius-card)] border border-border p-4" data-testid={`step-${s.id}`} data-state={s.state}>
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs" aria-hidden="true">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{s.title}</p>
                <Pill tone={STEP_TONE[s.state]}>{STEP_TEXT[s.state]}</Pill>
              </div>
              <p className="mt-1 text-sm text-muted">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>

      {v.holder.length > 0 ? (
        <div className="mt-5 rounded-[var(--radius-card)] border border-border p-5" data-testid="winddown-holder">
          <h3 className="font-medium">What you can do</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            {v.holder.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {v.phase !== 'swept' ? (
            <div className="mt-4 space-y-3">
              {!wallet ? (
                <p className="text-sm text-muted">Connect the wallet that holds this treasury’s coins to see what they redeem for.</p>
              ) : held === null ? (
                <p className="text-sm text-muted" role="status">
                  Reading your coins…
                </p>
              ) : held === 0n ? (
                <p className="text-sm text-muted" data-testid="no-coins">
                  This wallet holds none of this treasury’s coins, so there is nothing for it to redeem.
                </p>
              ) : (
                <>
                  <p className="text-sm" data-testid="entitlement">
                    You hold {formatAtoms(held, coin?.decimals ?? 0)} coins. At the snapshot they redeem for {entitled !== null ? <span className="font-mono">{q(entitled)}</span> : 'an amount the snapshot does not give yet'}: your share of the vault, rounded down.
                  </p>
                  <div className="max-w-xs">
                    <Text label="Coins to redeem" value={amount} onChange={setAmount} inputMode="decimal" placeholder={formatAtoms(held, coin?.decimals ?? 0)} error={a && !a.ok ? a.error : undefined} hint="Empty: all of them." />
                  </div>
                  <div className="max-w-sm">
                    <WalletAction
                      account={account ?? null}
                      label="Redeem"
                      path={`/v1/treasuries/${treasury}/tx/redeem`}
                      testId="redeem"
                      disabled={!liquidating || amountAtoms === null}
                      disabledReason={!liquidating ? 'Redemption opens when the treasury liquidates.' : 'Enter an amount.'}
                      body={() => ({ holder: wallet, amount: amountAtoms })}
                      onDone={reload}
                    />
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {!liquidating ? (
          <div data-testid="trigger-box">
            <WalletAction account={account ?? null} label="Trigger the liquidation" variant="secondary" path={`/v1/treasuries/${treasury}/tx/trigger-liquidation`} testId="trigger-liquidation" disabled={!triggerOk} disabledReason={v.phase === 'active' ? 'The spending attestation has not lapsed, so there is nothing to liquidate.' : 'The grace period is still running.'} connectHint="Anyone can do this once the grace period is over. Connect a wallet to pay the fee." body={() => ({ payer: wallet })} onDone={reload} />
          </div>
        ) : v.mode === 'window' ? (
          <div data-testid="sweep-box">
            <WalletAction
              account={account ?? null}
              label="Sweep what is left"
              variant="secondary"
              path={`/v1/treasuries/${treasury}/tx/sweep-unclaimed`}
              needs="treasury"
              what="The wind-down window"
              testId="sweep-unclaimed"
              disabled={!sweepOk}
              disabledReason={v.phase === 'swept' ? 'Already swept.' : 'Holders can still redeem; the sweep opens when the window ends.'}
              connectHint={`Anyone can do this once the window is over. The money goes to ${v.recovery ? shortAddress(v.recovery) : 'the recovery account'} and nowhere else. Connect a wallet to pay the fee.`}
              body={() => ({ payer: wallet })}
              onDone={reload}
            />
            <p className="mt-1 text-xs text-muted">{v.recovery ? `Only to ${v.recovery}, fixed when the treasury was extended. Redemption stops the moment this lands.` : ''}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
