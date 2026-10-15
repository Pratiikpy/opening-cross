// The gate sweep (gate-sweep.ts): the planner on its own, then a whole sweep over an in-memory set of gate accounts. The instructions it sends are checked by
// discriminator and by the accounts they name; that `cross_gate` accepts them is proved by the LiteSVM suite of the client package (test/svm/gate-rules.test.ts).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, getAddressDecoder, getAddressEncoder } from '@solana/kit';
import {
  CROSS_GATE_PROGRAM_ADDRESS,
  FLAG,
  SAS_PROGRAM_ADDRESS,
  SOURCE,
  Tier,
  buildRules,
  countryNumeric,
  findAttestationAddress,
  findDeniedAddress,
  findPassAddress,
  findTermsAddress,
  getRulesDecoder,
  getRulesEncoder,
  getTermsEncoder,
} from '@opening-cross/cross-gate-client';
import { CONFIG_WITH_RULES_SIZE, TERMS_ACCOUNT_SIZE, runGateSweep, sweepReason } from '../src/gate-sweep.js';

const key = (label: string): Address => getAddressDecoder().decode(createHash('sha256').update(`gate sweep: ${label}`).digest());
const MINT = key('mint');
const CREDENTIAL = key('credential');
const SCHEMA = key('schema');
const NOW = 1_800_000_000n;
const INDIA = countryNumeric('IN')!;
const USA = countryNumeric('US')!;

/** The discriminator of an Anchor instruction. */
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const named = (ix: Instruction) => ['revoke_expired', 'revoke_nonconforming', 'revoke_denied'].find((n) => Buffer.from(ix.data!.subarray(0, 8)).equals(disc(n)));

function configWithRules(over: Parameters<typeof buildRules>[0] = {}): Uint8Array {
  const rules = buildRules({ countryPolicy: 'deny', countries: ['US'], minTier: Tier.retail, requiredFlags: FLAG.kyc, identity: { credential: CREDENTIAL, schema: SCHEMA }, ...over });
  const body = getRulesEncoder().encode(rules);
  const data = new Uint8Array(CONFIG_WITH_RULES_SIZE);
  data.set(getAddressEncoder().encode(MINT), 8);
  data[172] = 0xe1;
  data.set(body, 173);
  return data;
}
const terms = (owner: Address, over: Partial<Parameters<ReturnType<typeof getTermsEncoder>['encode']>[0]> = {}) =>
  getTermsEncoder().encode({ mint: MINT, owner, identity: new Uint8Array(32).fill(9), country: INDIA, tier: Tier.retail, flags: FLAG.kyc, cap: 0n, source: SOURCE.sas, issuedTs: 1n, expiresTs: 0n, bump: 255, ...over });

describe('sweepReason', () => {
  const rules = (over: Parameters<typeof buildRules>[0] = {}) => {
    // The rules as the program stores them: encoded, then decoded, so an absent attester is the option the sweep reads.
    return getRulesDecoder().decode(getRulesEncoder().encode(buildRules({ countryPolicy: 'deny', countries: ['US'], minTier: Tier.retail, requiredFlags: FLAG.kyc, identity: { credential: CREDENTIAL, schema: SCHEMA }, ...over })));
  };
  const pass = (over: Partial<{ country: number; tier: number; flags: number; source: number; expiresTs: bigint }> = {}) => ({ mint: MINT, owner: key('o'), identity: new Uint8Array(32), country: INDIA, tier: Tier.retail, flags: FLAG.kyc, source: SOURCE.sas, expiresTs: 0n, ...over });
  const f = (over: { rules?: ReturnType<typeof rules>; pass?: ReturnType<typeof pass>; attestationLive?: boolean; denied?: boolean } = {}) => ({ now: NOW, rules: rules(), pass: pass(), attestationLive: true, denied: false, ...over });

  it('leaves a pass that is in order alone', () => {
    expect(sweepReason(f())).toBeNull();
    // An authority-granted pass does not depend on an attestation, however dead the attestation is.
    expect(sweepReason(f({ pass: pass({ source: SOURCE.authority }), attestationLive: false }))).toBeNull();
  });

  it('closes a denied wallet first, then a lapsed pass, then a vanished attestation, then a pass the rules now refuse', () => {
    expect(sweepReason(f({ denied: true, pass: pass({ expiresTs: 1n }) }))).toBe('denied');
    expect(sweepReason(f({ pass: pass({ expiresTs: NOW }), attestationLive: false }))).toBe('expired');
    expect(sweepReason(f({ pass: pass({ expiresTs: NOW - 1n }) }))).toBe('expired');
    expect(sweepReason(f({ pass: pass({ expiresTs: NOW + 1n }) }))).toBeNull();
    expect(sweepReason(f({ attestationLive: false }))).toBe('attestation-gone');
    expect(sweepReason(f({ pass: pass({ country: USA }) }))).toBe('nonconforming');
    expect(sweepReason(f({ pass: pass({ flags: 0 }) }))).toBe('nonconforming');
    expect(sweepReason(f({ rules: rules({ minTier: Tier.accredited }) }))).toBe('nonconforming');
  });

  it('does not close for a vanished attestation when the gate names no attester', () => {
    expect(sweepReason(f({ rules: rules({ identity: null }), attestationLive: false }))).toBeNull();
  });
});

