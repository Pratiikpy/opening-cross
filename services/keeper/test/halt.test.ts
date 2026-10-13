// A cross whose mint became paused is skipped with a typed reason instead of being retried every pass.
// Pure: accounts are encoded in memory, the sender is a counter that can be made to fail like the program would.
import { describe, expect, it, vi } from 'vitest';
import { type Address, generateKeyPairSigner, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token-2022';
import { CROSS_DISCRIMINATOR, CrossState, ORDER_DISCRIMINATOR, getCrossDecoder, getCrossEncoder, getOrderDecoder, getOrderEncoder } from '@opening-cross/cross-core-client';
import { type Deferred, type MintHalt, mintHaltCheck, runOnce } from '../src/index.js';

const NOW = 1_800_000_000n;

// A fake sender does not change chain state, so the keeper repeats a round; count each order once.
const claimed = (r: { done: { action: { kind: string; order?: { address: string } } }[] }) => new Set(r.done.filter((d) => d.action.kind === 'claim').map((d) => d.action.order!.address)).size;

async function fixture(state: CrossState, orders = 2) {
  const payer = await generateKeyPairSigner();
  const cross = (await generateKeyPairSigner()).address;
  const base = (await generateKeyPairSigner()).address;
  const quote = (await generateKeyPairSigner()).address;
  const z = new Uint8Array(4096);
  z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
  const accounts = new Map<string, Uint8Array>();
  accounts.set(cross, new Uint8Array(getCrossEncoder().encode({ ...getCrossDecoder().decode(z), state, baseBound: true, baseMint: base, quoteMint: quote, creator: payer.address, openTs: NOW - 5000n, closeTs: NOW - 4000n, revealEndTs: NOW - 3000n, ordersOpen: orders, ordersTotal: orders, clearing: some({ price: 1n, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) } as never)));
  const orderAddresses: Address[] = [];
  const oz = new Uint8Array(512);
  oz.set(ORDER_DISCRIMINATOR as Uint8Array, 0);
  for (let i = 0; i < orders; i++) {
    const a = (await generateKeyPairSigner()).address;
    orderAddresses.push(a);
    accounts.set(a, new Uint8Array(getOrderEncoder().encode({ ...getOrderDecoder().decode(oz), cross, owner: (await generateKeyPairSigner()).address, nonce: BigInt(i), index: i } as never)));
  }
  return { payer, cross, base, quote, accounts, orderAddresses };
}

function deps(f: Awaited<ReturnType<typeof fixture>>, o: { halted: Set<string>; send: (n: number) => Promise<string> }) {
  let sent = 0;
  const memory = new Map<string, Deferred>();
  const run = () =>
    runOnce({
      payer: f.payer,
      now: async () => NOW,
      fetch: async (a) => f.accounts.get(a) ?? null,
      crosses: async () => [f.cross],
      orders: async () => f.orderAddresses,
      send: async () => o.send(++sent),
      mintHalt: async (m): Promise<MintHalt | null> => (o.halted.has(m) ? { code: 'MINT_PAUSED', message: 'The issuer has paused all transfers of this token.' } : null),
      memory,
    });
  return { run, sent: () => sent, memory };
}

describe('keeper with a halted mint', () => {
  it('without the check, behaviour is unchanged: the claims are sent', async () => {
    const f = await fixture(CrossState.Cleared);
    const r = await runOnce({ payer: f.payer, now: async () => NOW, fetch: async (a) => f.accounts.get(a) ?? null, crosses: async () => [f.cross], orders: async () => f.orderAddresses, send: async () => 'sig' });
    expect(claimed(r)).toBe(2);
    expect(r.skipped.filter((s) => s.code)).toEqual([]);
  });

  it('a claim refused while the base mint is paused is skipped with MINT_PAUSED, not failed, and not re-sent next pass', async () => {
    const f = await fixture(CrossState.Cleared);
    const refuse = vi.fn(async () => {
      throw new Error('Program log: Error: Mint is paused');
    });
    const k = deps(f, { halted: new Set([f.base]), send: refuse });
    const first = await k.run();
    expect(first.failed).toEqual([]);
    expect(first.done).toEqual([]);
    expect(first.skipped).toEqual([expect.objectContaining({ cross: f.cross, code: 'MINT_PAUSED', reason: expect.stringMatching(/2 step\(s\) held back.*base mint .* cannot move right now: The issuer has paused/) })]);
    expect(k.sent()).toBe(2); // one attempt per claim, then remembered
    const second = await k.run();
    expect(k.sent()).toBe(2); // nothing re-sent while the halt holds
    expect(second.failed).toEqual([]);
    expect(second.skipped[0]).toMatchObject({ code: 'MINT_PAUSED' });
    await k.run();
    expect(k.sent()).toBe(2);
  });

  it('the steps resume as soon as the mint is unpaused', async () => {
    const f = await fixture(CrossState.Cleared);
    const halted = new Set([f.base]);
    let allow = false;
    const k = deps(f, { halted, send: async (n) => { if (!allow) throw new Error('paused'); return `sig${n}`; } });
    await k.run();
    expect(k.sent()).toBe(2);
    halted.clear();
    allow = true;
    const after = await k.run();
    expect(claimed(after)).toBe(2);
    expect(after.failed).toEqual([]);
    expect(k.memory.size).toBe(0);
  });

  it('a change in the set of halts (the quote mint pauses too) is tried once more', async () => {
    const f = await fixture(CrossState.Cleared, 1);
    const halted = new Set([f.base]);
    const k = deps(f, { halted, send: async () => { throw new Error('paused'); } });
    await k.run();
    await k.run();
    expect(k.sent()).toBe(1);
    halted.add(f.quote);
    await k.run();
    expect(k.sent()).toBe(2);
  });

  it('a live cross past its reveal window is not settled while a mint is halted, and nothing is sent', async () => {
    const f = await fixture(CrossState.Live, 0);
    const k = deps(f, { halted: new Set([f.base]), send: async () => 'sig' });
    const r = await k.run();
    expect(k.sent()).toBe(0);
    expect(r.done).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ code: 'MINT_PAUSED', reason: expect.stringMatching(/^settlement is withheld while the base mint /) })]);
  });

  it('a failure that is not about a halted mint is still reported as a failure', async () => {
    const f = await fixture(CrossState.Cleared, 1);
    const k = deps(f, { halted: new Set(), send: async () => { throw new Error('blockhash expired'); } });
    const r = await k.run();
    expect(r.failed).toHaveLength(1);
    expect(r.skipped.filter((s) => s.code)).toEqual([]);
  });

  it('a frozen token account is skipped with ACCOUNT_FROZEN and retried only after ten minutes', async () => {
    const f = await fixture(CrossState.Cleared, 1);
    let at = NOW;
    let sent = 0;
    const memory = new Map<string, Deferred>();
    const run = () => runOnce({ payer: f.payer, now: async () => at, fetch: async (a) => f.accounts.get(a) ?? null, crosses: async () => [f.cross], orders: async () => f.orderAddresses, send: async () => { sent++; throw new Error('Program log: Error: Account is frozen'); }, memory });
    const first = await run();
    expect(first.failed).toEqual([]);
    expect(first.skipped).toEqual([expect.objectContaining({ code: 'ACCOUNT_FROZEN' })]);
    expect(sent).toBe(1);
    at = NOW + 599n;
    await run();
    expect(sent).toBe(1);
    at = NOW + 600n;
    await run();
    expect(sent).toBe(2);
  });

  it('a mint that cannot be read does not stop the pass', async () => {
    const f = await fixture(CrossState.Cleared, 1);
    const r = await runOnce({ payer: f.payer, now: async () => NOW, fetch: async (a) => f.accounts.get(a) ?? null, crosses: async () => [f.cross], orders: async () => f.orderAddresses, send: async () => 'sig', mintHalt: async () => { throw new Error('mint closed'); } });
    expect(claimed(r)).toBe(1);
  });
});

