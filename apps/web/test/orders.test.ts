import { describe, expect, it } from 'vitest';
import { describeOrder } from '../src/lib/orders';

const window = { openTs: '100', closeTs: '200', revealEndTs: '300' };
const cross = (state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized') => ({ state, window });

describe('describeOrder', () => {
  it('says a cancelled or claimed order is finished, whatever the cross did', () => {
    expect(describeOrder({ status: 'cancelled', sealed: false }, cross('Live'), 150n)).toEqual({ status: 'Cancelled', next: null });
    expect(describeOrder({ status: 'claimed', sealed: true }, cross('Finalized'), 999n)).toEqual({ status: 'Settled', next: null });
  });

  it('follows a sealed bid through the open call, the reveal window and the wait for settlement', () => {
    const o = { status: 'committed' as const, sealed: true };
    expect(describeOrder(o, cross('Live'), 150n)).toMatchObject({ status: 'Sealed, cross open', next: 'You can cancel until the call closes.' });
    expect(describeOrder(o, cross('Live'), 250n)).toMatchObject({ status: 'Closed, waiting for your reveal' });
    expect(describeOrder(o, cross('Live'), 300n)).toMatchObject({ status: 'Closed, waiting for settlement' });
    // Once revealed it is in the book like any other order.
    expect(describeOrder({ status: 'revealed', sealed: true }, cross('Live'), 150n).status).toBe('In the book, cross open');
  });

  it('points at the cross page once the cross has cleared or refused to print', () => {
    expect(describeOrder({ status: 'committed', sealed: false }, cross('Cleared'), 500n)).toMatchObject({ status: 'Cleared', next: expect.stringContaining('Claim your fill') });
    expect(describeOrder({ status: 'committed', sealed: false }, cross('NoPrint'), 500n)).toMatchObject({ status: 'The cross did not print', next: expect.stringContaining('full refund') });
  });
});
