'use client';

import { useEffect, useState } from 'react';
import { type RemoteCheck, type SizeResult, checkRulesRemote, measureCreation } from '@/lib/issuer-rules';

export type Verdict<T> = { state: 'idle' } | { state: 'pending' } | { state: 'done'; result: T };

/**
 * Asks the API about the rules in the form, a moment after the person stops typing: first the SDK's rules check (POST /v1/rules/check, nothing is
 * built), then, when a wallet is connected, the size of the creation (POST /v1/tx/create-cross-ruled, built and never signed). A body of `null` means
 * the question cannot be asked yet.
 */
export function useRulesVerdict(checkBody: Record<string, unknown> | null, sizeBody: Record<string, unknown> | null, delayMs = 450): { check: Verdict<RemoteCheck>; size: Verdict<SizeResult> } {
  const [check, setCheck] = useState<Verdict<RemoteCheck>>({ state: 'idle' });
  const [size, setSize] = useState<Verdict<SizeResult>>({ state: 'idle' });
  const checkKey = checkBody ? JSON.stringify(checkBody) : null;
  const sizeKey = sizeBody ? JSON.stringify(sizeBody) : null;

  useEffect(() => {
    if (!checkKey) {
      setCheck({ state: 'idle' });
      return;
    }
    setCheck({ state: 'pending' });
    const ctl = new AbortController();
    const t = setTimeout(() => {
      checkRulesRemote(JSON.parse(checkKey) as Record<string, unknown>, ctl.signal).then(
        (result) => setCheck({ state: 'done', result }),
        () => undefined,
      );
    }, delayMs);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [checkKey, delayMs]);

  // The size is only worth asking once the rules are known to pass: a build of rules the program would refuse answers with the refusal instead.
  const passes = check.state === 'done' && check.result.ok && check.result.issues.length === 0;
  useEffect(() => {
    if (!sizeKey || !passes) {
      setSize({ state: 'idle' });
      return;
    }
    setSize({ state: 'pending' });
    const ctl = new AbortController();
    const t = setTimeout(() => {
      measureCreation(JSON.parse(sizeKey) as Record<string, unknown>, ctl.signal).then(
        (result) => setSize({ state: 'done', result }),
        () => undefined,
      );
    }, delayMs);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [sizeKey, passes, delayMs]);

  return { check, size };
}