describe('mintHaltCheck (token-safety through an RPC)', () => {
  const ISSUER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
  const rpcFor = (ext: Record<string, unknown>[] | null, counter: { n: number }) => {
    const data = getMintEncoder().encode({ mintAuthority: none(), supply: 1n, decimals: 6, isInitialized: true, freezeAuthority: some(ISSUER), extensions: ext ? some(ext) : none() } as never);
    return {
      getAccountInfo: () => ({
        send: async () => {
          counter.n++;
          return { context: { slot: 1n }, value: { data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, lamports: 1n, owner: TOKEN_2022_PROGRAM_ADDRESS, space: BigInt(data.length), rentEpoch: 0n } };
        },
      }),
    } as never;
  };

  it('reports a paused mint as MINT_PAUSED, a hooked mint as TRANSFER_HOOK and a merely privileged mint as fine', async () => {
    const mint = (await generateKeyPairSigner()).address;
    const c = { n: 0 };
    const paused = mintHaltCheck(rpcFor([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: true }], c), { now: async () => NOW });
    expect(await paused(mint)).toMatchObject({ code: 'MINT_PAUSED' });
    const hooked = mintHaltCheck(rpcFor([{ __kind: 'TransferHook', authority: ISSUER, programId: ISSUER }], c), { now: async () => NOW });
    expect(await hooked(mint)).toMatchObject({ code: 'TRANSFER_HOOK' });
    const privileged = mintHaltCheck(rpcFor([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: false }], c), { now: async () => NOW });
    expect(await privileged(mint)).toBeNull();
  });

  it('reuses a verdict inside its ttl and reads again after it', async () => {
    const mint = (await generateKeyPairSigner()).address;
    const c = { n: 0 };
    let t = 0;
    const check = mintHaltCheck(rpcFor(null, c), { now: async () => NOW, ttlMs: 1000, clock: () => t });
    await check(mint);
    await check(mint);
    expect(c.n).toBe(1);
    t = 1001;
    await check(mint);
    expect(c.n).toBe(2);
  });
});
