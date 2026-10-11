import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { address, getAddressEncoder } from '@solana/kit';
import { OrderSide, costCeil, crossAddress, orderCommitment, shardIndexFor } from '../src/index.js';

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
