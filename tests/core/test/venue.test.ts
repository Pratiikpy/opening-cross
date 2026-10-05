// External CPI integration (ROADMAP A4): a third-party venue program routes a user's order into a
// cross with one CPI. The user's signature flows through, escrow moves straight from the user to
// the cross vault, the claim pays the user, and the venue cannot act without the user's signature.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AccountRole, type Address, type Instruction, address, getProgramDerivedAddress } from '@solana/kit';
import { CrossState, OrderSide, buildClaim, buildPlaceOrder, buildSettleBook } from '@opening-cross/sdk';
import { World } from '../src/world.js';

const VENUE = address('7Kb2feBGE34ck7F7dovaEgKVJRLJ2JeUFxCyo4bamZJD');
const SO = fileURLToPath(new URL('../../../target/deploy/example_venue.so', import.meta.url));

async function routed(w: World, crossAddr: Address, user: Parameters<World['place']>[1], nonce: bigint, signer = true): Promise<Instruction> {
  const commit = await buildPlaceOrder({ cross: w.view(crossAddr), owner: user, nonce, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000_000n });
  const [stats] = await getProgramDerivedAddress({ programAddress: VENUE, seeds: [new TextEncoder().encode('stats')] });
  const a = commit.accounts!;
  // commit_order accounts: owner, protocol, cross, order, shard, pass, escrow_mint, escrow_vault,
  // owner_escrow, escrow_token_program, system_program. The venue adds stats and the core program.
  const userMeta = signer ? a[0]! : { address: a[0]!.address, role: AccountRole.WRITABLE };
  const data = new Uint8Array(commit.data!.length);
  createHash('sha256').update('global:route_order').digest().copy(Buffer.from(data.buffer), 0, 0, 8);
  data.set(commit.data!.slice(8), 8);
  return {
    programAddress: VENUE,
    accounts: [userMeta, { address: stats, role: AccountRole.WRITABLE }, a[1]!, a[2]!, a[3]!, a[4]!, a[6]!, a[7]!, a[8]!, a[9]!, { address: commit.programAddress, role: AccountRole.READONLY }, a[10]!],
    data,
  } as Instruction;
}

describe('external CPI integration', () => {
  it('a venue routes a user order with one CPI; the cross settles to the user', async () => {
    const w = await World.create();
    w.h.svm.addProgramFromFile(VENUE, SO);
    const cross = await w.newCross();
    const seller = await w.trader(0n, 1_000_000_000n);
    const user = await w.trader(10_000_000_000n);
    const sell = await w.place(cross, seller, OrderSide.Sell, 1_000_000n, 1_000_000_000n);
    await w.h.send([await routed(w, cross.address, user, 7n)], user);

    w.h.setTime(cross.data.revealEndTs + 1n);
    for (const ix of await buildSettleBook(w.view(cross.address))) await w.h.send([ix], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.Cleared);
    await w.h.send(await buildClaim(w.view(cross.address), w.admin, user.address, 7n), w.admin);
    await w.claimAll(w.view(cross.address), [sell]);
    expect(await w.h.balanceOf(user.address, w.baseMint)).toBe(1_000_000_000n);
    expect(await w.h.balanceOf(user.address, w.quoteMint)).toBe(9_000_000_000n);

    const [stats] = await getProgramDerivedAddress({ programAddress: VENUE, seeds: [new TextEncoder().encode('stats')] });
    const s = w.h.svm.getAccount(stats);
    if (!s.exists) throw new Error('stats missing');
    const view = new DataView(s.data.buffer, s.data.byteOffset);
    expect(view.getBigUint64(8, true)).toBe(1n); // orders_routed
    expect(view.getBigUint64(16, true)).toBe(1_000_000_000n); // escrow_routed
  });

  it('the venue cannot place an order without the user signing', async () => {
    const w = await World.create();
    w.h.svm.addProgramFromFile(VENUE, SO);
    const cross = await w.newCross();
    const user = await w.trader(10_000_000_000n);
    const operator = await w.trader();
    const forged = await routed(w, cross.address, user, 1n, false);
    expect(await w.h.fail([forged], operator)).toMatch(/MissingRequiredSignature|AccountNotSigner|signature/i);
    expect(await w.h.balanceOf(user.address, w.quoteMint)).toBe(10_000_000_000n);
  });
});
