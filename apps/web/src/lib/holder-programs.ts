'use client';

// Which release of the on-chain programs the connected cluster runs (GET /v1/programs). The rules, classes, lockups, votes, NAV redemption
// and distributions are proved on LiteSVM and a local validator and are not deployed to devnet until the operations key is funded
// (docs/HUMAN_TASKS.md H27). A screen that depends on them asks here, says plainly what it finds, and offers no action the deployed program
// would refuse. An answer of "unknown" is never turned into "first release": an unreadable program is not reported as an old one.
import { useEffect, useState } from 'react';
import { API_URL } from './api';

export type ProgramReport = {
  address: string;
  deployedSlot: string | null;
  extended: boolean | null;
  checked: { instruction: string; present: boolean }[];
  note: string;
};
export type Programs = { network?: string; checkedAt: number; programs: { crossCore: ProgramReport; treasury: ProgramReport } };

/** `extended`: the program has the extension. `first-release`: it does not. `unknown`: not read, so nothing is said either way. */
export type Release = 'extended' | 'first-release' | 'unknown';

export const releaseOf = (p: ProgramReport | null | undefined): Release => (!p || p.extended === null ? 'unknown' : p.extended ? 'extended' : 'first-release');

export async function loadPrograms(): Promise<Programs | null> {
  try {
    const r = await fetch(`${API_URL}/v1/programs`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as Programs) : null;
  } catch {
    return null;
  }
}

/** The release of both programs; `null` until it has been asked, `'unavailable'` when the API has no such route or could not be reached. */
export function usePrograms(): Programs | null | 'unavailable' {
  const [state, setState] = useState<Programs | null | 'unavailable'>(null);
  useEffect(() => {
    let live = true;
    void loadPrograms().then((p) => live && setState(p ?? 'unavailable'));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** The sentence a screen shows when the program it needs is the first release. */
export function firstReleaseSentence(what: string): string {
  return `${what} is built and proved on LiteSVM and a local validator, but the program deployed on this network is still the first release, so it cannot do this yet. It goes live when the upgrade is funded (H27).`;
}
