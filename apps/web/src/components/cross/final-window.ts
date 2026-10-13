// The last stretch of an open call, for a notice with a real countdown. This is a display rule and nothing on chain: the program
// has no coarse or hidden final window, so an order placed in these minutes is treated exactly like any other.

/** The notice starts when this much of the call is left: a quarter of it, and never more than ten minutes. */
export const FINAL_WINDOW_MAX_SECONDS = 600n;

export type FinalWindow = { active: boolean; remaining: bigint; length: bigint };

export function finalWindow(openTs: string | bigint, closeTs: string | bigint, now: bigint): FinalWindow {
  const open = BigInt(openTs);
  const close = BigInt(closeTs);
  const span = close > open ? close - open : 0n;
  const quarter = span / 4n;
  const length = quarter < FINAL_WINDOW_MAX_SECONDS ? quarter : FINAL_WINDOW_MAX_SECONDS;
  const remaining = close - now;
  return { active: length > 0n && remaining > 0n && remaining <= length && now >= open, remaining: remaining > 0n ? remaining : 0n, length };
}
