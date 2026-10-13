import { describe, expect, it } from 'vitest';
import type { MintRead } from '../src/lib/issuer-readiness';
import { EMPTY_TREASURY, type TreasuryForm, checkTreasuryForm } from '../src/lib/issuer-treasury';

const A = '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr';
const B = 'CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN';
const C = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const D = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';
const mint = (o: Partial<Extract<MintRead, { ok: true }>> = {}): MintRead => ({ ok: true, program: 'T', decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [], supply: 1_000_000n, ...o });
const form = (o: Partial<TreasuryForm> = {}): TreasuryForm => ({ ...EMPTY_TREASURY, coinMint: A, quoteMint: B, allowance: '1000', credential: C, schema: D, ...o });

describe('treasury form', () => {
  it('turns a valid form into exact request fields', () => {
    const r = checkTreasuryForm(form(), 'AUTH', mint(), mint());
    expect(r.ok && r.body).toEqual({ authority: 'AUTH', coinMint: A, quoteMint: B, allowance: '1000000000', periodSecs: 2_592_000, graceSecs: 604_800, credential: C, schema: D });
  });
  it('hours and days, and a grace of zero', () => {
    const r = checkTreasuryForm(form({ periodAmount: '12', periodUnit: 'hours', graceAmount: '0' }), 'AUTH', mint(), mint());
    expect(r.ok && r.body).toMatchObject({ periodSecs: 43_200, graceSecs: 0 });
  });
  it('tells the issuer a coin whose supply is not fixed has to wait, in words', () => {
    const r = checkTreasuryForm(form(), 'AUTH', mint({ mintAuthority: 'SOMEONE' }), mint());
    expect(!r.ok && r.errors.coinMint).toMatch(/after the supply is fixed.*finalizes/);
    expect(!checkTreasuryForm(form(), 'AUTH', mint({ supply: 0n }), mint()).ok).toBe(true);
  });
  it('refuses an amount that would round, a zero amount, and one before the quote token is read', () => {
    expect(!checkTreasuryForm(form({ allowance: '1.0000001' }), 'AUTH', mint(), mint()).ok).toBe(true);
    expect(!checkTreasuryForm(form({ allowance: '0' }), 'AUTH', mint(), mint()).ok).toBe(true);
    const r = checkTreasuryForm(form(), 'AUTH', mint(), null);
    expect(!r.ok && r.errors.allowance).toMatch(/Check the quote token first/);
  });
  it('refuses junk in every field and names each', () => {
    const r = checkTreasuryForm({ coinMint: 'x', quoteMint: 'y', allowance: 'z', periodAmount: '0', periodUnit: 'days', graceAmount: '-1', graceUnit: 'days', credential: '', schema: 'q' }, 'AUTH', null, mint());
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['allowance', 'coinMint', 'credential', 'graceAmount', 'periodAmount', 'quoteMint', 'schema']);
  });
  it('refuses the same token as coin and as quote, a period over ten years, and a failed mint read', () => {
    expect(!checkTreasuryForm(form({ quoteMint: A }), 'AUTH', mint(), mint()).ok).toBe(true);
    expect(!checkTreasuryForm(form({ periodAmount: '4000', periodUnit: 'days' }), 'AUTH', mint(), mint()).ok).toBe(true);
    const r = checkTreasuryForm(form(), 'AUTH', { ok: false, reason: 'No account exists at this address.' }, mint());
    expect(!r.ok && r.errors.coinMint).toBe('No account exists at this address.');
  });
});
