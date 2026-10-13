'use client';

// What the connected wallet is, for a cross's rules: whether it holds a pass of the cross's gate, whether it holds a pass of the priority
// gate, and how much of the per-identity limits it has used. Each part that cannot be read stays null; nothing is guessed.
import { API_URL } from './api';
import type { Standing } from './holder-rules';
import { loadGate, loadEligibility } from './gate';
import { loadOwnOrders, usageOf } from './holder-orders';

export async function loadStanding(input: { cross: string; owner: string; gated: boolean; priorityGate: string | null; sealed: boolean }): Promise<Standing> {
  const [elig, prio, orders] = await Promise.all([
    input.gated ? loadEligibility(input.cross, input.owner) : Promise.resolve(null),
    input.priorityGate ? loadGate(input.priorityGate, input.owner) : Promise.resolve(null),
    loadOwnOrders(input.cross, input.owner, input.sealed).catch(() => null),
  ]);
  return {
    gatePass: elig && elig.ok && elig.data.acceptingOrders ? elig.data.eligible : null,
    priorityPass: prio && prio.ok ? (prio.data.standing?.hasPass ?? null) : null,
    usage: orders ? usageOf(orders) : null,
  };
}

export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
