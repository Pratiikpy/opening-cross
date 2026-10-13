// Gate presets: the three ways an issuer can control who may place orders in a cross, in the terms the deployed cross_gate and
// cross_core programs actually enforce. A preset is a starting shape, not advice, and it carries no jurisdiction rules: which
// wallets an offering may admit is a legal question counsel answers for each offering (docs/HUMAN_TASKS.md HG1, HG2).
//
// What the programs do, and therefore all a preset can promise:
//  - A cross made with a `gateMint` accepts an order only from a wallet holding a cross_gate `Pass` for that mint (cross_core
//    `holds_gate_pass`). The check is that the pass account exists and belongs to the wallet; it is made when the order is placed.
//  - A pass comes from one of three places: the gate authority (`grant_pass`), an allowlist proof (`claim_pass_merkle`), or a SAS
//    attestation under the gate's credential and schema (`claim_pass`).
//  - Revoking: the authority revokes any pass (`revoke_pass`). Anyone revokes a SAS-backed pass once its attestation has expired
//    or been closed (`revoke_unattested`). Replacing the allowlist root does not remove passes already claimed.
export type GatePresetId = 'open' | 'allowlist' | 'attested-wallet';

/** What the issuer has to bring for the preset. */
export type GateInput = 'gate-mint' | 'allowlist' | 'sas-credential-and-schema';

export type GatePreset = {
  id: GatePresetId;
  name: string;
  summary: string;
  /** Whether the cross is created with a `gateMint`. `false` means any wallet may place an order. */
  gatedCross: boolean;
  /** cross_gate `Mode` of the gate's config; null when there is no gate. */
  mode: 'Open' | 'Allowlist' | null;
  /** How a wallet obtains its pass. */
  passRoute: 'none' | 'allowlist-proof' | 'sas-attestation';
  issuerBrings: readonly GateInput[];
  /** The program instructions the issuer's gate authority runs, in order, after the gate mint exists. */
  issuerSteps: readonly string[];
  /** What a bidder does, in one sentence. */
  walletDoes: string;
  limits: readonly string[];
};

export const GATE_PRESETS: readonly GatePreset[] = [
  {
    id: 'open',
    name: 'Open',
    summary: 'Any wallet may place an order. The cross is created without a gate.',
    gatedCross: false,
    mode: null,
    passRoute: 'none',
    issuerBrings: [],
    issuerSteps: [],
    walletDoes: 'Nothing: place an order.',
    limits: ['Nothing is checked about who bids. A wallet is not a person, so one person can bid from many wallets.'],
  },
  {
    id: 'allowlist',
    name: 'Allowlist',
    summary: 'Only wallets on a list the issuer publishes may place an order. The list is committed on chain as a Merkle root.',
    gatedCross: true,
    mode: 'Allowlist',
    passRoute: 'allowlist-proof',
    issuerBrings: ['gate-mint', 'allowlist'],
    issuerSteps: ['create_config (mode Allowlist)', 'set_allowlist_root (the root of the list)'],
    walletDoes: 'Claim a pass with the proof for the wallet (the Gates page does this), then place an order.',
    limits: [
      'The chain holds only the root. A wallet can claim only if the issuer also publishes the list so a proof can be built.',
      'A pass claimed earlier stays valid when the list changes, until the gate authority revokes it.',
      'The issuer decides who is on the list; this preset checks no identity.',
    ],
  },
  {
    id: 'attested-wallet',
    name: 'Attested wallet',
    summary: 'Only wallets holding a live attestation from a credential the issuer names (Solana Attestation Service) may place an order.',
    gatedCross: true,
    mode: 'Allowlist',
    passRoute: 'sas-attestation',
    issuerBrings: ['gate-mint', 'sas-credential-and-schema'],
    issuerSteps: ['create_config (mode Allowlist)', 'set_sas_requirement (credential and schema)'],
    walletDoes: 'Obtain an attestation for the wallet from the named credential, claim a pass with it (the Gates page does this), then place an order.',
    limits: [
      'What an attestation means is set by whoever holds the credential. The gate checks that it exists, is not expired and is for the wallet, not what it was issued for.',
      'When an attestation expires or is closed, anyone can revoke the pass it backed. Until someone does, the pass still admits the wallet.',
      'A devnet test attester that checks only control of the wallet is not an identity check.',
    ],
  },
];

export function gatePreset(id: string): GatePreset | null {
  return GATE_PRESETS.find((p) => p.id === id) ?? null;
}

export type GateSelection = {
  preset: GatePresetId;
  gateMint?: string | null;
  /** Allowlist root as 64 hex characters, once computed from the pasted addresses. */
  allowlistRootHex?: string | null;
  sas?: { credential: string; schema: string } | null;
};

/** What is still missing for the selection to be usable, in plain words. Empty means it is complete. */
export function missingForSelection(sel: GateSelection, isAddr: (s: string) => boolean): string[] {
  const p = gatePreset(sel.preset);
  if (!p) return ['Choose a gate preset.'];
  const out: string[] = [];
  if (p.issuerBrings.includes('gate-mint') && !(sel.gateMint && isAddr(sel.gateMint))) out.push('A gate mint address (the Token-2022 mint the gate config is created for).');
  if (p.issuerBrings.includes('allowlist') && !(sel.allowlistRootHex && /^[0-9a-f]{64}$/.test(sel.allowlistRootHex))) out.push('At least one valid wallet address for the allowlist.');
  if (p.issuerBrings.includes('sas-credential-and-schema') && !(sel.sas && isAddr(sel.sas.credential) && isAddr(sel.sas.schema))) out.push('The SAS credential and schema addresses.');
  return out;
}
