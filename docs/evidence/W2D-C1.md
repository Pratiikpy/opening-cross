# W2D-C1: oracle median and off-hours band (C1, VM9, C3)

Outcome: **BUILT-LOCAL**. Design: ADR-0459.

The cross's own Pyth guard plus up to two extra feeds: the reference is the median of the usable prices (fresh, fully verified, right feed), the guard needs a quorum and, optionally, a maximum spread between the oracles (`OracleDisagreement`), and the divergence bound widens by `off_hours_widen_bps` while no session of the cross's calendar is open. A single feed with no set behaves as before (the 5 pre-existing oracle tests pass unchanged). A cross on a calendar may only name feeds the calendar approves.

Tests (`rules-oracle.test.ts`, 11): the median ignores an outlier; the median moves the verdict; five quorum cases; disagreement; a missing extra account; seven inconsistent sets; a 5% divergence prints off hours and is refused while a session is open; the calendar must approve extra feeds. Rust unit tests for the median.

Not covered: Chainlink, Switchboard or any non-Pyth source; a real Pyth equity feed on devnet (H11); the oracle accounts in the tests are hand-built `PriceUpdateV2` accounts in the receiver's layout.

FEATURE_STATUS.md row wanted: `| C1, VM9, C3 listing cross with an oracle median | BUILT-LOCAL | Median of up to three Pyth feeds, quorum, maximum spread, a band that widens outside the calendar's sessions; 11 LiteSVM tests (`W2D-C1.md`, ADR-0459) | Pyth only; no real equity feed run (H11; the DP15 pull proof still fails with a 401 for NVDA); devnet proof pending funding; not audited |`
