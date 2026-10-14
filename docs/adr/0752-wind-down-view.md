# ADR-0752: The wind-down window as a timeline

Status: accepted (2026-10-14). Builds on ADR-0474.

## Decision

The public treasury page shows the wind-down as four steps (the spending attestation lapses, anyone triggers the liquidation, holders redeem, anyone sweeps the rest once) with the state of each, a countdown to the next change, and what a holder can do now. `windDownView` is a pure function of the treasury's reads and the clock and is tested for every state: active, lapse inside the grace period, lapse past it, redeeming, sweepable, swept, a treasury extended without a window, the first release and an extension that could not be read (in which case the page says nothing about the window).

A holder sees what their coins redeem for at the snapshot, rounded down as the program does, and redeems all or some of them; an amount above what the wallet holds or one that would round is refused in words. Anyone may trigger a liquidation once the grace period is over and sweep after the window, each only when the program would accept it, the sweep only to the recovery account fixed at extension. After the sweep the page says that redemption is closed.

Funds are never pushed to holders. Redemption burns the holder's coins, so it needs their signature; the page says so in the step that describes the window.

## Not covered

The window is at least 180 days and cannot be run on a real clock here: the browser runs set the harness's treasuries at each point of it.
