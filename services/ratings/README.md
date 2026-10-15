# @opening-cross/ratings

What happened afterwards (V5, ADR-0953). One command per job, each safe to repeat; state in `STATE_DIR`.

| Command | Does |
|---|---|
| `watch [secs=20]` | Polls the launch feed and records new launches; reads the 1-day and 7-day outcomes of launches whose horizon has just passed |
| `index [days=7]` | Prints the cross-venue venture index with its bounds and its collection coverage |
| `outcomes` | Writes `rating_outcomes` for rated crosses whose horizon has passed, from a price source (needs `DATABASE_URL`, `RPC_URL`) |
| `survival [days=30]` | Records whether rated crosses' tokens were alive at the horizon |
| `bars-input [dir]` | Exports the observations the release bars are scored on |

A launch is followed forward from first sight; the index is a sample, and says so. A look made late is recorded `missed`, never read as the price at the horizon.
