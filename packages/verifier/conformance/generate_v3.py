#!/usr/bin/env python3
"""Writes conformance/v3.json: vectors for the parts of a cross with rules that are not the clearing rule.

    python packages/verifier/conformance/generate_v3.py

Source of the expected values, stated plainly: they are computed here, with Python integers, from the specification in
docs/adr/0452-hard-to-game-ending.md and from the program source (programs/cross_core/src/ext.rs, draw.rs, lock.rs, lib.rs `marginal`).
They are NOT produced by running the Rust code: `cargo` was not built on the machine that wrote this file, and the task forbade a build.
The placement cases that carry the tag `rust-unit-test` repeat, number for number, the assertions of the unit test
`placement_maps_the_clock_to_a_bucket_in_order_and_never_past_the_last` in ext.rs. `clearing-core` does not compute any of these functions,
so `cargo run -p clearing-core --example conformance_vectors_v2` (which writes v2.json) has nothing to say about them.

A second implementation (packages/verifier/src/ending.ts) is run against every case by test/ending.test.ts, and a third (the helpers of
@opening-cross/cross-core-client) by the same test, so a disagreement between any two shows.
"""
import hashlib
import json
import os

MAX_EXT_SHARDS = 8
NO_BUCKET = 255


def seed(label: str) -> bytes:
    return hashlib.sha256(("opening-cross/conformance/v3/" + label).encode()).digest()


def word(s: bytes, at: int) -> int:
    return int.from_bytes(s[at : at + 8], "little")


def placement(ending_secs: int, buckets: int, epoch: int, close: int, now: int):
    if epoch > 0:
        return epoch, NO_BUCKET
    if ending_secs == 0:
        return 0, NO_BUCKET
    start = close - ending_secs
    if now < start:
        return 0, NO_BUCKET
    b = (now - start) * buckets // ending_secs
    return 0, min(b, max(buckets - 1, 0))


def last_bucket(buckets: int, end_bucket: int) -> int:
    return max(buckets - 1, 0) if end_bucket == NO_BUCKET else end_bucket


def required_aux(ending_secs: int, buckets: int, end_bucket: int, epoch: int, shards: int) -> int:
    mask = 0
    if ending_secs > 0:
        for b in range(last_bucket(buckets, end_bucket) + 1):
            mask |= 1 << b
    if epoch > 0:
        for j in range(min(max(shards, 1), MAX_EXT_SHARDS)):
            mask |= 1 << (8 + j)
    return mask


