// `create_cross` and `set_rules` have to share one transaction (the rules are written in the slot the cross is created
// in, ADR-0450), and a transaction is 1,232 bytes at most. This pins the sizes a client meets, so that a field added to
// the rules cannot silently push the common case over the limit.
import { describe, expect, it } from 'vitest';
import {
  type Instruction,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CrossKind, Disclosure, SupplyMode, buildCreateCross, completeRules, crossAddress, getSetRulesInstruction, type RulesConfig } from '@opening-cross/sdk';

const LIMIT = 1_232;

async function size(rules: RulesConfig): Promise<number> {
  const creator = await generateKeyPairSigner();
  const [baseMint, quoteMint] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
  const crossId = 1n;
  const cross = await crossAddress(creator.address, crossId);
  const built = await buildCreateCross({
    creator, baseMint, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, crossId,
    kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n,
    openTs: 1n, closeTs: 100n, revealEndTs: 100n, referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: creator.address,
    gateMint: null, shards: 2, maxOrders: 32, proceedsTo: creator.address,
    schedule: [{ price: 1n, quantity: 1n }, { price: 2n, quantity: 1n }, { price: 3n, quantity: 1n }], settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
  });
  const ixs: Instruction[] = [built.create, getSetRulesInstruction({ creator, cross, ...completeRules(rules) })];
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(creator, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 1n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
  return Buffer.from(getBase64EncodedWireTransaction(tx), 'base64').length;
}

describe('create_cross and set_rules in one transaction', () => {
  it('fit the limit with no padding sent: no insiders and no extra feeds', async () => {
    expect(await size({})).toBeLessThanOrEqual(LIMIT);
  });

  it('fit with a drawn ending, a referral, a raise and a float guard, and one insider', async () => {
    const insider = (await generateKeyPairSigner()).address;
    const n = await size({
      ending: { endingSecs: 3_600, buckets: 4, randomEnd: true, cancelCutoffSecs: 600 },
      referral: { referrer: insider, shareBps: 2_500 },
      guards: { minRaiseQuote: 1_000_000n, minFloatBps: 1_000, totalSupply: 10n ** 12n },
      neutrality: { insiders: [insider] },
    });
    expect(n).toBeLessThanOrEqual(LIMIT);
  });

  it('grow by exactly the insiders named: padding is not sent', async () => {
    const keys = await Promise.all(Array.from({ length: 8 }, () => generateKeyPairSigner()));
    const none = await size({});
    const four = await size({ neutrality: { insiders: keys.slice(0, 4).map((k) => k.address) } });
    expect(four - none).toBe(4 * 32);
  });
});
