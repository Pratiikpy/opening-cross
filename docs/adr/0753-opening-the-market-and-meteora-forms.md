# ADR-0753: Opening a market and Meteora's programs from the settle page

Status: accepted (2026-10-14). Builds on ADR-0482 to ADR-0485 and ADR-0701.

## Decision

The settle page opens the market of a cross that printed: the DBC continuation (locked or not), a DAMM v2 pool (plain, batch-opened, with an Alpha Vault, with its liquidity locked), a DLMM pair (plain, batch-opened, with a Token Badge for either mint) and a Raydium pool. It also runs the Alpha Vault of a batch-opened pool (create, deposit, fill, claim, take back what was not used), Met Lock (lock tokens for a recipient, look up an escrow, claim) and Dynamic Fee Sharing (create a vault, fund, claim, hand a DAMM v2 position to it, pull its fees in). Each form is the body of a W3E route and is checked on the page for what the page can know (a start that is closer than the batch window plus the time to land, a fee that does not decay, an Alpha Vault with no start, an amount that would round, weights that are not whole numbers) and by the API and the program for the rest.

`GET /v1/crosses/:address/venues` decides what is offered: a form is off, with the reason, when the cross has not settled, did not print, or the venue exists already; and when the wallet is not the cross's creator. The DBC form starts from the locked, compounding design that tests/core run against the real binaries and sends whatever JSON the person leaves in the box; the API names every departure from the locked design. A new account that must sign (a Met Lock's base, a fee vault's base) is a keypair made in the browser for the one action; it holds nothing and is not stored.

The DBC creator and partner fee bridges are not offered: the program that would route them cannot, for a pool this protocol opens, without stranding the creator's liquidity (ADR-0701). The page says so next to the payouts that do work.

## Not covered

A DAMM v2 position's vesting schedule (`lock.vest`) needs the pool's liquidity, which is known only once the pool is built; the form offers locking all of the liquidity but not vesting it. The DLMM Alpha Vault fill is not built. The Presale Vault is not integrated. No transaction of the extended `cross_settle` ran against a program: the browser runs decode what the wallet signs.
