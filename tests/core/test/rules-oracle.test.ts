// More than one oracle (ADR-0459): the median of the usable prices, a quorum, a bound on how far the oracles may
// disagree, a wider band outside the calendar's sessions, and a split or dividend that voids a print.
import { describe, expect, it } from 'vitest';
import { type Address, address, generateKeyPairSigner, lamports } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getInitializeMint2Instruction,
  getInitializeScaledUiAmountMintInstruction,
  getMintSize,
  getUpdateMultiplierScaledUiMintInstruction,
} from '@solana-program/token-2022';
import { getCreateCalendarInstruction } from '@opening-cross/cross-calendar-client';
import { CrossState, FLAG_GUARD_SCALED_UI, NoPrintReason, OrderSide } from '@opening-cross/sdk';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const RECEIVER = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const DISC = [34, 241, 35, 99, 157, 126, 244, 205];
const FEED_A = new Uint8Array(32).fill(7);
const FEED_B = new Uint8Array(32).fill(8);
const FEED_C = new Uint8Array(32).fill(9);
const DAY = 86_400n;

function priceUpdate(price: bigint, publishTime: bigint, feed: Uint8Array, full = true): Uint8Array {
  const b = Buffer.alloc(8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 * 6);
  let at = 0;
  Buffer.from(DISC).copy(b, at);
  at += 8 + 32;
  if (full) {
    b[at] = 1;
    at += 1;
  } else {
    b[at] = 0;
    b[at + 1] = 13;
    at += 2;
  }
  Buffer.from(feed).copy(b, at);
  at += 32;
  b.writeBigInt64LE(price, at);
  at += 8 + 8;
  b.writeInt32LE(-2, at);
  at += 4;
  b.writeBigInt64LE(publishTime, at);
  return new Uint8Array(b);
}

async function account(w: RulesWorld, data: Uint8Array): Promise<Address> {
  const acct = (await generateKeyPairSigner()).address;
  w.h.svm.setAccount({ address: acct, data, executable: false, lamports: lamports(10_000_000n), programAddress: RECEIVER, space: BigInt(data.length) });
  return acct;
}

const T = T0 + 100n;
const guard = { feedId: FEED_A, maxDivergenceBps: 300, maxStalenessSecs: 600 };

/** A reopen at 1.20 with sellers and buyers around it. */
async function reopen(w: RulesWorld, oracleSet: Parameters<RulesWorld['newRuledCross']>[0] extends infer O ? NonNullable<O extends { rules?: infer R } ? (R extends { oracleSet?: infer S } ? S : never) : never> : never, extra: { calendar?: Address; closeTs?: bigint } = {}) {
  const cross = await w.newRuledCross({
    oracle: guard,
    ...(extra.calendar ? { calendar: extra.calendar } : {}),
    ...(extra.closeTs ? { closeTs: extra.closeTs } : {}),
    rules: { oracleSet },
  });
  const s = await w.trader(0n, 1_000_000_000n);
  const b = await w.trader(10_000_000_000n);
  await w.place(cross, s, OrderSide.Sell, 1_200_000n, 1_000_000_000n);
  await w.place(cross, b, OrderSide.Buy, 1_200_000n, 1_000_000_000n);
  return cross;
}

