// Gate upkeep (ADR-0900): closes the passes that anyone may close.
//
// A pass whose terms have lapsed, whose SAS identity attestation was closed or expired, that no longer satisfies tightened rules, or whose wallet was denied is dead weight and, for the
// last two, a compliance problem. `cross_gate` lets any signer close it and returns the rent to the pass owner, so a keeper does it for free. This sweep is separate from the cross
// duties of keeper.ts: it needs no cross, only the gate's own accounts, and it never touches a pass that is in order.
//
// The planner (`sweepReason`) is pure and mirrors the program's checks in the order the program makes them; the program is the authority, and a pass the planner would close but the
// program refuses (a clock that disagrees by a second, an attestation renewed in between) is reported as `failed` and looked at again on the next pass.
import { type Address, type Instruction, getAddressDecoder } from '@solana/kit';
import {
  CROSS_GATE_PROGRAM_ADDRESS,
  CONFIG_BASE_SIZE,
  RULES_EXT_SIZE,
  type Rules,
  SOURCE,
  conforms,
  findAttestationAddress,
  findDeniedAddress,
  getTermsDecoder,
  liveAttestation,
  readRules,
  revokeDenied,
  revokeExpired,
  revokeNonconforming,
} from '@opening-cross/cross-gate-client';

export type SweepKind = 'expired' | 'attestation-gone' | 'nonconforming' | 'denied';

export type PassTerms = {
  mint: Address;
  owner: Address;
  identity: Uint8Array;
  country: number;
  tier: number;
  flags: number;
  /** 1 = SAS attestation; the others do not depend on an attestation. */
  source: number;
  /** Unix seconds, 0 = never. */
  expiresTs: bigint;
};

export type SweepFacts = {
  now: bigint;
  rules: Pick<Rules, 'countryPolicy' | 'countries' | 'minTier' | 'requiredFlags' | 'identity'>;
  pass: PassTerms;
  /** Whether the pass owner's SAS identity attestation is live. Ignored unless the pass came from an attestation. */
  attestationLive: boolean;
  denied: boolean;
};

/** Why this pass may be closed, or null. A denial wins, then a lapse, then a vanished attestation, then a rule the terms no longer meet. */
export function sweepReason(f: SweepFacts): SweepKind | null {
  if (f.denied) return 'denied';
  const p = f.pass;
  if (p.expiresTs !== 0n && f.now >= p.expiresTs) return 'expired';
  if (p.source === SOURCE.sas && f.rules.identity.__option === 'Some' && !f.attestationLive) return 'attestation-gone';
  if (!conforms(f.rules, p).ok) return 'nonconforming';
  return null;
}

export type Sweepable = {
  kind: SweepKind;
  mint: Address;
  owner: Address;
  identity: Uint8Array;
  /** The gate's identity attester, read by `revoke_expired` to see whether the attestation is gone. */
  identitySas: { credential: Address; schema: Address } | null;
};

export function instructionFor(s: Sweepable): Promise<Instruction> {
  const base = { mint: s.mint, owner: s.owner, identity: s.identity, identitySas: s.identitySas };
  switch (s.kind) {
    case 'expired':
    case 'attestation-gone':
      return revokeExpired(base);
    case 'nonconforming':
      return revokeNonconforming(base);
    case 'denied':
      return revokeDenied(base);
  }
}

export type SweepDeps = {
  /** Cluster time in unix seconds. */
  now: () => Promise<bigint>;
  /** Every account of `cross_gate` with this data size (getProgramAccounts with a size filter). */
  program: (dataSize: number) => Promise<{ address: Address; data: Uint8Array }[]>;
  fetch: (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
  send: (ixs: Instruction[]) => Promise<string>;
  /** Report only: plan and name what would be closed, send nothing. */
  dryRun?: boolean;
};

export type SweepResult = {
  closed: { kind: SweepKind; owner: Address; mint: Address; signature: string }[];
  /** Passes a dry run would have closed. */
  wouldClose: { kind: SweepKind; owner: Address; mint: Address }[];
  failed: { owner: Address; mint: Address; error: string }[];
  /** Terms accounts of gates that have rules. */
  checked: number;
};

/** A `Terms` account: 8 + 32 + 32 + 32 + 2 + 1 + 1 + 8 + 1 + 8 + 8 + 1. */
export const TERMS_ACCOUNT_SIZE = 134;
/** A gate config account that carries rules. */
export const CONFIG_WITH_RULES_SIZE = CONFIG_BASE_SIZE + RULES_EXT_SIZE;

export async function runGateSweep(d: SweepDeps): Promise<SweepResult> {
  const now = await d.now();
  const out: SweepResult = { closed: [], wouldClose: [], failed: [], checked: 0 };
  const rulesByMint = new Map<string, Rules>();
  const addr = getAddressDecoder();
  for (const cfg of await d.program(CONFIG_WITH_RULES_SIZE)) {
    const rules = readRules(cfg.data);
    // The mint is the first field after the account discriminator.
    if (rules) rulesByMint.set(addr.decode(cfg.data.slice(8, 40)), rules);
  }
  if (rulesByMint.size === 0) return out;
  for (const t of await d.program(TERMS_ACCOUNT_SIZE)) {
    const terms = getTermsDecoder().decode(t.data);
    const rules = rulesByMint.get(terms.mint);
    // The pass of a gate whose rules were never switched on has no business here.
    if (!rules) continue;
    out.checked++;
    const identity = Uint8Array.from(terms.identity);
    const identitySas = rules.identity.__option === 'Some' ? rules.identity.value : null;
    let attestationLive = true;
    if (terms.source === SOURCE.sas && identitySas) {
      const [attestation] = await findAttestationAddress(identitySas.credential, identitySas.schema, terms.owner);
      attestationLive = liveAttestation(await d.fetch(attestation), now).state === 'live';
    }
    const [deniedAddress] = await findDeniedAddress(terms.mint, terms.owner);
    const denial = await d.fetch(deniedAddress);
    const reason = sweepReason({
      now,
      rules,
      pass: { mint: terms.mint, owner: terms.owner, identity, country: terms.country, tier: terms.tier, flags: terms.flags, source: terms.source, expiresTs: terms.expiresTs },
      attestationLive,
      denied: !!denial && denial.owner === CROSS_GATE_PROGRAM_ADDRESS && denial.data.length > 0,
    });
    if (!reason) continue;
    if (d.dryRun) {
      out.wouldClose.push({ kind: reason, owner: terms.owner, mint: terms.mint });
      continue;
    }
    try {
      const ix = await instructionFor({ kind: reason, mint: terms.mint, owner: terms.owner, identity, identitySas });
      out.closed.push({ kind: reason, owner: terms.owner, mint: terms.mint, signature: await d.send([ix]) });
    } catch (e) {
      out.failed.push({ owner: terms.owner, mint: terms.mint, error: String(e instanceof Error ? e.message.split('\n')[0] : e) });
    }
  }
  return out;
}
