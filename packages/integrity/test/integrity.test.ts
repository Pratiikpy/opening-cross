import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { signDocument } from '@opening-cross/attest';
import {
  BACKING_SCHEMA,
  BURN_ADDRESSES,
  PROTOCOL_AUTHORITIES,
  SUPPLY_SCHEMA,
  binomialUpperTail,
  buildBrief,
  checkBacking,
  clusterByFunding,
  findConflicts,
  inboundSol,
  labelOwner,
  organicVolume,
  parseClaims,
  rateCross,
  readHolders,
  reconcileSupply,
  trackRecord,
  traceFunding,
  verifyClaims,
  MemoryFundingCache,
  type Funding,
  type OrderFacts,
  type RpcLike,
} from '../src/index.js';

const w = (n: number) => `W${String(n).padStart(2, '0')}${'1'.repeat(40)}`; // stand-in addresses; nothing here needs them to be valid base58 keys
const fund = (wallet: string, funder: string | null, extra: Partial<Funding> = {}): Funding => ({ wallet, funder, lamports: funder ? 1_000_000n : null, signature: funder ? `sig-${wallet}` : null, blockTime: 1, ...(funder ? {} : { unknown: 'no-inbound-transfer' as const }), ...extra });

describe('labels', () => {
  it('the protocol authority constants are exactly those in the IDLs they cite', () => {
    for (const [address, { idl }] of Object.entries(PROTOCOL_AUTHORITIES)) {
      const text = readFileSync(new URL(`../../../${idl}`, import.meta.url), 'utf8');
      expect(text, `${idl} should contain ${address}`).toContain(`"${address}"`);
    }
  });
  it('labels each kind with the fact behind it, and lets a burn address override a claim', () => {
    expect(labelOwner({ address: '1nc1nerator11111111111111111111111111111111', accountOwner: null })).toMatchObject({ kind: 'burn' });
    expect(labelOwner({ address: w(1), accountOwner: null }, { issuer: { [w(1)]: 'mint authority of the token' } })).toEqual({ kind: 'issuer', name: 'Issuer', basis: 'mint authority of the token' });
    expect(labelOwner({ address: w(2), accountOwner: null }, { team: { [w(2)]: 'listed by the issuer' } }).kind).toBe('team');
    expect(labelOwner({ address: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', accountOwner: null })).toMatchObject({ kind: 'protocol', name: 'Meteora Dynamic Bonding Curve pool authority' });
    expect(labelOwner({ address: w(3), accountOwner: 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ' })).toMatchObject({ kind: 'protocol', name: 'Held by a Opening Cross core account' });
    expect(labelOwner({ address: w(4), accountOwner: 'SomeOtherProgram11111111111111111111111111111' }).kind).toBe('program-account');
    expect(labelOwner({ address: w(5), accountOwner: '11111111111111111111111111111111' }).kind).toBe('wallet');
    expect(labelOwner({ address: Object.keys(BURN_ADDRESSES)[0]!, accountOwner: null }, { issuer: { [Object.keys(BURN_ADDRESSES)[0]!]: 'x' } }).kind).toBe('burn');
  });
});

describe('readHolders', () => {
  const ISSUER = w(10);
  const rpc: RpcLike = {
    async call<T>(method: string, params: unknown[] = []) {
      const p = params[0];
      switch (method) {
        case 'getTokenSupply':
          return { value: { amount: '1000', decimals: 6 } } as T;
        case 'getTokenLargestAccounts':
          return { value: [{ address: 'TA1', amount: '400' }, { address: 'TA2', amount: '250' }, { address: 'TA3', amount: '100' }, { address: 'TA4', amount: '0' }] } as T;
        case 'getMultipleAccounts':
          if ((p as string[])[0] === 'TA1') return { value: ['TA1', 'TA2', 'TA3'].map((a, i) => ({ owner: 'Tokenkeg', lamports: 1, data: { parsed: { info: { owner: [ISSUER, 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', w(11)][i] } } } })) } as T;
          return { value: (p as string[]).map(() => null) } as T;
        default:
          throw new Error(method);
      }
    },
  };
  it('totals by kind and says how much of the supply the list covers', async () => {
    const r = await readHolders(rpc, 'MINT', { issuer: { [ISSUER]: 'mint authority' } });
    expect(r.holders.map((h) => [h.owner === ISSUER ? 'issuer' : h.label.kind, h.shareBps])).toEqual([['issuer', 4000], ['protocol', 2500], ['wallet', 1000]]);
    expect(r.coveredBps).toBe(7500);
    expect(r.byKind).toMatchObject({ issuer: { holders: 1, shareBps: 4000 }, protocol: { holders: 1, shareBps: 2500 } });
    expect(r.limits[0]).toMatch(/largest/);
  });
});

describe('funding', () => {
  const tx = (instructions: unknown[], inner: unknown[] = []) => ({ blockTime: 5, meta: { err: null, innerInstructions: [{ instructions: inner }] }, transaction: { message: { instructions } } }) as never;
  const transfer = (source: string, destination: string, lamports: number) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports } } });

  it('reads the first inbound SOL from system transfers and account creation, top level or inner', () => {
    expect(inboundSol(tx([transfer('A', 'B', 5)]), 'B')).toEqual({ from: 'A', lamports: 5n });
    expect(inboundSol(tx([], [transfer('A', 'B', 7)]), 'B')).toEqual({ from: 'A', lamports: 7n });
    expect(inboundSol(tx([{ program: 'system', parsed: { type: 'createAccount', info: { source: 'F', newAccount: 'B', lamports: 9 } } }]), 'B')).toEqual({ from: 'F', lamports: 9n });
    expect(inboundSol(tx([transfer('A', 'C', 5)]), 'B')).toBeNull();
    expect(inboundSol(tx([transfer('A', 'B', 0)]), 'B')).toBeNull();
  });

  const chain = (history: Record<string, { signature: string; err: unknown }[]>, txs: Record<string, unknown>): RpcLike => ({
    async call<T>(method: string, params: unknown[] = []) {
      if (method === 'getSignaturesForAddress') return (history[params[0] as string] ?? []) as T;
      if (method === 'getTransaction') return (txs[params[0] as string] ?? null) as T;
      throw new Error(method);
    },
  });

  it('traces the first funder from the oldest transactions, skips failed ones, and caches', async () => {
    let reads = 0;
    const rpc = chain({ B: [{ signature: 's3', err: null }, { signature: 's2', err: { x: 1 } }, { signature: 's1', err: null }] }, { s1: tx([transfer('FUNDER', 'B', 100)]), s2: tx([]), s3: tx([]) });
    const counting: RpcLike = { call: (m, p) => (reads++, rpc.call(m, p)) };
    const cache = new MemoryFundingCache();
    const f = await traceFunding(counting, 'B', { cache });
    expect(f).toMatchObject({ wallet: 'B', funder: 'FUNDER', lamports: 100n, signature: 's1' });
    const before = reads;
    await traceFunding(counting, 'B', { cache });
    expect(reads).toBe(before);
  });

  it('never guesses: no history, a history longer than the pages read, and no inbound transfer are each reported', async () => {
    expect(await traceFunding(chain({}, {}), 'X')).toMatchObject({ funder: null, unknown: 'no-history' });
    const long = Array.from({ length: 2 }, (_, i) => ({ signature: `s${i}`, err: null }));
    expect(await traceFunding(chain({ L: long }, {}), 'L', { pageSize: 2, maxPages: 1 })).toMatchObject({ funder: null, unknown: 'history-too-long' });
    expect(await traceFunding(chain({ N: [{ signature: 'n1', err: null }] }, { n1: tx([transfer('A', 'OTHER', 1)]) }), 'N')).toMatchObject({ funder: null, unknown: 'no-inbound-transfer' });
  });

  it('clusters wallets that share a funder, and wallets one of them funded', () => {
    const r = clusterByFunding([fund('A', 'F1'), fund('B', 'F1'), fund('C', 'A'), fund('D', 'F2'), fund('E', null)]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.members.sort()).toEqual(['A', 'B', 'C']);
    expect(r.clusters[0]!.links.map((l) => l.why).join(' ')).toMatch(/both received their first SOL from F1/);
    expect(r.clusters[0]!.links.map((l) => l.why).join(' ')).toMatch(/A sent C its first SOL/);
    expect(r.alone).toEqual(['D']);
    expect(r.unknownFunder).toEqual(['E']);
  });

  it('does not link wallets through a service: listed, or one that has funded many wallets', () => {
    const wallets = Array.from({ length: 6 }, (_, i) => fund(`P${i}`, 'FAUCET'));
    const byList = clusterByFunding(wallets, { serviceFunders: new Set(['FAUCET']) });
    expect(byList.clusters).toHaveLength(0);
    expect(byList.ignoredServices).toEqual([{ funder: 'FAUCET', funded: 6, why: 'listed as a service' }]);
    const byFanout = clusterByFunding(wallets, { fanout: new Map([['FAUCET', 4000]]) });
    expect(byFanout.clusters).toHaveLength(0);
    expect(byFanout.ignoredServices[0]!.why).toMatch(/funded 4000 wallets/);
    expect(clusterByFunding(wallets).clusters).toHaveLength(1); // without that knowledge they would be linked
  });

  it('totals the holdings of a cluster', () => {
    const r = clusterByFunding([fund('A', 'F'), fund('B', 'F')], { holdings: new Map([['A', 300], ['B', 450]]) });
    expect(r.clusters[0]!.shareBps).toBe(750);
  });
});

const PARTIES = { address: 'CROSS', creator: 'ISSUER', proceedsTo: 'TREASURY', integrator: 'FRONTEND', feeRecipient: 'PROTO', settler: null };
const order = (owner: string, side: 'buy' | 'sell', weight: bigint | null): OrderFacts => ({ owner, side, weight });

describe('conflicts', () => {
  it('flags the issuer, its payee, a wallet the issuer funded, a wallet sharing the issuer\'s funder, and declared team', () => {
    const fundings = new Map<string, Funding>([
      ['ISSUER', fund('ISSUER', 'ISSUERFUNDER')],
      ['FRIEND', fund('FRIEND', 'ISSUERFUNDER')],
      ['CHILD', fund('CHILD', 'ISSUER')],
      ['STRANGER', fund('STRANGER', 'OTHER')],
    ]);
    const orders = [order('ISSUER', 'sell', 100n), order('TREASURY', 'buy', 10n), order('CHILD', 'buy', 20n), order('FRIEND', 'buy', 30n), order('STRANGER', 'buy', 40n), order('TEAM1', 'buy', 50n), order('FRONTEND', 'buy', 5n)];
    const r = findConflicts({ parties: PARTIES, orders, fundings, declaredTeam: new Map([['TEAM1', 'listed as team in document 123']]) });
    expect(Object.keys(r.perOwner).sort()).toEqual(['CHILD', 'FRIEND', 'FRONTEND', 'ISSUER', 'TEAM1', 'TREASURY']);
    expect(r.perOwner.ISSUER![0]).toMatchObject({ kind: 'issuer', strength: 'high' });
    expect(r.perOwner.CHILD![0]).toMatchObject({ kind: 'funded-by-issuer', strength: 'high' });
    expect(r.perOwner.FRIEND![0]).toMatchObject({ kind: 'shares-funder-with-issuer', strength: 'medium' });
    expect(r.perOwner.FRONTEND![0]).toMatchObject({ kind: 'integrator', strength: 'medium' });
    expect(r.perOwner.STRANGER).toBeUndefined();
    expect(r.flagged.orders).toBe(6);
    expect(r.flagged.volumeBps).toBe(8431); // 215 of 255 atoms: everything but STRANGER's 40, rounded down
  });

  it('does not treat a service as an issuer link, and keeps unrevealed orders out of the volume share', () => {
    const fundings = new Map<string, Funding>([['ISSUER', fund('ISSUER', 'FAUCET')], ['USER', fund('USER', 'FAUCET')]]);
    const r = findConflicts({ parties: PARTIES, orders: [order('USER', 'buy', 10n), order('USER', 'buy', null)], fundings, serviceFunders: new Set(['FAUCET']) });
    expect(r.perOwner.USER).toBeUndefined();
    expect(r.unweightedOrders).toBe(1);
    expect(r.flagged.volumeBps).toBe(0);
  });
});

describe('organic volume and wash injection', () => {
  // A clean population: 30 independent bidders (15 buys, 15 sells), each funded by its own funder.
  const base = () => {
    const orders: OrderFacts[] = [];
    const fundings = new Map<string, Funding>();
    for (let i = 0; i < 30; i++) {
      orders.push(order(w(i), i % 2 ? 'sell' : 'buy', 100n));
      fundings.set(w(i), fund(w(i), `UNIQUE${i}`));
    }
    return { orders, fundings };
  };
  const run = (orders: OrderFacts[], fundings: Map<string, Funding>, serviceFunders = new Set<string>()) => {
    const conflicts = findConflicts({ parties: PARTIES, orders, fundings, serviceFunders });
    const clusters = clusterByFunding([...fundings.values()].filter((f) => orders.some((o) => o.owner === f.wallet)), { serviceFunders });
    return organicVolume(orders, conflicts, clusters, fundings);
  };

  it('a clean population scores fully organic at both bounds', () => {
    const { orders, fundings } = base();
    const r = run(orders, fundings);
    expect(r).toMatchObject({ lowerBps: 10_000, upperBps: 10_000, total: 3000n, experimental: true });
    expect(r.breadth.independentGroups).toBe(30);
    expect(r.barsUnmet.join(' ')).toMatch(/No Jito bundle data was gathered/);
  });

  it('injected sybils that bid on both sides from one funder pull both bounds down', () => {
    const { orders, fundings } = base();
    const clean = run(orders, fundings);
    for (let i = 0; i < 6; i++) {
      const s = `SYBIL${i}`;
      orders.push(order(s, i % 2 ? 'sell' : 'buy', 500n));
      fundings.set(s, fund(s, 'WASHFUNDER'));
    }
    const dirty = run(orders, fundings);
    expect(dirty.total).toBe(clean.total + 3000n);
    expect(dirty.lowerBps).toBeLessThan(clean.lowerBps);
    expect(dirty.upperBps).toBeLessThan(clean.upperBps);
    expect(dirty.crossSideClusters).toHaveLength(1);
    expect(dirty.crossSideClusters[0]).toMatchObject({ buy: 1500n, sell: 1500n, potentialSelfTrade: 1500n });
    expect(dirty.volume.crossSideSelfTrade).toBe(3000n); // the whole sybil volume, 1500 bought against 1500 sold
    expect(dirty.upperBps).toBe(Number((3000n * 10_000n) / 6000n)); // clean 3000 of 6000
    expect(dirty.breadth.independentGroups).toBe(31); // 30 independent wallets plus one cluster counted once
    expect(dirty.perOwner.SYBIL0).toBe('cross-side-cluster');
  });

  it('the issuer bidding on its own cross is removed from the upper bound', () => {
    const { orders, fundings } = base();
    orders.push(order('ISSUER', 'buy', 1000n));
    fundings.set('ISSUER', fund('ISSUER', 'IF'));
    const r = run(orders, fundings);
    expect(r.volume.conflicted).toBe(1000n);
    expect(r.upperBps).toBe(Number((3000n * 10_000n) / 4000n));
    expect(r.perOwner.ISSUER).toBe('conflicted');
  });

  it('a cluster on one side only, an untraced wallet and a service-funded wallet are not counted as shown organic', () => {
    const orders = [order('A', 'buy', 100n), order('B', 'buy', 100n), order('U', 'buy', 100n), order('S', 'buy', 100n), order('I', 'sell', 100n)];
    const fundings = new Map<string, Funding>([['A', fund('A', 'F')], ['B', fund('B', 'F')], ['U', fund('U', null)], ['S', fund('S', 'EXCHANGE')], ['I', fund('I', 'EI')]]);
    const r = run(orders, fundings, new Set(['EXCHANGE']));
    expect(r.perOwner).toEqual({ A: 'one-side-cluster', B: 'one-side-cluster', U: 'unknown-funder', S: 'service-funded', I: 'independent' });
    expect(r.lowerBps).toBe(2000);
    expect(r.serviceFundedBps).toBe(2000);
    expect(r.upperBps).toBe(10_000);
    expect(r.volume.unproven).toBe(300n);
  });

  it('abstains from volume when orders are not yet revealed', () => {
    const fundings = new Map<string, Funding>([['A', fund('A', 'F')]]);
    const r = run([order('A', 'buy', null)], fundings);
    expect(r.total).toBe(0n);
    expect(r.lowerBps).toBe(0);
    expect(r.unweightedOrders).toBe(1);
  });
});

describe('supply truth', () => {
  const chain = { supply: 1_000_000n, decimals: 6, mintAuthority: null, freezeAuthority: null };
  const body = (over: Record<string, string | number> = {}) => ({ schema: SUPPLY_SCHEMA, mint: 'MINT', totalSupply: '1000000', asOf: 1_800_000_000, policy: 'fixed' as const, ...over });

  it('matches a good declaration and says what it checked', async () => {
    const kp = await generateKeyPair();
    const signer = await getAddressFromPublicKey(kp.publicKey);
    const d = await signDocument(body(), kp);
    const r = await reconcileSupply({ mint: 'MINT', chain, declaration: d as never, expectedSigner: signer });
    expect(r.findings.map((f) => f.code)).toEqual(['SUPPLY_MATCHES', 'FIXED_AND_REVOKED']);
    expect(r.declaredSupply).toBe(1_000_000n);
  });

  it('flags a difference, a fixed supply that can still be minted, a wrong signer, a wrong mint and no declaration', async () => {
    const kp = await generateKeyPair();
    const other = await generateKeyPair();
    const otherAddr = await getAddressFromPublicKey(other.publicKey);
    const d = await signDocument(body({ totalSupply: '900000' }), kp);
    const r = await reconcileSupply({ mint: 'MINT', chain: { ...chain, mintAuthority: 'AUTH' }, declaration: d as never });
    expect(r.findings.map((f) => f.code)).toEqual(['SUPPLY_DIFFERS', 'FIXED_BUT_MINTABLE']);
    expect(r.findings[0]!.evidence).toMatchObject({ difference: '100000' });
    expect((await reconcileSupply({ mint: 'MINT', chain, declaration: d as never, expectedSigner: otherAddr })).findings[0]).toMatchObject({ code: 'DECLARATION_INVALID' });
    expect((await reconcileSupply({ mint: 'OTHER', chain, declaration: d as never })).findings[0]).toMatchObject({ code: 'DECLARATION_WRONG_MINT' });
    const none = await reconcileSupply({ mint: 'MINT', chain: { ...chain, freezeAuthority: 'F' }, declaration: null });
    expect(none.findings.map((f) => f.code)).toEqual(['NO_DECLARATION', 'FREEZE_AUTHORITY_SET']);
  });

  it('compares what crosses sold with the supply, and estimates circulating from the labelled holders', async () => {
    const holders = { holders: [{ amount: 300_000n, label: { kind: 'issuer' } }, { amount: 100_000n, label: { kind: 'burn' } }, { amount: 50_000n, label: { kind: 'wallet' } }], coveredBps: 4500, byKind: { issuer: { holders: 1, shareBps: 3000 }, team: { holders: 1, shareBps: 2500 } } } as never;
    const r = await reconcileSupply({ mint: 'MINT', chain, declaration: null, holders, crosses: [{ cross: 'c1', kind: 'escrow', baseSold: 200_000n, state: 'Finalized' }, { cross: 'c2', kind: 'mint', baseSold: 900_000n, state: 'Finalized' }] });
    expect(r.circulating).toMatchObject({ atoms: 600_000n, coveredBps: 4500 });
    expect(r.findings.map((f) => f.code)).toEqual(['NO_DECLARATION', 'SOLD_EXCEEDS_SUPPLY', 'INSIDER_MAJORITY']);
  });
});

describe('backing', () => {
  const policy = (signers: string[], now = 2_000_000_000) => ({ trustedAttesters: new Set(signers), now });
  const body = (over: Record<string, string | number> = {}) => ({ schema: BACKING_SCHEMA, mint: 'MINT', reserveAtoms: '1000', asOf: 2_000_000_000 - 3600, custodian: 'Example Custody', evidence: 'https://example.invalid/report', ...over });

  it('is verified only with a valid signature from a trusted attester, enough reserves and a fresh date', async () => {
    const kp = await generateKeyPair();
    const addr = await getAddressFromPublicKey(kp.publicKey);
    const att = (await signDocument(body(), kp)) as never;
    expect(await checkBacking('MINT', 1000n, att, policy([addr]))).toMatchObject({ status: 'verified', coverageBps: 10_000, ageSecs: 3600, custodian: 'Example Custody' });
    expect((await checkBacking('MINT', 1000n, att, policy(['someone-else']))).status).toBe('unverifiable');
    expect((await checkBacking('MINT', 1250n, att, policy([addr]))).status).toBe('undercollateralised');
    expect(await checkBacking('MINT', 1000n, att, { ...policy([addr], 2_000_000_000 + 8 * 86_400) })).toMatchObject({ status: 'stale' });
  });

  it('is unverifiable when there is nothing, it is for another mint, it is forged or it is dated in the future', async () => {
    const kp = await generateKeyPair();
    const addr = await getAddressFromPublicKey(kp.publicKey);
    expect((await checkBacking('MINT', 1n, null, policy([addr]))).reasons[0]).toMatch(/No backing attestation/);
    const other = (await signDocument(body({ mint: 'OTHER' }), kp)) as never;
    expect((await checkBacking('MINT', 1n, other, policy([addr]))).status).toBe('unverifiable');
    const forged = { ...((await signDocument(body(), kp)) as object), body: body({ reserveAtoms: '999999' }) } as never;
    expect((await checkBacking('MINT', 1n, forged, policy([addr]))).reasons[0]).toMatch(/does not verify/);
    const future = (await signDocument(body({ asOf: 2_000_000_000 + 99_999 }), kp)) as never;
    expect((await checkBacking('MINT', 1n, future, policy([addr]))).reasons[0]).toMatch(/future/);
  });
});

describe('rating and its track record', () => {
  const organic = (lowerBps: number, groups: number) => ({ lowerBps, upperBps: 10_000, breadth: { independentGroups: groups, owners: groups } }) as never;
  it('rates on the components it has, abstains when it has too few, and does not rate a live or unprinted cross', () => {
    const full = rateCross({ printed: true, organic: organic(8000, 12), conflicts: { flagged: { volumeBps: 1000 } } as never, clearing: { matched: 90n, demand: 100n, supply: 120n }, holders: { byKind: { issuer: { shareBps: 1000 }, team: { shareBps: 500 } } } as never, mintAuthority: null });
    expect(full).toMatchObject({ status: 'rated', coverage: 90 });
    expect(full.components.find((c) => c.name === 'breadth')!.score).toBe(60);
    expect(full.components.find((c) => c.name === 'clearing')!.score).toBe(75);
    expect(full.components.find((c) => c.name === 'openness')!.score).toBe(85);
    expect(full.score).toBe(Math.round((20 * 60 + 20 * 80 + 20 * 75 + 15 * 90 + 15 * 85) / 90));
    expect(rateCross({ printed: true, organic: organic(8000, 12) })).toMatchObject({ status: 'abstained', score: null, coverage: 40 });
    expect(rateCross({ printed: null }).status).toBe('unrated');
    expect(rateCross({ printed: false }).reason).toMatch(/without a price/);
  });

  it('adds backing to the rating only for a token that claims it', () => {
    const base = { printed: true as const, organic: organic(10_000, 20), conflicts: { flagged: { volumeBps: 0 } } as never, clearing: { matched: 1n, demand: 1n, supply: 1n }, mintAuthority: null };
    expect(rateCross(base).coverage).toBe(90);
    const withBacking = rateCross({ ...base, backing: { status: 'stale' } as never });
    expect(withBacking.coverage).toBe(100);
    expect(withBacking.components.find((c) => c.name === 'backing')!.score).toBe(40);
  });

  it('computes exact binomial tails', () => {
    expect(binomialUpperTail(10, 0, 0.5)).toBe(1);
    expect(binomialUpperTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 12);
    expect(binomialUpperTail(10, 8, 0.5)).toBeCloseTo((45 + 10 + 1) / 1024, 12);
  });

  const rows = (f: (i: number) => { score: number; outcomeBps: number }, n: number) => Array.from({ length: n }, (_, i) => ({ cross: `c${i}`, ...f(i) }));
  it('refuses to claim anything from a small sample', () => {
    const t = trackRecord(rows((i) => ({ score: i, outcomeBps: i - 5 }), 10));
    expect(t).toMatchObject({ status: 'insufficient-sample', hitRate: null });
    expect(t.statement).toMatch(/at least 20/);
  });
  it('says plainly when the rating does not beat chance', () => {
    // Outcomes unrelated to score: alternating sign by a pattern uncorrelated with the score ordering.
    const t = trackRecord(rows((i) => ({ score: (i * 7919) % 100, outcomeBps: ((i * 31) % 17) - 8 || 1 }), 60));
    expect(t.status).toBe('does-not-beat-chance');
    expect(t.statement).toMatch(/does NOT beat chance/);
  });
  it('recognises a rating that does predict, with the same seed giving the same answer', () => {
    const data = rows((i) => ({ score: i, outcomeBps: (i - 29.5) * 10 }), 60);
    const a = trackRecord(data);
    expect(a.status).toBe('beats-chance');
    expect(a.hitRate).toBe(1);
    expect(a.spearman).toBeCloseTo(1, 10);
    expect(trackRecord(data)).toEqual(a);
  });
  it('does not count a rating as better than the base rate when most outcomes are simply positive', () => {
    const t = trackRecord(rows((i) => ({ score: i, outcomeBps: i % 10 === 0 ? -5 : 5 }), 60));
    expect(t.baselineRate).toBeCloseTo(0.9, 10);
    expect(t.status).toBe('does-not-beat-chance');
  });
});

describe('the cited brief and the claim checker', () => {
  const facts = {
    cross: { address: 'CROSS', kind: 'Reopen', state: 'Finalized', baseMint: 'MINT', quoteMint: 'USDC', creator: 'ISSUER', ordersTotal: 12, protocolFeeBps: 5, clearing: { price: 1_550_000n, matched: 100_000_000n, demand: 120_000_000n, supply: 100_000_000n } },
    conflicts: { flagged: { orders: 2, ordersOfTotal: 12, volumeBps: 1250, byStrength: { high: 1, medium: 1 } } } as never,
  };
  it('writes only what the facts support, cites each statement, and lists what it could not say', () => {
    const b = buildBrief(facts);
    expect(b.generated).toBe('template');
    expect(b.statements[0]!.text).toBe('This is a Reopen cross with 12 orders, currently Finalized, charging a protocol fee of 5 bps.');
    expect(b.statements[1]!.text).toBe('It cleared at a price of 1550000 with 100000000 base atoms matched, against demand of 120000000 and supply of 100000000.');
    expect(b.statements[1]!.cites.map((c) => c.metric)).toEqual(['cross.clearing.price', 'cross.clearing.matched', 'cross.clearing.demand', 'cross.clearing.supply']);
    expect(b.statements[1]!.cites[0]).toMatchObject({ value: '1550000', source: expect.stringContaining('CROSS') });
    expect(b.statements.some((s) => /12.5%/.test(s.text))).toBe(true);
    expect(b.abstentions.join(' ')).toMatch(/Organic volume: not available/);
    expect(b.abstentions.join(' ')).toMatch(/Holders: not available/);
    expect(b.abstentions.join(' ')).toMatch(/Supply: not available/);
    // No sentence mentions a number that is not one of its cited values (or a count in the template itself).
    for (const s of b.statements) for (const n of s.text.match(/\d[\d.]*/g) ?? []) expect(JSON.stringify(s.cites) + s.text).toContain(n);
  });

  it('says a cross that did not print did not print', () => {
    const b = buildBrief({ ...facts, cross: { ...facts.cross, clearing: null, state: 'NoPrint', noPrintReason: 'BelowMinimumVolume' } });
    expect(b.statements[1]!.text).toBe('It ended without a price (BelowMinimumVolume).');
  });

  it('checks claims against the facts: supported, contradicted, or unverifiable', () => {
    const r = verifyClaims(
      [
        { id: 'a', metric: 'cross.clearing.price', op: '=', value: '1550000' },
        { id: 'b', metric: 'cross.ordersTotal', op: '=', value: '13' },
        { id: 'c', metric: 'conflicts.flaggedVolumeBps', op: '<=', value: '1000' },
        { id: 'd', metric: 'organic.lowerBps', op: '>=', value: '5000' },
        { id: 'e', metric: 'cross.state', op: '=', value: 'Finalized' },
        { id: 'f', metric: 'cross.state', op: '>=', value: 'Finalized' },
        { id: 'g', metric: 'cross.ordersTotal', op: '=', value: '12.5' },
      ],
      facts,
    );
    expect(r.map((x) => x.verdict)).toEqual(['supported', 'contradicted', 'contradicted', 'unverifiable', 'supported', 'unverifiable', 'unverifiable']);
    expect(r[1]).toMatchObject({ actual: '12' });
    expect(r[3]!.reason).toMatch(/No fact named organic.lowerBps/);
  });

  it('parses the sentences it understands and returns the rest instead of dropping them', () => {
    const { claims, unparsed } = parseClaims('The cross cleared at 1550000. It had 12 orders. The community loves this token. At most 1000 bps of volume was flagged.');
    expect(claims.map((c) => [c.metric, c.op, c.value])).toEqual([['cross.clearing.price', '=', '1550000'], ['cross.ordersTotal', '=', '12'], ['conflicts.flaggedVolumeBps', '<=', '1000']]);
    expect(unparsed).toEqual(['The community loves this token.']);
    expect(verifyClaims(claims, facts).map((r) => r.verdict)).toEqual(['supported', 'supported', 'contradicted']);
  });
});