describe('the median of several oracles', () => {
  it('uses the middle price, so one wild oracle does not decide', async () => {
    const w = await RulesWorld.createRules();
    const cross = await reopen(w, { extraFeeds: [FEED_B, FEED_C], quorum: 3 });
    const a = await account(w, priceUpdate(121n, T, FEED_A));
    const b = await account(w, priceUpdate(119n, T, FEED_B));
    const c = await account(w, priceUpdate(300n, T, FEED_C)); // an outlier
    const v = await w.settle(cross, a, [b, c]);
    expect(v.data.state).toBe(CrossState.Cleared);
  });

  it('moves the verdict when the median moves', async () => {
    const w = await RulesWorld.createRules();
    const cross = await reopen(w, { extraFeeds: [FEED_B, FEED_C], quorum: 3 });
    const a = await account(w, priceUpdate(100n, T, FEED_A));
    const b = await account(w, priceUpdate(100n, T, FEED_B));
    const c = await account(w, priceUpdate(121n, T, FEED_C));
    const v = await w.settle(cross, a, [b, c]); // median 100 against P* 120
    expect(v.data.state).toBe(CrossState.NoPrint);
    expect(v.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.OracleDivergence });
  });

  it('needs its quorum: a stale, partly verified or wrong-feed oracle does not count', async () => {
    for (const [stale, partial, wrongFeed, quorum, prints] of [
      [true, false, false, 2, true],
      [true, true, false, 2, false],
      [false, false, true, 2, true],
      [true, true, true, 1, true],
      [true, true, false, 3, false],
    ] as const) {
      const w = await RulesWorld.createRules();
      const cross = await reopen(w, { extraFeeds: [FEED_B, FEED_C], quorum });
      const a = await account(w, priceUpdate(121n, T, FEED_A));
      const b = await account(w, priceUpdate(121n, stale ? T - 10_000n : T, FEED_B));
      const c = await account(w, priceUpdate(121n, T, wrongFeed ? new Uint8Array(32).fill(1) : FEED_C, !partial));
      const v = await w.settle(cross, a, [b, c]);
      expect(v.data.state, JSON.stringify({ stale, partial, wrongFeed, quorum })).toBe(prints ? CrossState.Cleared : CrossState.NoPrint);
      if (!prints) expect(v.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.OracleUnavailable });
    }
  });

  it('does not print when the oracles disagree by more than the bound, even if the median is right', async () => {
    const w = await RulesWorld.createRules();
    const cross = await reopen(w, { extraFeeds: [FEED_B, FEED_C], quorum: 2, maxSpreadBps: 500 });
    const a = await account(w, priceUpdate(120n, T, FEED_A));
    const b = await account(w, priceUpdate(120n, T, FEED_B));
    const c = await account(w, priceUpdate(140n, T, FEED_C));
    const v = await w.settle(cross, a, [b, c]);
    expect(v.data.state).toBe(CrossState.NoPrint);
    expect(v.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.OracleDisagreement });
  });

  it('a cross cannot be settled without the extra oracle accounts it names', async () => {
    const w = await RulesWorld.createRules();
    const cross = await reopen(w, { extraFeeds: [FEED_B], quorum: 1 });
    const a = await account(w, priceUpdate(120n, T, FEED_A));
    w.h.setTime(cross.data.revealEndTs + 1n);
    const ixs = await w.settleIxs(w.view(cross.address), { oraclePrice: a, oracleAccounts: [] });
    for (const ix of ixs.slice(0, -1)) await w.h.send([ix], w.admin);
    expect(await w.h.fail([ixs[ixs.length - 1]!], w.admin)).toMatch(/OracleAccountMissing/);
  });

  it('rejects inconsistent oracle sets', async () => {
    const w = await RulesWorld.createRules();
    const bad = async (oracleSet: Parameters<typeof reopen>[1]) => reopen(w, oracleSet);
    await expect(bad({ extraFeeds: [FEED_A], quorum: 1 })).rejects.toThrow(/InvalidParams/); // the primary again
    await expect(bad({ extraFeeds: [FEED_B, FEED_B], quorum: 1 })).rejects.toThrow(/InvalidParams/);
    await expect(bad({ extraFeeds: [FEED_B], quorum: 3 })).rejects.toThrow(/InvalidParams/);
    await expect(bad({ extraFeeds: [FEED_B], quorum: 0 })).rejects.toThrow(/InvalidParams/);
    await expect(bad({ extraFeeds: [new Uint8Array(32)], quorum: 1 })).rejects.toThrow(/InvalidParams/);
    await expect(bad({ offHoursWidenBps: 100 })).rejects.toThrow(/InvalidParams/); // no calendar
    await expect(w.newRuledCross({ rules: { oracleSet: { extraFeeds: [FEED_B], quorum: 1 } } })).rejects.toThrow(/InvalidParams/); // no oracle guard
  });
});

