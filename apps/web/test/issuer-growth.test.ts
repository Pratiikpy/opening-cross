import { describe, expect, it } from 'vitest';
import type { StoredRecord } from '../src/lib/issuer-board';
import type { OrderRow } from '../src/lib/issuer-dashboard';
import { PLAYBOOKS, buildContacts, contactsCsv, parseReferral, referralLink } from '../src/lib/issuer-growth';

const A = '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr';
const order = (owner: string, o: Partial<OrderRow> = {}): OrderRow => ({ idx: 0, address: 'x', owner, side: 'buy', escrow: '1', sealed: false, price: null, quantity: null, status: 'claimed', fill: '5', quote_out: null, base_out: null, fee: null, ...o });
const commit = (signer: string, amount: string, draft = 'D1'): { draft: string; record: StoredRecord } => ({ draft, record: { id: 'r', kind: 'softcommit', signer, subject: draft, issuedAt: 1, body: { amount, price: '1' }, signature: 's' } });

describe('contacts', () => {
  it('counts crosses and fills per wallet, ignores sellers, and adds soft commits in exact quote atoms', () => {
    const cs = buildContacts(
      [
        { cross: 'c1', orders: [order('A'), order('A', { idx: 1, fill: '0' }), order('B', { fill: '0' }), order('S', { side: 'sell' })] },
        { cross: 'c2', orders: [order('A')] },
      ],
      [commit('A', '10.5'), commit('C', '2'), commit('C', '1.25', 'D2')],
      () => 6,
    );
    expect(cs.map((c) => c.wallet)).toEqual(['A', 'B', 'C']);
    expect(cs[0]).toEqual({ wallet: 'A', crosses: 2, bids: 3, filledCrosses: 2, softCommitQuote: 10_500_000n, commits: 1 });
    expect(cs[1]).toMatchObject({ wallet: 'B', crosses: 1, filledCrosses: 0 });
    expect(cs[2]).toMatchObject({ wallet: 'C', crosses: 0, softCommitQuote: 3_250_000n, commits: 2 });
  });
  it('does not guess a commit’s amount when the draft’s decimals are unknown', () => {
    expect(buildContacts([], [commit('A', '5')], () => null)[0]!.softCommitQuote).toBe(0n);
  });
  it('is empty with nothing', () => {
    expect(buildContacts([], [], () => 6)).toEqual([]);
  });
  it('exports a CSV with the issuer’s notes, quoted where needed', () => {
    const out = contactsCsv([{ wallet: 'A', crosses: 1, bids: 2, filledCrosses: 1, softCommitQuote: 0n, commits: 0 }], { A: 'met at "demo day", follow up' });
    expect(out).toBe('wallet,crosses_bid_in,bids,crosses_filled,soft_commits,note\nA,1,2,1,0,"met at ""demo day"", follow up"\n');
  });
});

describe('referral links', () => {
  it('builds a link the wizard reads back to the same wallet and fee', () => {
    const l = referralLink('https://x.example', A, 25);
    expect(l).toEqual({ ok: true, url: `https://x.example/issue?ref=${A}&fee=25` });
    expect(parseReferral(`?ref=${A}&fee=25`)).toEqual({ wallet: A, feeBps: 25 });
  });
  it('refuses a bad wallet or a fee above the program’s limit, and the reader ignores them', () => {
    expect(referralLink('https://x.example', 'nope', 5)).toMatchObject({ ok: false });
    expect(referralLink('https://x.example', A, 301)).toMatchObject({ ok: false });
    expect(referralLink('https://x.example', A, 1.5)).toMatchObject({ ok: false });
    expect(parseReferral('?ref=nope&fee=5')).toBeNull();
    expect(parseReferral('')).toBeNull();
    expect(parseReferral(`?ref=${A}&fee=999`)).toEqual({ wallet: A, feeBps: 0 });
    expect(parseReferral(`?ref=${A}`)).toEqual({ wallet: A, feeBps: 0 });
  });
});

describe('playbooks', () => {
  it('every link points at a page of the issuer area or the wizard', () => {
    for (const p of PLAYBOOKS) for (const s of p.steps) if (s.href) expect(s.href).toMatch(/^\/(issue|issuer)(\/|#|$)/);
  });
  it('promise no result', () => {
    for (const p of PLAYBOOKS) for (const s of p.steps) expect(s.text).not.toMatch(/will (sell out|raise|succeed)|guaranteed/i);
  });
});
