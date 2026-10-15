'use client';

// A gate as the chain holds it: its config account (authority, mode, the original pass routes) and the compliance rules in the
// extension after it, if the issuer switched them on. Read straight from the cluster; nothing here is stored.
import { CROSS_GATE_PROGRAM_ADDRESS, type Rules, findConfigPda, getGateConfigDecoder, readRules } from './gate-client';
import { readAccounts } from './rpc';

export type GateState = {
  mint: string;
  config: string;
  authority: string;
  mode: 'Allowlist' | 'Open';
  /** The original attestation route (`set_sas_requirement`), used while the gate has no rules. */
  sas: { credential: string; schema: string } | null;
  allowlistRoot: string | null;
  rules: Rules | null;
};

export type GateRead = { found: true; gate: GateState } | { found: false; reason: 'no-config' | 'foreign-owner' | 'unreadable' };

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Reads the gate of a token mint. `found: false` says why there is none, so a screen can tell a typo from a token with no gate. */
export async function readGate(mint: string): Promise<GateRead> {
  const [config] = await findConfigPda({ mint: mint as never });
  const [account] = await readAccounts([config]);
  if (!account) return { found: false, reason: 'no-config' };
  if (account.owner !== CROSS_GATE_PROGRAM_ADDRESS) return { found: false, reason: 'foreign-owner' };
  try {
    const c = getGateConfigDecoder().decode(account.data);
    return {
      found: true,
      gate: {
        mint,
        config,
        authority: c.authority,
        mode: c.mode === 1 ? 'Allowlist' : 'Open',
        sas: c.sas.__option === 'Some' ? { credential: c.sas.value.credential, schema: c.sas.value.schema } : null,
        allowlistRoot: c.allowlistRoot.__option === 'Some' ? hex(c.allowlistRoot.value) : null,
        rules: readRules(account.data),
      },
    };
  } catch {
    return { found: false, reason: 'unreadable' };
  }
}
