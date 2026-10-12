import type { ActionError, FairnessProofView } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useResource } from './use-resource.js';

export type UseFairnessProof = { status: 'idle' | 'loading' | 'ready' | 'error'; proof: FairnessProofView | null; error: ActionError | null; refresh: () => Promise<void> };

/**
 * The fairness proof of a settled cross: a second implementation of the clearing rule recomputed from the on-chain book, and whether
 * it equals what the program recorded. Pass `enabled: false` (for example while the cross is live) to not ask.
 */
export function useFairnessProof(cross: string | null, options: { enabled?: boolean } = {}): UseFairnessProof {
  const { api } = useOpeningCross();
  const r = useResource<FairnessProofView>(cross && options.enabled !== false ? cross : null, (signal) => api.getProof(cross!, signal));
  return { status: r.status, proof: r.data, error: r.error, refresh: r.refresh };
}
