'use client';

import { useEffect, useState } from 'react';
import type { RulesRead, Standing } from '@/lib/holder-rules';
import { loadStanding } from '@/lib/holder-standing';
import type { CrossDetail } from '@/lib/types';

/** The connected wallet's standing under a cross's rules, read again when `version` changes (after an order is placed or cancelled). Null until read, and when no wallet is connected. */
export function useStanding(cross: CrossDetail, rules: RulesRead | null | undefined, owner: string | null, version: number): Standing | null {
  const [standing, setStanding] = useState<Standing | null>(null);
  const priorityGate = rules?.rules?.alloc.priorityGate ?? null;
  const needed = owner !== null && cross.state === 'Live' && Boolean(rules?.rules);
  useEffect(() => {
    if (!needed || !owner) {
      setStanding(null);
      return;
    }
    let live = true;
    void loadStanding({ cross: cross.address, owner, gated: cross.gateMint !== null, priorityGate, sealed: cross.disclosure === 'sealed' }).then((s) => live && setStanding(s));
    return () => {
      live = false;
    };
  }, [needed, owner, cross.address, cross.gateMint, cross.disclosure, priorityGate, version]);
  return standing;
}
