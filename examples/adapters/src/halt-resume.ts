// Halt-resume adapter (PRODUCT_FEATURES W11, X1): "trading always resumes through a cross". After an issuer pause, a corporate action
// or an exchange halt, the market does not restart at whatever price the first trade prints; it restarts with a call whose
// price everyone shares.
//
// The adapter watches a token's safety verdict (the issuer powers read from the chain) and the last price it printed. While
// the verdict says the token is halted or unusable it waits and says why. When the halt has lifted it plans a resume call: a
// short window on a wide grid (prices move during a halt), sealed so nobody can react to the book.
import type { Plan, Skip } from './common.js';
import { type ReopenInput, planReopen } from './reopen.js';

export type RiskView = { severity: 'block' | 'halt' | 'disclose'; code: string; message: string };

export type HaltResumeInput = Omit<ReopenInput, 'sessionOpenTs' | 'referencePrice' | 'disclosure' | 'callSecs' | 'halfBandBps'> & {
  /** The token's safety verdict, from `GET /v1/tokens/:mint/safety`. */
  risks: readonly RiskView[];
  /** Whether this adapter saw the token halted before: a token that was never halted needs no resume. */
  wasHalted: boolean;
  /** The last price the pair printed, in cross price units, or null when it never printed. */
  lastPrint: bigint | null;
  /** How long the resume call runs. Default ten minutes. */
  callSecs?: number;
};

export function planHaltResume(i: HaltResumeInput): Plan | Skip {
  const blocker = i.risks.find((r) => r.severity === 'block');
  if (blocker) return { action: 'wait', reason: `the token cannot be crossed at all: ${blocker.message}` };
  const halt = i.risks.find((r) => r.severity === 'halt');
  if (halt) return { action: 'wait', reason: `still halted: ${halt.message}` };
  if (!i.wasHalted) return { action: 'wait', reason: 'the token was not halted; there is nothing to resume' };
  if (i.lastPrint === null) return { action: 'wait', reason: 'the pair has never printed, so there is no reference price to centre the resume call on; set one explicitly' };
  const callSecs = i.callSecs ?? 600;
  const settle = BigInt(i.settleSecs ?? 300);
  const reveal = BigInt(i.revealSecs ?? 300);
  const plan = planReopen({ ...i, referencePrice: i.lastPrint, callSecs, disclosure: 'sealed', halfBandBps: 2_000, sessionOpenTs: i.now + BigInt(callSecs) + settle + reveal + 60n });
  return {
    request: plan.request,
    warnings: [...plan.warnings, 'The grid is twice as wide as an ordinary reopen because prices move while an asset is halted.'],
    explanation: ['The halt has lifted. Trading resumes through a call, not through the first trade that happens to print.', ...plan.explanation],
  };
}
