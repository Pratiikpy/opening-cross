// The independent verifier reproduces what the program decided for crosses that carry rules: a cap, the raise
// guards, allocation classes with a lottery, declared insiders, and a book that has been tampered with.
import { describe, expect, it } from 'vitest';
import { type Address, lamports } from '@solana/kit';
import { Mode, findConfigPda, getCreateConfigInstruction, getGrantPassInstruction } from '@opening-cross/cross-gate-client';
import { CrossState, Disclosure, OrderSide, SupplyMode, gatePassAddress } from '@opening-cross/sdk';
import { PROOF_SCHEMA_V2, bookAddressOf, verifyCross } from '@opening-cross/verifier';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const schedule = [{ price: 1_000_000n, quantity: 100n * TOKEN }];

const fetcher = (w: RulesWorld) => async (a: Address) => {
  const x = w.h.svm.getAccount(a);
  return x.exists ? x.data : null;
};

describe('verifying crosses with rules', () => {
  it('a capped, guarded cross: printed, and refused for a raise that fell short', async () => {
    const w = await RulesWorld.createRules();
    const printed = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule: [{ price: 1_000_000n, quantity: 200n * TOKEN }], rules: { guards: { maxMatched: 80n * TOKEN, minRaiseQuote: 50n * TOKEN } } });
    await w.place(printed, await w.trader(500n * TOKEN), OrderSide.Buy, 1_200_000n, 150n * TOKEN);
    const settled = await w.settle(printed);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const proof = await verifyCross(fetcher(w), printed.address);
    expect(proof.schema).toBe(PROOF_SCHEMA_V2);
    expect(proof.verified).toBe(true);
    expect(proof.onchain.matched).toBe(String(80n * TOKEN));

    const short = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { guards: { minRaiseQuote: 90n * TOKEN } } });
    await w.place(short, await w.trader(500n * TOKEN), OrderSide.Buy, 1_000_000n, 50n * TOKEN);
    expect((await w.settle(short)).data.state).toBe(CrossState.NoPrint);
    const noPrint = await verifyCross(fetcher(w), short.address);
    expect(noPrint.verified).toBe(true);
    expect(noPrint.recomputed.noPrintReason).toBe('BelowMinimumRaise');
  });

  it('classes, a lottery and insiders: every fill and the insider bound are reproduced from the class book', async () => {
    const w = await RulesWorld.createRules();
    const many = async (n: number) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(await w.trader(100n * 1_000_000n * TOKEN));
      return out;
    };
    const lot = await many(6);
    const general = await many(2);
    const insider = await w.trader(100n * 1_000_000n * TOKEN);
    const gateMint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint: gateMint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    for (const p of [...lot, ...general, insider]) await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, p.address), owner: p.address })], w.admin);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      disclosure: Disclosure.Open,
      schedule,
      gateMint,
      closeTs: T0 + 200n,
      rules: { alloc: { reserveBps: [3_000, 0, 0], smallCapQuote: 5n * TOKEN, lotteryUnit: 5n * TOKEN }, neutrality: { insiders: [insider.address], insiderCliffSecs: 10 } },
    });
    w.h.setTime(T0 + 100n);
    for (const t of lot) await w.place(cross, t, OrderSide.Buy, 1_000_000n, 5n * TOKEN, { class: 1 });
    for (const t of general) await w.place(cross, t, OrderSide.Buy, 1_000_000n, 50n * TOKEN);
    await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 40n * TOKEN);
    w.h.setTime(cross.data.closeTs + 1n);
    await w.draw(cross.address, 1);
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.Cleared);
    const proof = await verifyCross(fetcher(w), cross.address);
    expect(proof.verified).toBe(true);
    expect(proof.rules?.allocation?.tickets).toBe(6);
    expect(Number(proof.rules?.allocation?.insiderUpperBound)).toBeGreaterThan(0);
  });

  it('flags a book that no longer supports the recorded clearing', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { guards: { minRaiseQuote: 1n } } });
    await w.place(cross, await w.trader(500n * TOKEN), OrderSide.Buy, 1_300_000n, 50n * TOKEN);
    await w.settle(cross);
    expect((await verifyCross(fetcher(w), cross.address)).verified).toBe(true);
    const bookAddr = await bookAddressOf(cross.address);
    const acct = w.h.svm.getAccount(bookAddr);
    if (!acct.exists) throw new Error('book missing');
    const data = new Uint8Array(acct.data);
    const tick = Number((1_300_000n - cross.data.minPrice) / cross.data.tick);
    new DataView(data.buffer).setBigUint64(8 + 32 + tick * 8, 5_000n * TOKEN, true);
    w.h.svm.setAccount({ address: bookAddr, data, executable: false, lamports: lamports(BigInt(acct.lamports)), programAddress: acct.programAddress, space: BigInt(data.length) });
    expect((await verifyCross(fetcher(w), cross.address)).verified).toBe(false);
  });
});
