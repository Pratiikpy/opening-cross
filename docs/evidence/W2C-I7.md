# W2C-I7 (with M12, R13), and the S12, S9 and M3 leftovers

## I7, R13 local-currency rails and languages: HUMAN

Built: the suggested fiat currency follows the browser locale (`fiatFromLocale`, `lib/holder-pay.ts`, tested) and goes into the card-purchase link when a provider is configured. Not built: translated copy. A language switch over this much copy needs a native reviewer for each language before anything ships under the product's name, and a rails partner for local currencies has to exist (availability NOT VERIFIED). The human steps are HH8.

## M12 social-login claim: HUMAN

An email or social login that creates a wallet needs a provider's account and SDK (HH4). The passkey wallet (W2C-I2.md) is the part that needs no provider. A "claim by email" for a non-crypto issuer's allocation also needs a custody or escrow design for tokens sent to an address that has no wallet yet, which is a program and a legal question (H2), and is not built.

## S12 launch replay

`/replay` and the Replay tab of a cross exist and were part of the route audit (W2C-M10). The FEATURE_STATUS line "no dedicated replay page" is out of date.

## S9 Opening Bell events

Unchanged and BUILT (`W5-calendar-live.md`); Follow now sends a server-side reminder for a followed cross or market (W2C-T2.md).

## M3 follow-up: times for Cleared and Finalized

The timeline's "The API serves no timestamps for Cleared and Finalized" gap is closed: the stages read the moments the cross cleared and finalized from the event log (`GET /v1/replay/:address`: `CrossCleared` at 15:04:43, `CrossFinalized` at 15:05:03 for cross `3S7V…FLkM` on the live index), and say "Time not published" only when the log has none. `apps/web/test/cross-timeline.test.ts` has a new test for it (14 tests in the file).

## M4 follow-up

No gap remained that this workstream could close: the price impact is still shown only where the page reproduces the API's indicative price, by design.