def vested(amount: int, start: int, cliff: int, vest: int, now: int) -> int:
    unlock = start + cliff
    if now < unlock:
        return 0
    if vest == 0:
        return amount
    return min(amount, amount * (now - unlock) // vest)


cases = []

# --- placement: the numbers of the Rust unit test, then a sweep
for now in (919, 920, 939, 940, 999, 5000):
    e, b = placement(80, 4, 0, 1000, now)
    cases.append({"kind": "placement", "tag": "rust-unit-test", "endingSecs": 80, "buckets": 4, "epoch": 0, "closeTs": "1000", "now": str(now), "expect": {"epoch": e, "bucket": b}})
cases.append({"kind": "placement", "tag": "rust-unit-test", "endingSecs": 0, "buckets": 0, "epoch": 0, "closeTs": "1000", "now": "999", "expect": {"epoch": 0, "bucket": NO_BUCKET}})
cases.append({"kind": "placement", "tag": "rust-unit-test", "endingSecs": 80, "buckets": 4, "epoch": 1, "closeTs": "1000", "now": "999", "expect": {"epoch": 1, "bucket": NO_BUCKET}})
for secs, buckets in ((997, 7), (300, 3), (3600, 8), (8, 8), (9, 2)):
    close = 1_000_000
    for t in range(0, secs + 12, max(secs // 23, 1)):
        now = close - secs + t - 5
        e, b = placement(secs, buckets, 0, close, now)
        cases.append({"kind": "placement", "tag": "sweep", "endingSecs": secs, "buckets": buckets, "epoch": 0, "closeTs": str(close), "now": str(now), "expect": {"epoch": e, "bucket": b}})

# --- required auxiliary shards
for ending_secs, buckets, end_bucket, epoch, shards in (
    (80, 4, NO_BUCKET, 0, 2),
    (80, 4, 0, 0, 2),
    (80, 4, 2, 0, 2),
    (80, 4, 3, 0, 2),
    (80, 4, 1, 1, 2),
    (80, 4, NO_BUCKET, 1, 3),
    (0, 0, NO_BUCKET, 0, 2),
    (0, 0, NO_BUCKET, 1, 5),
    (400, 8, 7, 1, 32),
    (400, 8, 0, 1, 1),
):
    cases.append({"kind": "required_aux", "endingSecs": ending_secs, "buckets": buckets, "endBucket": end_bucket, "epoch": epoch, "shards": shards, "expect": str(required_aux(ending_secs, buckets, end_bucket, epoch, shards))})

# --- a bucket the draw left out
for end_bucket in (NO_BUCKET, 0, 1, 2):
    for order_epoch, order_bucket in ((0, NO_BUCKET), (0, 0), (0, 1), (0, 2), (0, 3), (1, NO_BUCKET)):
        excluded = order_epoch == 0 and order_bucket != NO_BUCKET and order_bucket > last_bucket(4, end_bucket)
        cases.append({"kind": "excluded", "endingSecs": 80, "buckets": 4, "endBucket": end_bucket, "orderEpoch": order_epoch, "orderBucket": order_bucket, "expect": excluded})

# --- the draw: from a seed to a last bucket, an extension length and a lottery start
for i in range(24):
    s = seed(f"seed/{i}")
    for buckets in (2, 3, 5, 8):
        cases.append({"kind": "draw_end_bucket", "seed": s.hex(), "buckets": buckets, "expect": word(s, 0) % buckets})
    for lo, hi in ((60, 60), (60, 600), (1, 2), (3600, 604800)):
        cases.append({"kind": "draw_extension_secs", "seed": s.hex(), "minSecs": lo, "maxSecs": hi, "expect": lo + word(s, 8) % (hi - lo + 1)})
    for tickets in (1, 2, 6, 17, 4096):
        cases.append({"kind": "draw_lottery_start", "seed": s.hex(), "tickets": tickets, "expect": word(s, 16) % tickets})

# --- lock vesting
for amount, cliff, vest in ((1000, 0, 0), (1000, 10, 0), (1000, 10, 100), (7, 0, 3), (10**18, 86400, 365 * 86400), (1, 5, 10)):
    start = 2_000
    for now in (start - 1, start, start + cliff - 1, start + cliff, start + cliff + 1, start + cliff + vest // 2, start + cliff + vest, start + cliff + vest + 1000):
        for released in (0, amount // 3):
            v = vested(amount, start, cliff, vest, now)
            cases.append({"kind": "lock", "amount": str(amount), "released": str(released), "startTs": str(start), "cliffSecs": cliff, "vestSecs": vest, "now": str(now), "expect": {"vested": str(v), "releasable": str(max(v - released, 0))}})

out = {
    "schema": "opening-cross/conformance/v3",
    "rule": "docs/adr/0452-hard-to-game-ending.md, docs/adr/0453-identity-limits-and-allocation-classes.md, docs/adr/0454-lockups-and-issuer-neutrality.md",
    "generator": "python packages/verifier/conformance/generate_v3.py",
    "source": "Computed with Python integers from the specification and the program source; NOT generated by running the Rust code (cargo was not built on the machine that wrote this file). Placement cases tagged rust-unit-test repeat the assertions of the Rust unit test of CrossExt::placement.",
    "units": "times in seconds, amounts in base atoms; integers that can exceed 2^53 are decimal strings; a seed is 32 bytes as 64 hex characters; bucket 255 is 'not in an ending bucket'",
    "cases": cases,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "v3.json")
with open(path, "w", encoding="utf8", newline="\n") as f:
    json.dump(out, f, separators=(",", ":"))
    f.write("\n")
print(f"{len(cases)} cases -> {path}")
