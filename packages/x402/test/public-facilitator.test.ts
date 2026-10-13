// The facilitator client against a public facilitator that exists today (x402.org/facilitator, run by the x402 project):
// its /supported answer must parse and name a Solana devnet fee payer, and a malformed /verify must come back as a refusal in
// the shape this repository parses. Skips when the network is unreachable. No payment is made: the public facilitator
// settles on devnet and the faucet is not available to this suite; see docs/evidence/X6-integration-tests.md for what that leaves unproven.
import { describe, expect, it } from 'vitest';
import { HttpFacilitator } from '../src/facilitator-http.js';
import { WELL_KNOWN_NETWORKS } from '../src/network.js';

const URL_ = process.env.X402_PUBLIC_FACILITATOR ?? 'https://x402.org/facilitator';
const online = await fetch(`${URL_}/supported`, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok, () => false);

describe.skipIf(!online)('public facilitator', () => {
  const f = new HttpFacilitator(URL_);

  it('lists Solana devnet under the CAIP-2 identifier this package derives, with a fee payer and its signer', async () => {
    const s = await f.supported();
    const kind = s.kinds.find((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === WELL_KNOWN_NETWORKS.devnet);
    expect(kind, JSON.stringify(s.kinds.map((k) => k.network))).toBeDefined();
    expect(kind!.extra?.feePayer).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(s.signers['solana:*']).toContain(kind!.extra!.feePayer);
  });

  it('refuses an unusable payment in the shape of a verify response, and does not throw', async () => {
    const accepted = { scheme: 'exact' as const, network: WELL_KNOWN_NETWORKS.devnet, amount: '1', asset: '11111111111111111111111111111112', payTo: '11111111111111111111111111111112', maxTimeoutSeconds: 60, extra: { feePayer: '11111111111111111111111111111112' } };
    const res = await f.verify({ x402Version: 2, accepted, payload: { transaction: 'AQID' } }, accepted);
    expect(res.isValid).toBe(false);
    expect(typeof res.invalidReason).toBe('string');
  });
});
