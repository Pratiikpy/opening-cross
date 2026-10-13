// The safety, router and replay tools build the API requests their descriptions promise.
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/index.js';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const MINT = 'So11111111111111111111111111111111111111112';

describe('safety, router and replay tools', () => {
  it('oc_check_token_safety reads /v1/tokens/:mint/safety', () => {
    expect(tool('oc_check_token_safety').request({ mint: MINT })).toEqual({ method: 'GET', path: `/v1/tokens/${MINT}/safety` });
    expect(tool('oc_check_token_safety').kind).toBe('read');
  });

  it('oc_quote_route passes the whole order to /v1/router/quote and marks third-party strings untrusted', () => {
    const t = tool('oc_quote_route');
    expect(t.request({ base: MINT, quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', side: 'buy', amount: '2500000' })).toEqual({
      method: 'GET',
      path: `/v1/router/quote?base=${MINT}&quote=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&side=buy&amount=2500000`,
    });
    expect(t.untrusted).toEqual(['/venues/*/route/*', '/excluded/*/reason']);
    expect(t.inputSchema).toMatchObject({ required: ['base', 'quote', 'side', 'amount'] });
  });

  it('oc_get_replay reads one cross when given one and the 30-day listing otherwise', () => {
    const t = tool('oc_get_replay');
    expect(t.request({ cross: MINT })).toEqual({ method: 'GET', path: `/v1/replay/${MINT}` });
    expect(t.request({})).toEqual({ method: 'GET', path: '/v1/replay?days=30' });
    expect(t.request({ days: 7 })).toEqual({ method: 'GET', path: '/v1/replay?days=7' });
  });
});
