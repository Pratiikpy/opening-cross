import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { address, getAddressEncoder } from '@solana/kit';
import { OrderSide, SupplyMode, ata, buildFinalizeWithAccounts, costCeil, crossAddress, orderCommitment, shardIndexFor } from '../src/index.js';
import { type Address, createNoopSigner, getAddressDecoder } from '@solana/kit';

describe('sdk helpers', () => {
  it('commitment equals sha256(cross ‖ owner ‖ nonce ‖ side ‖ price ‖ quantity ‖ salt)', () => {
    const cross = address('F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ');
    const owner = address('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    const salt = new Uint8Array(32).fill(7);
    const le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
    const enc = getAddressEncoder();
    const expected = createHash('sha256').update(enc.encode(cross)).update(enc.encode(owner)).update(le(3n)).update(Buffer.from([1])).update(le(1_200_000n)).update(le(5n)).update(salt).digest();
    expect(Buffer.from(orderCommitment(cross, owner, 3n, OrderSide.Sell, 1_200_000n, 5n, salt))).toEqual(expected);
    expect(() => orderCommitment(cross, owner, 3n, OrderSide.Buy, 1n, 1n, new Uint8Array(31))).toThrow();
  });

  it('rounds buyer cost up', () => {
    expect(costCeil(3n, 10n, 4n)).toBe(8n);
    expect(costCeil(4n, 10n, 4n)).toBe(10n);
  });

  it('assigns an order to a shard from its owner and nonce alone, the same as an independent sha256', () => {
    const owner = address('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    const le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
    for (const shards of [1, 2, 3, 7, 32]) {
      const seen = new Set<number>();
      for (let nonce = 0n; nonce < 200n; nonce++) {
        const h = createHash('sha256').update(getAddressEncoder().encode(owner)).update(le(nonce)).digest();
        const expected = h.readUInt32LE(0) % shards;
        expect(shardIndexFor(owner, nonce, shards)).toBe(expected);
        seen.add(expected);
      }
      // Spread over every shard, so no shard is starved or overloaded by the rule.
      expect(seen.size).toBe(shards);
    }
  });

  it('derives distinct cross addresses per creator and id', async () => {
    const a = address('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    expect(await crossAddress(a, 1n)).not.toBe(await crossAddress(a, 2n));
  });
});

describe('buildFinalizeWithAccounts', () => {
  const key = (label: string): Address => getAddressDecoder().decode(createHash('sha256').update(label).digest());
  const quoteMint = key('quote');
  const token = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const payer = createNoopSigner(key('payer'));
  const view = (referral: { referrer: Address; shareBps: number } | null) =>
    ({
      address: key('cross'),
      data: { supplyMode: SupplyMode.Mint, baseBound: true, baseMint: key('base'), quoteMint, baseTokenProgram: token, quoteTokenProgram: token, feeRecipient: key('fees'), integrator: key('integrator'), proceedsTo: key('proceeds') },
      ext: referral ? { referral } : null,
    }) as never;
  // The accounts an idempotent create-ATA instruction creates: [payer, ata, owner, mint, ...]
  const opened = (ixs: { accounts?: readonly { address: Address }[] }[]) => ixs.slice(0, -1).map((ix) => ix.accounts![1]!.address);

  it('opens the referrer’s account too when the rules name one, so finalize does not fail with ReferralAccountMissing', async () => {
    const referrer = key('referrer');
    const ixs = await buildFinalizeWithAccounts(view({ referrer, shareBps: 1000 }), payer);
    expect(opened(ixs)).toContain(await ata(referrer, quoteMint, token));
    expect(opened(ixs)).toHaveLength(4);
    // The finalize itself carries the referrer's account after the named ones.
    expect(ixs.at(-1)!.accounts?.at(-1)?.address).toBe(await ata(referrer, quoteMint, token));
  });

  it('opens three accounts and no more when there is no referral, or a referral of zero', async () => {
    expect(opened(await buildFinalizeWithAccounts(view(null), payer))).toHaveLength(3);
    expect(opened(await buildFinalizeWithAccounts(view({ referrer: key('referrer'), shareBps: 0 }), payer))).toHaveLength(3);
  });

  it('opens one account for a referrer who is also the fee recipient', async () => {
    expect(opened(await buildFinalizeWithAccounts(view({ referrer: key('fees'), shareBps: 500 }), payer))).toHaveLength(3);
  });
});
