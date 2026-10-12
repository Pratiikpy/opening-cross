import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionError, type BuiltAction, signSendConfirm } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';

export type ActionState = {
  busy: boolean;
  /** What is happening now, in words ("Waiting for your wallet...", "Confirming (2 of 4)..."), or null when idle. */
  status: string | null;
  error: ActionError | null;
  /** The signatures of the last action that finished, in order. */
  signatures: string[] | null;
  /** Set when a multi-transaction action stopped after some of its transactions had landed. */
  partial: { landed: number; total: number } | null;
};

export type ActionResult = { signatures: string[]; extra: Record<string, unknown> };
export type ActionFailure = { error: ActionError; partial: { landed: number; total: number } | null };
/** What `run` resolves to: the signatures, or why not. It does not throw. */
export type ActionOutcome = ({ ok: true } & ActionResult) | ({ ok: false } & ActionFailure);

const IDLE: ActionState = { busy: false, status: null, error: null, signatures: null, partial: null };

/**
 * Runs an action the way every Opening Cross client does: `build` returns unsigned transactions (from the API or built here), the
 * connected wallet signs them, they are sent in order and confirmed. Failures arrive as an `ActionError` in state in the program's own
 * words; `run` itself never throws, and a second call while one is running is ignored.
 */
export function useAction(): ActionState & { run: (build: () => Promise<BuiltAction>) => Promise<ActionOutcome | null>; reset: () => void } {
  const { rpc, wallet, sleep } = useOpeningCross();
  const [state, setState] = useState<ActionState>(IDLE);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = useCallback((s: ActionState | ((p: ActionState) => ActionState)) => {
    if (mounted.current) setState(s);
  }, []);

  const run = useCallback(
    async (build: () => Promise<BuiltAction>): Promise<ActionOutcome | null> => {
      if (busy.current) return null;
      busy.current = true;
      set({ ...IDLE, busy: true, status: 'Preparing…' });
      let built: BuiltAction | null = null;
      try {
        if (!wallet) throw new ActionError('Connect a wallet first.', 'INVALID_INPUT');
        built = await build();
        const signatures = await signSendConfirm(built.transactions, { rpc, sign: wallet.sign, onStatus: (status) => set((p) => ({ ...p, status })), ...(sleep ? { sleep } : {}) });
        set({ ...IDLE, signatures });
        return { ok: true, signatures, extra: built.extra };
      } catch (e) {
        const error = e instanceof ActionError ? e : new ActionError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`, 'API_REFUSED');
        const partial = built && error.completed > 0 ? { landed: error.completed, total: built.transactions.length } : null;
        set({ ...IDLE, error, partial });
        return { ok: false, error, partial };
      } finally {
        busy.current = false;
      }
    },
    [rpc, wallet, sleep, set],
  );

  return { ...state, run, reset: () => set(IDLE) };
}
