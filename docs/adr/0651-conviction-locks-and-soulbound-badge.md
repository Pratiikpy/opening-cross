# ADR-0651: Conviction is a lock with no exit and a soulbound badge, `cross_conviction` (S7)

Status: accepted (2026-10-14) · Supersedes the "not built" outcome of ADR-0414 for S7

## Context

PRODUCT_FEATURES [S7] wants a reputation "earned only by holding through lockups". A balance read cannot show that tokens were held throughout: a wallet that held on day 1 and day 90 may have sold on day 40 and bought back, so a score computed from snapshots rewards timing and can be gamed. The only proof is a lock the holder enters and cannot leave early (`W2C-S7.md`).

## Decision

A new program, `cross_conviction`, with no change to any deployed program.

- `lock_tokens(nonce, amount, unlock_ts)` moves tokens into a vault (the associated token account of a `Lock` PDA, `["lock", holder, mint, nonce]`). The unlock time is between one day and four years away. The lock records what the vault actually received, so a token that takes a transfer fee is not credited for more than arrived.
- There is **no instruction that moves the vault's tokens before `unlock_ts`**: not for the holder, not for the program's authority. `unlock` (holder only) returns them after the time and closes the vault. The program upgrade authority could in principle replace the code; that is true of every program here and is the Squads handover (H13), not something this program can promise.
- `init_badge` creates, once per holder and token, a Token-2022 mint (`["badge", holder, mint]`) with the **NonTransferable** extension, zero decimals, and a program PDA as mint authority. `claim_badge` (holder only, after `unlock_ts`, once per lock) mints `floor(amount * (unlock_ts - locked_at) / (86,400 * 10^decimals))` badge atoms: whole token-days. The badge is a credential in the holder's wallet, readable by any program as a token balance; it cannot be sent (the token program refuses with "Transfer is disabled for this mint") and only its holder can burn it.
- Badges add up across locks. A lock too small to earn one token-day is refused a badge (`TooSmallForABadge`) but still comes back. `close_lock` returns the lock's rent after both the tokens and the badge have been taken.
- No points, tiers, payouts or loyalty farming: the badge is priority-signalling material, as the specification's "Not doing" list requires.

## Not built, and why

- A `cross_gate` pass rule that reads the badge ("at least N token-days of conviction in this issuer's coin") is not in this ADR: it changes `cross_gate`/`cross_core` account lists, and a gate can already be served by the identity-pass route (an attester issues a pass to holders above a badge balance). The badge is the on-chain fact such an attester reads.
- A Token-2022 MetadataPointer on the badge mint (name, symbol, image in wallets). It needs a token-metadata account per badge mint; the mint is created with room for none. It can be added to a later version of the mint without touching locks.
- Transfer-hook mints as the locked token: `lock_tokens` forwards remaining accounts to the transfer, so a hooked mint works if the client supplies them; this is untested (see the evidence file).

## Consequences

- New program id `JAWUTTDhBQQ97w9YiPMv5sjsDxZab7AsSnc9L57zJjz6`, client `@opening-cross/cross-conviction-client`, 5 instructions, 4 events, 12 errors.
- The app layers add a "Lock to earn conviction" action on a holding and the badge on the portfolio (`docs/evidence/W3D-S7.md` lists what).
