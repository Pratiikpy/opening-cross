"""Run the ORIGINAL Python model (research/scripts/sim/sim.py) single-process on seeds 0..N-1 for the four
mechanisms compared in the TypeScript port, and write the same summary the TS runner prints.

    python packages/backtest/src/sniper/results/run_python_reference.py [out.json]

Needs numpy. Takes about 11 minutes (200 project runs and 600 memecoin runs per mechanism). It does not use
mc.py's multiprocessing pool. Seeds 0..199 / 0..599 reproduce research/data/r2/results_r3.json exactly
(for example P|pump sniper gain share 0.10506873597819039).
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "..", "research", "scripts", "sim"))
sys.path.insert(0, SIM)
from sim import SCEN_M, SCEN_P, simulate  # noqa: E402


def boot(x, n=1000):
    x = np.array(x)
    rng = np.random.default_rng(0)
    b = [x[rng.integers(0, len(x), len(x))].mean() for _ in range(n)]
    return float(x.mean()), float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))


out = {}
t0 = time.time()
for sc, n in ((SCEN_P, 200), (SCEN_M, 600)):
    for m in ("pump", "dbc_typ", "dbc_as", "uniform"):
        rs = [simulate(m, sc, s) for s in range(n)]
        ok = [r for r in rs if not r.get("failed")]
        key = f"{sc['name']}|{m}"
        out[key] = dict(
            runs=n,
            failed=n - len(ok),
            share=boot([r["sniper_gain_share"] for r in ok]),
            roi=boot([r["retail_roi"] for r in ok]),
            snsale=float(np.mean([r["sniper_share_sale"] for r in ok])),
            withgain=float(np.mean([r["sniper_pnl"] > 0 for r in ok])),
        )
        print(key, out[key], round(time.time() - t0), "s", flush=True)
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "python-reference-seed0.json"), "w"), indent=1)
