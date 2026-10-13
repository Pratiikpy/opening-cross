'use client';

import { useEffect, useState } from 'react';
import { getJson } from '@/lib/holder-standing';
import type { IndicativeRead, RulesRead } from '@/lib/holder-rules';

/** GET /v1/crosses/:address/rules, read again whenever `version` changes. `undefined` until the first answer; `null` when the API could not answer. */
export function useRules(address: string, version: number): RulesRead | null | undefined {
  const [read, setRead] = useState<RulesRead | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void getJson<RulesRead>(`/v1/crosses/${address}/rules`).then((r) => live && setRead(r));
    return () => {
      live = false;
    };
  }, [address, version]);
  return read;
}

/** GET /v1/crosses/:address/indicative while `enabled`: the figures the page shows in the ending period instead of the book's. */
export function useIndicative(address: string, enabled: boolean, version: number): IndicativeRead | null {
  const [read, setRead] = useState<IndicativeRead | null>(null);
  useEffect(() => {
    if (!enabled) {
      setRead(null);
      return;
    }
    let live = true;
    void getJson<IndicativeRead>(`/v1/crosses/${address}/indicative`).then((r) => live && setRead(r));
    return () => {
      live = false;
    };
  }, [address, enabled, version]);
  return read;
}