describe('runGateSweep', () => {
  const owners = { fine: key('fine'), expired: key('expired'), gone: key('gone'), american: key('american'), denied: key('denied'), granted: key('granted') };
  const attestation = async (owner: Address) => (await findAttestationAddress(CREDENTIAL, SCHEMA, owner))[0];
  /** A live SAS attestation account: owned by SAS, discriminator 2, a payload, and an expiry of never. */
  function sasAccount(): { data: Uint8Array; owner: Address } {
    const data = new Uint8Array(101 + 44 + 32 + 8 + 8);
    data[0] = 2;
    new DataView(data.buffer).setUint32(97, 44, true);
    return { data, owner: SAS_PROGRAM_ADDRESS };
  }

  async function world() {
    const accounts = new Map<Address, { data: Uint8Array; owner: Address }>();
    const termsAccounts: { address: Address; data: Uint8Array }[] = [];
    for (const [name, owner] of Object.entries(owners)) {
      const over: Record<string, unknown> =
        name === 'expired' ? { expiresTs: NOW - 10n } : name === 'american' ? { country: USA } : name === 'granted' ? { source: SOURCE.authority } : {};
      termsAccounts.push({ address: (await findTermsAddress(MINT, owner))[0], data: new Uint8Array(terms(owner, over)) });
      // every wallet but `gone` and `granted` has a live attestation
      if (name !== 'gone' && name !== 'granted') accounts.set(await attestation(owner), sasAccount());
    }
    accounts.set((await findDeniedAddress(MINT, owners.denied))[0], { data: new Uint8Array(8 + 32 + 32 + 1 + 8 + 1), owner: CROSS_GATE_PROGRAM_ADDRESS });
    const sent: { ix: Instruction; kind: string | undefined }[] = [];
    const deps = {
      now: async () => NOW,
      program: async (size: number) => (size === CONFIG_WITH_RULES_SIZE ? [{ address: key('config'), data: configWithRules() }] : size === TERMS_ACCOUNT_SIZE ? termsAccounts : []),
      fetch: async (a: Address) => accounts.get(a) ?? null,
      send: async (ixs: Instruction[]) => {
        for (const ix of ixs) sent.push({ ix, kind: named(ix) });
        return `sig${sent.length}`;
      },
    };
    return { deps, sent, accounts };
  }

  it('closes exactly the passes that may be closed, each with the instruction for its reason, and none that are in order', async () => {
    const w = await world();
    const r = await runGateSweep(w.deps);
    expect(r.checked).toBe(6);
    expect(r.failed).toEqual([]);
    expect(Object.fromEntries(r.closed.map((c) => [c.owner, c.kind]))).toEqual({
      [owners.expired]: 'expired',
      [owners.gone]: 'attestation-gone',
      [owners.american]: 'nonconforming',
      [owners.denied]: 'denied',
    });
    expect(w.sent.map((s) => s.kind).sort()).toEqual(['revoke_denied', 'revoke_expired', 'revoke_expired', 'revoke_nonconforming']);
    // Each instruction names the pass it closes (the pass PDA is one of its accounts) and goes to the gate program.
    for (const c of r.closed) {
      const ix = w.sent.find((s) => s.ix.accounts?.some((a) => a.address === c.owner))!.ix;
      expect(ix.programAddress).toBe(CROSS_GATE_PROGRAM_ADDRESS);
      expect(ix.accounts!.map((a) => a.address)).toContain((await findPassAddress(MINT, c.owner))[0]);
    }
  });

  it('a dry run names what it would close and sends nothing', async () => {
    const w = await world();
    const r = await runGateSweep({ ...w.deps, dryRun: true });
    expect(r.closed).toEqual([]);
    expect(r.wouldClose).toHaveLength(4);
    expect(w.sent).toEqual([]);
  });

  it('reports a refused close as failed with the first line of the reason, and still closes the rest', async () => {
    const w = await world();
    let n = 0;
    const r = await runGateSweep({
      ...w.deps,
      send: async (ixs) => {
        n++;
        if (n === 1) throw new Error('Transaction simulation failed: custom program error 0x1790\nLogs: ...');
        return w.deps.send(ixs);
      },
    });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toBe('Transaction simulation failed: custom program error 0x1790');
    expect(r.closed).toHaveLength(3);
  });

  it('ignores the passes of a gate without rules and does nothing when no gate has rules', async () => {
    const w = await world();
    expect((await runGateSweep({ ...w.deps, program: async (size) => (size === TERMS_ACCOUNT_SIZE ? await w.deps.program(size) : []) })).checked).toBe(0);
    const otherMint = key('other mint');
    const stray = getTermsEncoder().encode({ mint: otherMint, owner: owners.fine, identity: new Uint8Array(32), country: USA, tier: 0, flags: 0, cap: 0n, source: SOURCE.sas, issuedTs: 1n, expiresTs: 1n, bump: 255 });
    const r = await runGateSweep({ ...w.deps, program: async (size) => (size === TERMS_ACCOUNT_SIZE ? [{ address: key('stray'), data: new Uint8Array(stray) }] : await w.deps.program(size)) });
    expect(r.checked).toBe(0);
    expect(r.closed).toEqual([]);
  });

  it('a second sweep over the same chain closes nothing once the first has been applied', async () => {
    const w = await world();
    const first = await runGateSweep(w.deps);
    const closedOwners = new Set(first.closed.map((c) => c.owner));
    const remaining = (await w.deps.program(TERMS_ACCOUNT_SIZE)).filter((t) => !closedOwners.has(getAddressDecoder().decode(t.data.slice(40, 72))));
    const second = await runGateSweep({ ...w.deps, program: async (size) => (size === TERMS_ACCOUNT_SIZE ? remaining : await w.deps.program(size)) });
    expect(second.checked).toBe(2);
    expect(second.closed).toEqual([]);
  });
});
