'use client';

// Which of the seven Wave 3D programs (cross_mandate, cross_conviction, cross_basket, cross_listing, cross_bounty, cross_backing, cross_graduate) and which
// batch 2 instructions of cross_settle the connected cluster has, from GET /v1/programs (`programs.<key>` and `features`). These programs are proved on
// LiteSVM and on a local validator and are NOT deployed to devnet until the operations key is funded (docs/HUMAN_TASKS.md H27, H43), so a screen asks here,
// says plainly what it finds and offers nothing the cluster would refuse. `available: null` means "could not be checked", never "missing".
import { useEffect, useState } from 'react';
import { API_URL } from './api';

export type FeatureKey = 'mandates' | 'conviction' | 'baskets' | 'listing' | 'bounty' | 'backing' | 'governedGraduation' | 'fixedPricePresale' | 'futarchyDao';
export type Feature = { available: boolean | null; needs: string[]; unverified?: string[]; note: string };
export type NewProgramReport = { address: string; name: string; adr: string; deployed: boolean | null; extended: boolean | null; deployedSlot: string | null; checked: { instruction: string; present: boolean }[]; note: string };
export type NewProgramsRead = { network?: string; checkedAt: number; programs: Record<string, NewProgramReport | undefined>; features: Partial<Record<FeatureKey, Feature>> };

export async function loadFeatures(): Promise<NewProgramsRead | null> {
  try {
    const r = await fetch(`${API_URL}/v1/programs`, { cache: 'no-store' });
    if (!r.ok) return null;
    const body = (await r.json()) as NewProgramsRead;
    return body && typeof body === 'object' && body.features ? body : null;
  } catch {
    return null;
  }
}

let kept: { at: number; asked: Promise<NewProgramsRead | null> } | null = null;
/** One ask for every component on the page; asked again after thirty seconds, or at once when the last answer was not one. */
export function featuresOnce(force = false): Promise<NewProgramsRead | null> {
  if (!force && kept && Date.now() - kept.at < 30_000) return kept.asked;
  const asked = loadFeatures();
  kept = { at: Date.now(), asked };
  void asked.then((p) => {
    if (p === null && kept?.asked === asked) kept = null;
  });
  return asked;
}

export type Availability =
  | { phase: 'loading' }
  /** The API could not be asked, or it does not report features (an older API). */
  | { phase: 'unavailable' }
  | { phase: 'ready'; available: boolean | null; network: string | null; feature: Feature | null };

export function availabilityOf(read: NewProgramsRead | null | undefined, key: FeatureKey): Availability {
  if (read === undefined) return { phase: 'loading' };
  if (read === null) return { phase: 'unavailable' };
  const feature = read.features[key] ?? null;
  return { phase: 'ready', available: feature ? feature.available : null, network: read.network ?? null, feature };
}

/** Whether a feature is on the connected network: `available` true, false or null (not known). Asked once per page. */
export function useFeature(key: FeatureKey): Availability {
  const [read, setRead] = useState<NewProgramsRead | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void featuresOnce().then((p) => live && setRead(p));
    return () => {
      live = false;
    };
  }, []);
  return availabilityOf(read, key);
}

/** Why an action is off, or null when it may be offered. An unknown release leaves the action on: it is simulated on the cluster before the wallet is asked. */
export function offReason(a: Availability, what: string): string | null {
  if (a.phase === 'ready' && a.available === false) return `${what} is built and proved on LiteSVM and a local validator, but it is not on ${a.network ?? 'this network'} yet, so nothing here can be signed. It goes live when the operations key is funded (H27, H43).`;
  return null;
}

/** The network's name as a person reads it. */
export const networkName = (n: string | null): string => (n ? n : 'this network');

/** The `release` object every read and every transaction route of the seven programs carries. `deployed: null` means it could not be checked. */
export type ReleaseNote = { program: string; programName?: string; instruction?: string; deployed: boolean | null; note?: string };

/** The instruction-level reasons an API refusal carries (`reason`), kept so a screen can branch on them. */
export type ApiFailure = { status: number; error: string; reason: string | null; body: Record<string, unknown> };

/** A GET against the API that keeps the status and the stable `reason` of a refusal. */
export async function readApi<T>(path: string): Promise<{ ok: true; data: T } | ({ ok: false } & ApiFailure)> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: typeof body.error === 'string' ? body.error : `The API answered HTTP ${res.status}.`, reason: typeof body.reason === 'string' ? body.reason : null, body };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: 'The Opening Cross API could not be reached.', reason: null, body: {} };
  }
}
