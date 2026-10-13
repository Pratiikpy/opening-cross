// The gate field of the issuer console: what the issuer has chosen, and what is still missing. The preset definitions
// (packages/presets) are served by the API at GET /v1/gates/presets; this file holds only the form's own state.
import { isAddress } from '@solana/kit';

export type GatePresetView = {
  id: 'open' | 'allowlist' | 'attested-wallet';
  name: string;
  summary: string;
  gatedCross: boolean;
  mode: 'Open' | 'Allowlist' | null;
  passRoute: 'none' | 'allowlist-proof' | 'sas-attestation';
  issuerBrings: ('gate-mint' | 'allowlist' | 'sas-credential-and-schema')[];
  issuerSteps: string[];
  walletDoes: string;
  limits: string[];
};

export type GateFieldValue = {
  preset: GatePresetView['id'];
  /** The Token-2022 mint the gate config is created for; the cross is created with it as `gateMint`. */
  gateMint: string;
  /** Pasted allowlist, any separators. */
  addresses: string;
  credential: string;
  schema: string;
};

export const EMPTY_GATE: GateFieldValue = { preset: 'open', gateMint: '', addresses: '', credential: '', schema: '' };

export type GateSummary = {
  /** `gateMint` to send with create-cross, or null for an open cross. */
  gateMint: string | null;
  /** 64 hex characters, once the allowlist has a root. */
  allowlistRoot: string | null;
  complete: boolean;
  missing: string[];
};

/** What the issuer still has to supply for the chosen preset; `allowlistRoot` comes from the API's preview of the pasted list. */
export function summarize(v: GateFieldValue, preset: GatePresetView | undefined, allowlistRoot: string | null): GateSummary {
  if (!preset) return { gateMint: null, allowlistRoot: null, complete: false, missing: ['Choose a gate.'] };
  if (!preset.gatedCross) return { gateMint: null, allowlistRoot: null, complete: true, missing: [] };
  const missing: string[] = [];
  const mintOk = isAddress(v.gateMint.trim());
  if (!mintOk) missing.push('The gate mint address (the Token-2022 mint the gate config is created for).');
  if (preset.issuerBrings.includes('allowlist') && !allowlistRoot) missing.push('At least one valid wallet address for the allowlist.');
  if (preset.issuerBrings.includes('sas-credential-and-schema') && !(isAddress(v.credential.trim()) && isAddress(v.schema.trim()))) missing.push('The attestation credential and schema addresses.');
  return { gateMint: mintOk ? v.gateMint.trim() : null, allowlistRoot: preset.issuerBrings.includes('allowlist') ? allowlistRoot : null, complete: missing.length === 0, missing };
}
