# Weekly update video outline (1 minute each)

Colosseum FAQ: weekly updates are not strictly required, but strongly recommended: "a concise, one-minute video highlighting progress and notable challenges from the previous week". None exist for 14 Sep to 4 Oct. Do not record backdated updates. Record the first one now, covering 5 to 12 October, and keep a weekly cadence while judging runs (winners are announced by 5 Dec 2026).

## Template (about 150 words spoken)

1. 0:00 to 0:10: Name and week. One sentence: the number that moved.
2. 0:10 to 0:35: What shipped, shown on screen (one live page or one transaction, never a slide).
3. 0:35 to 0:50: What went wrong and what you did (a real defect and its fix).
4. 0:50 to 1:00: Next week's single commitment and one ask.

## Update 1 (5 to 12 October): content, all sourced

| Segment | Content | Source |
|---|---|---|
| Moved | Five programs deployed on devnet, equal to local builds byte for byte | `docs/evidence/L4-verifiable-build.md` section 3 |
| Shipped | The Meteora continuation proved on devnet: DBC, DAMM v2, DLMM pools opened at the clearing price | `A1`, `A2`, `A3` evidence |
| Shipped | Backend on AWS and web on Vercel; a user's whole path run on the deployed stack | `W2-live-deployment.md` |
| Went wrong | Public devnet RPC throttled landing latency: p90 17,652 ms against a 5,000 ms target. A cross could not finalize unless fee accounts existed; fixed and regression-tested | `DP13-devnet-latency.md`, `W2-live-deployment.md` defect 1 |
| Went wrong | The landing page tile for crosses that did not print reads 0 although the verifier sweep lists no-print crosses; say this only if the live tile has been fixed by then (check it first) | README "Defects found while preparing" |
| Next | One real commitment from the founder (HUMAN), and the ask: testers and a first issuer | `docs/HUMAN_TASKS.md` H8 |

## Later updates (pick from the rows that are done, with evidence)

An external audit engagement (H6), the repository made public (H21), first external testers (H8), a paid RPC and the latency re-measure (H7, H20), Arcium benchmark (H17), Android device run (H19).
