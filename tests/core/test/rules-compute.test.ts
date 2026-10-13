// Compute cost of the instructions the rules add to, measured against the default 200,000-unit transaction budget
// (a client can ask for more, but the common path should not need to). The figures are printed for the evidence file.
import { describe, expect, it } from 'vitest';
import { Mode, findConfigPda, getCreateConfigInstruction, getGrantPassInstruction } from '@opening-cross/cross-gate-client';
import { CrossState, Disclosure, OrderSide, SupplyMode, gatePassAddress } from '@opening-cross/sdk';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const schedule = [{ price: 1_000_000n, quantity: 100n * TOKEN }];
const BUDGET = 200_000n;

describe('compute units', () => {
  it('commit, reveal, merge, clear, claim and finalize stay inside the default budget with every rule on', async () => {
    const w = await RulesWorld.createRules();
    const alice = await w.trader(100_000_000_000n);
    const bob = await w.trader(100_000_000_000n);
    const locker = await w.trader(100_000_000_000n);
    const insider = await w.trader(100_000_000_000n);
    const gateMint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint: gateMint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    for (const p of [alice, bob, locker, insider]) await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, p.address), owner: p.address })], w.admin);
    const referrer = await w.h.wallet();
    await w.h.ata(referrer.address, w.quoteMint, w.admin);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      disclosure: Disclosure.Sealed,
      schedule,
      gateMint,
      closeTs: T0 + 200n,
      rules: {
        guards: { minRaiseQuote: 1n, totalSupply: 1_000n * TOKEN, minFloatBps: 100, moveBps: 5_000, anchorPrice: 1_000_000n },
        ending: { endingSecs: 100, buckets: 4, cancelCutoffSecs: 10, randomEnd: true },
        identity: { maxOrders: 3, capQuote: 1_000n * TOKEN },
        alloc: { reserveBps: [2_000, 1_000, 0], smallCapQuote: 10n * TOKEN, minLockSecs: 100, lockVestSecs: 100 },
        neutrality: { insiders: [insider.address], insiderCliffSecs: 50 },
        referral: { referrer: referrer.address, shareBps: 1_000 },
      },
      integratorFeeBps: 200,
    });
    const view = w.view(cross.address);
    const measured: Record<string, bigint> = {};
    const note = (name: string, cu: bigint) => {
      measured[name] = cu > (measured[name] ?? 0n) ? cu : (measured[name] ?? 0n);
    };
    const orders = [];
    for (const [who, price, qty, opts] of [
      [alice, 1_000_000n, 20n * TOKEN, {}],
      [bob, 1_000_000n, 30n * TOKEN, {}],
      [locker, 1_000_000n, 25n * TOKEN, { class: 2, lockSecs: 100 }],
      [insider, 1_000_000n, 10n * TOKEN, {}],
    ] as const) {
      const nonce = BigInt(w.view(cross.address).data.ordersTotal);
      // The first two orders are placed before the ending period (they always count), the others inside it.
      w.h.setTime(nonce < 2n ? T0 + 10n : T0 + 150n);
      const s = new Uint8Array(32).fill(Number(nonce) + 1);
      const ix = await w.commitIx(w.view(cross.address), who, nonce, OrderSide.Buy, price, qty, s, opts);
      note('commit_order (sealed, identity + class book + ending)', await w.h.send([ix], who));
      orders.push({ owner: who, nonce, side: OrderSide.Buy, price, quantity: qty, escrow: 0n, index: Number(nonce), salt: s, reveal: true });
    }
    w.h.setTime(view.data.closeTs + 1n);
    for (const o of orders) {
      const ix = await w.revealIx(w.view(cross.address), { ...o, escrow: 0n });
      note('reveal_order (class book)', await w.h.send([ix], o.owner));
    }
    w.h.setTime(view.data.revealEndTs + 1n);
    await w.draw(cross.address, 1);
    for (const ix of await w.settleIxs(w.view(cross.address))) {
      const name = ix.accounts && ix.accounts.length > 3 ? 'clear (guards + class book)' : 'merge_shard';
      note(name, await w.h.send([ix], w.admin));
    }
    expect(w.view(cross.address).data.state).toBe(CrossState.Cleared);
    for (const o of orders) {
      const ixs = await w.claimIxs(w.view(cross.address), w.admin, { ...o, escrow: 0n });
      note('claim (with a lock when locked)', await w.h.send(ixs, w.admin));
    }
    note('finalize (referral)', await w.h.send([await w.finalizeIx(w.view(cross.address), w.admin)], w.admin));
    for (const [name, cu] of Object.entries(measured)) {
      console.log(`CU ${cu.toString().padStart(7)}  ${name}`);
      expect(cu < BUDGET, `${name}: ${cu}`).toBe(true);
    }
  });
});