describe('the band outside the calendar\'s sessions', () => {
  async function calendar(w: RulesWorld, feeds: Uint8Array[]) {
    const id8 = new Uint8Array(8);
    new DataView(id8.buffer).setBigUint64(0, 1n, true);
    const { getProgramDerivedAddress, getAddressEncoder } = await import('@solana/kit');
    const { CROSS_CALENDAR_PROGRAM_ADDRESS } = await import('@opening-cross/cross-calendar-client');
    const cal = (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(w.admin.address), id8] }))[0];
    // One session from T0+500 to T0+1000; the cross closes at its start.
    await w.h.send([getCreateCalendarInstruction({ admin: w.admin, calendar: cal, id: 1n, timelockSecs: 7n * DAY, sessions: [{ startTs: T0 + 500n, endTs: T0 + 1_000n }], feeds })], w.admin);
    return cal;
  }
  const a = (w: RulesWorld, price: bigint, t: bigint) => account(w, priceUpdate(price, t, FEED_A));

  it('prints a 5% divergence off hours, and refuses it while a session is open', async () => {
    for (const open of [true, false]) {
      const w = await RulesWorld.createRules();
      const cal = await calendar(w, [FEED_A]);
      const cross = await reopen(w, { offHoursWidenBps: 1_000 }, { calendar: cal, closeTs: T0 + 500n });
      // The harness settles at the end of the reveal window (close + 100). Move it to inside the session or after it.
      const at = open ? T0 + 700n : T0 + 1_200n;
      w.h.setTime(at);
      const price = await a(w, 126n, at); // 1.26 against P* 1.20: 5% off
      for (const ix of await w.settleIxs(w.view(cross.address), { oraclePrice: price })) await w.h.send([ix], w.admin);
      const v = w.view(cross.address);
      expect(v.data.state, open ? 'inside a session' : 'off hours').toBe(open ? CrossState.NoPrint : CrossState.Cleared);
      if (open) expect(v.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.OracleDivergence });
    }
  });

  it('a cross on a calendar may only name extra feeds the calendar approves', async () => {
    const w = await RulesWorld.createRules();
    const cal = await calendar(w, [FEED_A]);
    await expect(reopen(w, { extraFeeds: [FEED_B], quorum: 1 }, { calendar: cal, closeTs: T0 + 500n })).rejects.toThrow(/FeedNotApproved/);
  });
});

describe('a split or a dividend during the call', () => {
  async function scaledMint(w: RulesWorld, multiplier: number) {
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize([extension('ScaledUiAmountConfig', { authority: w.admin.address, multiplier, newMultiplierEffectiveTimestamp: 0n, newMultiplier: multiplier })]));
    await w.h.send(
      [
        getCreateAccountInstruction({ payer: w.admin, newAccount: mint, lamports: w.h.svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
        getInitializeScaledUiAmountMintInstruction({ mint: mint.address, authority: w.admin.address, multiplier }),
        getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: w.admin.address, freezeAuthority: null }),
      ],
      w.admin,
    );
    w.baseMint = mint.address;
    for (const who of [w.feeRecipient, w.integrator, w.creator]) await w.h.ata(who.address, w.baseMint, w.admin);
  }
  async function run(update: { multiplier: number; at: bigint } | null) {
    const w = await RulesWorld.createRules();
    await scaledMint(w, 1);
    const cross = await w.newRuledCross({ reference: 1_500_000n, rules: { flags: FLAG_GUARD_SCALED_UI } });
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    const orders = [await w.place(cross, seller, OrderSide.Sell, 1_400_000n, 100_000_000n), await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, 100_000_000n)];
    if (update) await w.h.send([getUpdateMultiplierScaledUiMintInstruction({ mint: w.baseMint, authority: w.admin, multiplier: update.multiplier, effectiveTimestamp: update.at })], w.admin);
    const settled = await w.settle(cross);
    return { w, settled, orders };
  }

  it('prints when the multiplier is unchanged, or changes only after the clear', async () => {
    expect((await run(null)).settled.data.state).toBe(CrossState.Cleared);
    expect((await run({ multiplier: 2, at: T0 + 10_000_000n })).settled.data.state).toBe(CrossState.Cleared);
  });

  it('does not print when the multiplier changed before the clear, and refunds everyone', async () => {
    const { w, settled, orders } = await run({ multiplier: 2, at: T0 + 50n });
    expect(settled.data.state).toBe(CrossState.NoPrint);
    expect(settled.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.CorporateAction });
    await w.claimAll(settled, orders);
    expect(await w.h.balanceOf(orders[0]!.owner.address, w.baseMint)).toBe(2_000_000_000n);
  });

  it('is refused for a mint without the extension', async () => {
    const w = await RulesWorld.createRules();
    await expect(w.newRuledCross({ rules: { flags: FLAG_GUARD_SCALED_UI } })).rejects.toThrow(/InvalidParams/);
  });
});
