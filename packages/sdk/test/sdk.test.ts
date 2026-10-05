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

  it('rounds buyer cost up and assigns shards by index', () => {
    expect(costCeil(3n, 10n, 4n)).toBe(8n);
    expect(costCeil(4n, 10n, 4n)).toBe(10n);
    expect([0, 1, 2, 3, 4].map((i) => shardIndexFor(i, 3))).toEqual([0, 1, 2, 0, 1]);
  });

  it('derives distinct cross addresses per creator and id', async () => {
    const a = address('DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC');
    expect(await crossAddress(a, 1n)).not.toBe(await crossAddress(a, 2n));
  });
});
