// One pass of the attester: for each configured asset read the policy, the last statement and the source, decide, and post. The policy is read from chain every time, so a policy that names another
// attester is never signed for. A source that fails is reported and nothing is posted for that asset; the others go on.
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { ATTESTATION_DISCRIMINATOR, POLICY_DISCRIMINATOR, getAttestationDecoder, getPolicyDecoder } from '@opening-cross/cross-backing-client';
import { CROSS_BACKING_PROGRAM_ADDRESS, backingAddresses, backingVerdict, buildAttestBacking } from '@opening-cross/sdk';
import type { AssetConfig, AttesterConfig } from './config.js';
import { planAttestation } from './attester.js';
import { type Reading, type SourceDeps, SourceError, readBacking } from './source.js';

export type AttesterDeps = SourceDeps & {
  signer: TransactionSigner;
  config: AttesterConfig;
  /** Sends one transaction and resolves with its signature; rejects with the program's reason. */
  send: (ixs: Instruction[]) => Promise<string>;
  dryRun?: boolean;
};

export type AssetOutcome =
  | { mint: Address; status: 'posted'; reason: string; backingAtoms: bigint; signature: string; verdictAfter: string; detail: string }
  | { mint: Address; status: 'planned'; reason: string; backingAtoms: bigint; detail: string }
  | { mint: Address; status: 'skipped'; code: string; message: string }
  | { mint: Address; status: 'failed'; code: string; message: string };

const starts = (data: Uint8Array, d: ArrayLike<number>) => Array.from(d).every((b, i) => data[i] === b);

export async function attestOnce(deps: AttesterDeps): Promise<AssetOutcome[]> {
  const out: AssetOutcome[] = [];
  for (const asset of deps.config.assets) out.push(await attestAsset(deps, asset));
  return out;
}

async function attestAsset(d: AttesterDeps, asset: AssetConfig): Promise<AssetOutcome> {
  const mint = asset.mint;
  const addr = await backingAddresses(mint);
  const policyAcct = await d.account(addr.policy);
  if (!policyAcct) return { mint, status: 'skipped', code: 'NO_POLICY', message: `${mint} has no backing policy on this cluster (cross_backing is not deployed there, or the issuer has not opted the asset in)` };
  if (policyAcct.owner !== CROSS_BACKING_PROGRAM_ADDRESS || !starts(policyAcct.data, POLICY_DISCRIMINATOR as Uint8Array)) return { mint, status: 'skipped', code: 'NO_POLICY', message: `the account at ${addr.policy} is not a backing policy` };
  const policy = getPolicyDecoder().decode(policyAcct.data);
  if (policy.mint !== mint) return { mint, status: 'skipped', code: 'NO_POLICY', message: 'the policy is for another mint' };

  const attAcct = await d.account(addr.attestation);
  let last: { backingAtoms: bigint; postedTs: bigint } | null = null;
  if (attAcct && attAcct.owner === CROSS_BACKING_PROGRAM_ADDRESS && starts(attAcct.data, ATTESTATION_DISCRIMINATOR as Uint8Array)) {
    const a = getAttestationDecoder().decode(attAcct.data);
    if (a.mint === mint) last = { backingAtoms: a.backingAtoms, postedTs: a.postedTs };
  }

  let reading: Reading;
  try {
    reading = await readBacking(asset.source, d);
  } catch (e) {
    if (e instanceof SourceError) return { mint, status: 'failed', code: e.code, message: `${e.message}; nothing was posted, so the last statement ages out and the asset halts if it is not fixed in time` };
    throw e;
  }

  const now = d.now();
  const decision = planAttestation({ signer: d.signer.address, policy: { attester: policy.attester, maxAgeSecs: policy.maxAgeSecs }, last, observed: reading.atoms, now }, d.config);
  if (!decision.post) {
    if (decision.reason === 'FRESH_ENOUGH' || decision.reason === 'TOO_SOON') return { mint, status: 'skipped', code: decision.reason, message: `the last statement is fresh enough (${reading.detail})` };
    if (decision.reason === 'NOT_OUR_POLICY') return { mint, status: 'failed', code: 'NOT_OUR_POLICY', message: `the policy names ${policy.attester} as its attester, not ${d.signer.address}; this key cannot attest it` };
    return { mint, status: 'failed', code: decision.reason, message: `the source reports ${reading.atoms} atoms, more than ${d.config.maxIncreaseFactor} times the last statement (${last?.backingAtoms}); an overstated reserve gives false comfort, so it is held until an operator confirms it (raise maxIncreaseFactor or post by hand)` };
  }
  if (d.dryRun) return { mint, status: 'planned', reason: decision.reason, backingAtoms: reading.atoms, detail: reading.detail };
  const ix = await buildAttestBacking({ attester: d.signer, mint, backingAtoms: reading.atoms });
  let signature: string;
  try {
    signature = await d.send([ix]);
  } catch (e) {
    return { mint, status: 'failed', code: 'SEND_FAILED', message: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  }
  // What the program will now say about this statement against the supply as it is: the operator sees at once whether the figure covers it.
  const supplyAcct = await d.account(mint);
  const supply = supplyAcct && supplyAcct.data.length >= 44 ? new DataView(supplyAcct.data.buffer, supplyAcct.data.byteOffset).getBigUint64(36, true) : null;
  const verdictAfter = supply === null ? 'unknown' : backingVerdict({ attestation: { backingAtoms: reading.atoms, postedTs: now }, supply, now, minCoverageBps: policy.minCoverageBps, maxAgeSecs: policy.maxAgeSecs });
  return { mint, status: 'posted', reason: decision.reason, backingAtoms: reading.atoms, signature, verdictAfter, detail: reading.detail };
}
