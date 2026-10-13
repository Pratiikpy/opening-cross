// Supply truth (F9): what the issuer says the supply is, what the chain says, and where the difference is. The issuer's side is a
// signed declaration; the chain's side is the mint account, the holders and the crosses that sold the token. Every finding states
// the numbers it compares. Nothing here says the supply is "safe"; it says what matches and what does not.
import { type Signed, verifyDocument } from '@opening-cross/attest';
import type { HolderReport } from './holders.js';

export const SUPPLY_SCHEMA = 'opening-cross/supply-declaration/v1';
export interface SupplyDeclarationBody {
  readonly [k: string]: string | number | undefined;
  readonly schema: typeof SUPPLY_SCHEMA;
  readonly mint: string;
  /** The total supply the issuer commits to, in token atoms, as a decimal string. */
  readonly totalSupply: string;
  /** Unix seconds the issuer made the declaration. */
  readonly asOf: number;
  /** Whether the issuer says more can ever be minted: "fixed" or "mintable". */
  readonly policy: 'fixed' | 'mintable';
}
export type SupplyDeclaration = Signed<SupplyDeclarationBody>;

export interface MintFacts {
  supply: bigint;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export interface SoldByCross {
  cross: string;
  kind: 'escrow' | 'mint' | 'deferred-mint';
  /** Base atoms that changed hands (the cross account's `baseSold`). */
  baseSold: bigint;
  state: string;
}

export type Severity = 'ok' | 'info' | 'warn' | 'high';
export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  evidence: Record<string, string>;
}

export interface SupplyReport {
  mint: string;
  onchainSupply: bigint;
  declaredSupply: bigint | null;
  findings: Finding[];
  /** Supply less burned, issuer-held, team-held and protocol-held tokens, among the holders listed. A lower bound on what the market can trade only if the listed holders are the whole picture, which `coveredBps` says. */
  circulating: { atoms: bigint; basis: string; coveredBps: number } | null;
}

export async function reconcileSupply(input: {
  mint: string;
  chain: MintFacts;
  declaration: SupplyDeclaration | null;
  /** The address expected to have signed: the mint authority, or the creator of the crosses. */
  expectedSigner?: string | null;
  holders?: HolderReport | null;
  crosses?: readonly SoldByCross[];
}): Promise<SupplyReport> {
  const { chain, declaration } = input;
  const f: Finding[] = [];
  let declared: bigint | null = null;

  if (!declaration) {
    f.push({ code: 'NO_DECLARATION', severity: 'info', message: 'The issuer has published no signed supply declaration, so there is nothing to reconcile against.', evidence: { onchainSupply: String(chain.supply) } });
  } else {
    const check = await verifyDocument(declaration as never, input.expectedSigner ?? undefined);
    if (!check.ok) {
      f.push({ code: 'DECLARATION_INVALID', severity: 'high', message: `The supply declaration does not verify (${check.reason}).`, evidence: { reason: check.reason, signer: declaration.signer } });
    } else if (declaration.body.mint !== input.mint) {
      f.push({ code: 'DECLARATION_WRONG_MINT', severity: 'high', message: 'The declaration is for a different mint.', evidence: { declaredFor: declaration.body.mint, asked: input.mint } });
    } else {
      declared = BigInt(declaration.body.totalSupply);
      if (declared === chain.supply) f.push({ code: 'SUPPLY_MATCHES', severity: 'ok', message: 'The on-chain supply equals the declared supply.', evidence: { supply: String(chain.supply), declaredAsOf: String(declaration.body.asOf) } });
      else f.push({ code: 'SUPPLY_DIFFERS', severity: 'high', message: `The on-chain supply (${chain.supply}) is ${chain.supply > declared ? 'above' : 'below'} the declared supply (${declared}).`, evidence: { onchain: String(chain.supply), declared: String(declared), difference: String(chain.supply > declared ? chain.supply - declared : declared - chain.supply) } });
      if (declaration.body.policy === 'fixed' && chain.mintAuthority) f.push({ code: 'FIXED_BUT_MINTABLE', severity: 'high', message: 'The issuer declares a fixed supply, but the mint authority is still set, so more can be minted.', evidence: { mintAuthority: chain.mintAuthority } });
      if (declaration.body.policy === 'fixed' && !chain.mintAuthority) f.push({ code: 'FIXED_AND_REVOKED', severity: 'ok', message: 'The issuer declares a fixed supply and the mint authority is revoked.', evidence: {} });
    }
  }
  if (chain.mintAuthority && (!declaration || declaration.body.policy !== 'fixed')) f.push({ code: 'MINT_AUTHORITY_SET', severity: 'warn', message: 'A mint authority can still create tokens.', evidence: { mintAuthority: chain.mintAuthority } });
  if (chain.freezeAuthority) f.push({ code: 'FREEZE_AUTHORITY_SET', severity: 'warn', message: 'A freeze authority can freeze holders\' token accounts.', evidence: { freezeAuthority: chain.freezeAuthority } });

  const sold = (input.crosses ?? []).reduce((s, c) => s + c.baseSold, 0n);
  if (input.crosses?.length) {
    if (sold > chain.supply) f.push({ code: 'SOLD_EXCEEDS_SUPPLY', severity: 'high', message: 'Crosses report selling more of the token than exists.', evidence: { sold: String(sold), supply: String(chain.supply) } });
    else f.push({ code: 'SOLD_WITHIN_SUPPLY', severity: 'ok', message: `Crosses sold ${sold} atoms, within the supply of ${chain.supply}.`, evidence: { sold: String(sold), supply: String(chain.supply), crosses: String(input.crosses.length) } });
  }

  let circulating: SupplyReport['circulating'] = null;
  if (input.holders) {
    const held = (kinds: string[]) => input.holders!.holders.filter((h) => kinds.includes(h.label.kind)).reduce((s, h) => s + h.amount, 0n);
    const out = held(['burn', 'issuer', 'team', 'protocol']);
    circulating = { atoms: chain.supply - out, basis: 'supply less burned, issuer, team and protocol-held tokens among the listed holders', coveredBps: input.holders.coveredBps };
    const issuerBps = input.holders.byKind.issuer?.shareBps ?? 0;
    const teamBps = input.holders.byKind.team?.shareBps ?? 0;
    if (issuerBps + teamBps >= 5_000) f.push({ code: 'INSIDER_MAJORITY', severity: 'warn', message: `The issuer and team hold ${(issuerBps + teamBps) / 100}% of the supply.`, evidence: { issuerBps: String(issuerBps), teamBps: String(teamBps) } });
  }
  return { mint: input.mint, onchainSupply: chain.supply, declaredSupply: declared, findings: f, circulating };
}
