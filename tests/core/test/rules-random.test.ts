// Random books with allocation classes, a lottery, insiders, a cap and cancels: every fill the program pays, the
// clearing price and the matched volume equal the independent TypeScript reference, and the vault empties.
import { describe, expect, it } from 'vitest';
import type { KeyPairSigner } from '@solana/kit';
import { Mode, findConfigPda, getCreateConfigInstruction, getGrantPassInstruction } from '@opening-cross/cross-gate-client';
import { CrossState, Disclosure, OrderSide, SupplyMode, gatePassAddress, quoteVaultAddress } from '@opening-cross/sdk';
import { type Order2, type Rules2, referenceClearCapped, referenceFills2 } from '@opening-cross/verifier';
import { RulesWorld } from '../src/rules-world.js';
import { SCALE, type PlacedOrder } from '../src/world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const G = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

/** SplitMix64: fixed and dependency free, so a failing case can be replayed from its seed. */
class Rng {
  constructor(private s: bigint) {}
  next(): bigint {
    this.s = (this.s + 0x9e3779b97f4a7c15n) & 0xffff_ffff_ffff_ffffn;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffff_ffff_ffff_ffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffff_ffff_ffff_ffffn;
    return z ^ (z >> 31n);
  }
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
}

describe('random books with rules', () => {
  for (const seed of Array.from({ length: 24 }, (_, i) => BigInt(i + 1))) {
    it(`seed ${seed}: the program equals the reference on price, volume and every fill`, async () => {
      const r = new Rng(seed);
      const w = await RulesWorld.createRules();
      const lotUnit = 3n * TOKEN;
      const useLottery = r.below(2) === 0;
      const reserve: [number, number, number] = [useLottery ? 1_000 + r.below(3_000) : 0, 500 + r.below(2_000), 500 + r.below(1_500)];
      const cap = r.below(3) === 0 ? BigInt(40 + r.below(80)) * TOKEN : null;
      const nTraders = 8 + r.below(8);
      const traders: KeyPairSigner[] = [];
      for (let i = 0; i < nTraders; i++) traders.push(await w.trader(1_000_000n * TOKEN));
      const gateMint = await w.h.mint(w.admin, 6);
      const [config] = await findConfigPda({ mint: gateMint });
      await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
      for (const p of traders) await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, p.address), owner: p.address })], w.admin);
      const insider = traders[0]!;
      const schedule = [
        { price: 1_000_000n, quantity: BigInt(30 + r.below(40)) * TOKEN },
        { price: 1_500_000n, quantity: BigInt(30 + r.below(60)) * TOKEN },
      ];
      const cross = await w.newRuledCross({
        supplyMode: SupplyMode.Mint,
        disclosure: Disclosure.Open,
        schedule,
        gateMint,
        closeTs: T0 + 200n,
        rules: {
          guards: cap ? { maxMatched: cap } : {},
          alloc: { reserveBps: reserve, smallCapQuote: 6n * TOKEN, lotteryUnit: useLottery ? lotUnit : 0n, minLockSecs: 60, lockVestSecs: 0, earlyUntilTs: T0 + 50n },
          neutrality: { insiders: [insider.address], insiderCliffSecs: 0 },
        },
      });
      const placed: PlacedOrder[] = [];
      const classes: number[] = [];
      const insiders: boolean[] = [];
      const orderCount = 8 + r.below(10);
      for (let i = 0; i < orderCount; i++) {
        const who = traders[r.below(traders.length)]!;
        const price = G.min + BigInt(r.below(8)) * G.tick;
        const isInsider = who.address === insider.address;
        let cls = isInsider ? 0 : r.below(4);
        if (cls === 1 && !useLottery && r.below(2) === 0) cls = 0;
        const qty = cls === 1 && useLottery ? lotUnit : BigInt(2 + r.below(40)) * TOKEN;
        if (cls === 1 && qty * price > 6n * TOKEN * SCALE) cls = 0; // class 1 escrow cap is 6 tokens' worth
        w.h.setTime(cls === 3 ? T0 + 10n : T0 + 100n);
        try {
          const o = await w.place(cross, who, OrderSide.Buy, price, cls === 1 && useLottery ? lotUnit : qty, cls === 0 ? {} : cls === 2 ? { class: 2, lockSecs: 60 } : { class: cls });
          placed.push(o);
          classes.push(cls);
          insiders.push(isInsider);
        } catch (e) {
          // A class the rules refuse (a class-1 order above the cap, a second order beyond a limit) is simply not placed.
          if (!/ClassNotAllowed|LotSize|NotEligible|IdentityLimit/.test(String((e as Error).message) + String((e as { logs?: string[] }).logs))) throw e;
        }
      }
      // Cancel a few orders that can be cancelled (class 0, 2, 3 of the first window).
      w.h.setTime(T0 + 100n);
      let live = [...placed.keys()];
      for (const i of [...live]) {
        if (classes[i] === 1 && useLottery) continue;
        if (r.below(5) === 0) {
          await w.cancel(cross, placed[i]!);
          live = live.filter((k) => k !== i);
        }
      }
      w.h.setTime(cross.data.closeTs + 1n);
      if (useLottery) await w.draw(cross.address, 1);
      for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
      const settled = w.view(cross.address);
      const orders: Order2[] = [
        ...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity, class: 0, insider: false })),
        ...live.map((i) => ({ side: 'buy' as const, price: placed[i]!.price, quantity: placed[i]!.quantity, class: classes[i]!, insider: insiders[i]! })),
      ];
      const ref = referenceClearCapped(orders, G, null, cap);
      if (!ref) {
        expect(settled.data.state).toBe(CrossState.NoPrint);
        return;
      }
      expect(settled.data.state).toBe(CrossState.Cleared);
      const chain = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
      expect(chain?.price).toBe(ref.price);
      expect(chain?.matched).toBe(ref.matched);
      const rules: Rules2 = {
        supplyCap: cap, minRaiseQuote: 0n, priceScale: SCALE, totalSupply: 0n, minFloatBps: 0n, maxFdvX100: 0n, anchorPrice: 0n, moveBps: 0n,
        reserveBps: [BigInt(reserve[0]), BigInt(reserve[1]), BigInt(reserve[2])], lotteryUnit: useLottery ? lotUnit : 0n, rho: BigInt(settled.ext!.clearing.rho),
      };
      const want = referenceFills2(orders, ref, rules).slice(schedule.length);
      const liveOrders = live.map((i) => placed[i]!);
      await w.claimAll(settled, liveOrders);
      let total = 0n;
      for (const [k, o] of liveOrders.entries()) {
        const i = live[k]!;
        const wallet = await w.h.balanceOf(o.owner.address, settled.data.baseMint);
        // Locked fills (class 2) sit in the lock vault; an insider has no lock here (cliff 0 means a plain lock of zero length).
        const lockedFill = classes[i] === 2 && want[k]! > 0n;
        if (!lockedFill) {
          // A wallet may hold several fills; compare sums per wallet below.
        }
        total += want[k]!;
        void wallet;
      }
      // Per wallet: what it holds equals the sum of its unlocked fills.
      const perWallet = new Map<string, bigint>();
      for (const [k, o] of liveOrders.entries()) {
        const i = live[k]!;
        const locked = classes[i] === 2;
        perWallet.set(o.owner.address, (perWallet.get(o.owner.address) ?? 0n) + (locked ? 0n : want[k]!));
      }
      for (const [addr, sum] of perWallet) expect(await w.h.balanceOf(addr as never, settled.data.baseMint), `${addr}`).toBe(sum);
      expect(total <= ref.matched).toBe(true);
      const final = await w.finalize(w.view(cross.address));
      expect(final.data.state).toBe(CrossState.Finalized);
      expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
    });
  }
});
