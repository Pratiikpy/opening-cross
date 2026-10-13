'use client';

// Which release of the on-chain programs the connected cluster runs, for the issuer screens that depend on the Wave 2D extensions, and the
// dry run every issuer action makes before the wallet is asked to sign.
//
// The rules, the treasury extension and the settlement payouts are built and proved on LiteSVM and a local validator and are NOT deployed to
// devnet until the operations key is funded (docs/HUMAN_TASKS.md H27). Two things keep a screen honest about that:
//
//  1. GET /v1/programs answers, from the programs' own bytes, whether cross_core and the treasury have the extension. A screen asks it, says so in
//     plain words and switches off the actions the deployed program would refuse. An unreadable program is "unknown", never "first release".
//  2. A dry run: the unsigned transaction the API built is simulated on the cluster before the wallet sees it. A program that lacks the instruction
//     answers InstructionFallbackNotFound (Anchor error 101); the person reads that in words and nothing is signed. This covers `cross_settle`,
//     which GET /v1/programs does not report, and any program the first check could not read.
import { useEffect, useState } from 'react';
import { API_URL } from './api';
import { RPC_ENDPOINTS } from './config';

export type ProgramReport = { address: string; deployedSlot: string | null; extended: boolean | null; checked: { instruction: string; present: boolean }[]; note: string };
export type Programs = { network?: string; checkedAt: number; programs: { crossCore: ProgramReport; treasury: ProgramReport; crossSettle?: ProgramReport } };
export type ProgramKey = 'crossCore' | 'treasury' | 'crossSettle';

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

let kept: { at: number; asked: Promise<Programs | null> } | null = null;
/** One ask for every component on the page; asked again after thirty seconds, or at once when the last answer was not one. */
export function programsOnce(force = false): Promise<Programs | null> {
  if (!force && kept && Date.now() - kept.at < 30_000) return kept.asked;
  const asked = loadPrograms();
  kept = { at: Date.now(), asked };
  void asked.then((p) => {
    if (p === null && kept?.asked === asked) kept = null;
  });
  return asked;
}

export type ReleaseState = { loading: boolean; release: Release; report: ProgramReport | null; network: string | null; unavailable: boolean; /** The API answered but does not report this program at all. */ notReported: boolean; programs: Programs | null };

/** The release of one program. `unavailable` is true when the API has no such route or could not be reached; the release is then `unknown`. */
export function useRelease(key: ProgramKey): ReleaseState {
  const [state, setState] = useState<{ done: boolean; programs: Programs | null }>({ done: false, programs: null });
  useEffect(() => {
    let live = true;
    void programsOnce().then((programs) => live && setState({ done: true, programs }));
    return () => {
      live = false;
    };
  }, []);
  const report = state.programs?.programs[key] ?? null;
  return { loading: !state.done, release: releaseOf(report), report, network: state.programs?.network ?? null, unavailable: state.done && state.programs === null, notReported: state.programs !== null && report === null, programs: state.programs };
}

export const PROGRAM_NAMES: Record<ProgramKey, string> = { crossCore: 'cross_core', treasury: 'the treasury program', crossSettle: 'cross_settle' };

/** The sentence a screen shows when the program it needs is the first release. */
export function firstReleaseSentence(what: string): string {
  return `${what} is built and proved on LiteSVM and a local validator, but the program deployed on this network is still the first release, so it cannot do this yet. It goes live when the upgrade is funded (H27).`;
}

/** The sentence for a program whose release is not known: neither yes nor no. `why` says whether the API could not be asked, could not read the program, or does not report it. */
export function unknownReleaseSentence(what: string, why: 'unavailable' | 'unread' | 'not-reported'): string {
  const dry = 'Each action is simulated on the cluster before your wallet is asked, and nothing is signed if the program refuses it.';
  if (why === 'unavailable') return `This page could not ask the API which release of the programs is deployed, so it cannot say whether ${what} is live. ${dry}`;
  if (why === 'not-reported') return `The API does not report which release of this program is deployed, so this page cannot say whether ${what} is live. ${dry}`;
  return `The API could not read the deployed program just now, so it cannot say whether ${what} is live. ${dry}`;
}

// ---------------------------------------------------------------------------------------------------------- the dry run

export type DryRun = { ok: true } | { ok: false; kind: 'missing-instruction' | 'refused'; message: string } | { ok: 'unknown'; message: string };

/** Program addresses the API reported, by the name a person reads. Never typed here: they come from GET /v1/programs. */
export type KnownPrograms = Record<string, string>;

export function knownPrograms(p: Programs | null): KnownPrograms {
  if (!p) return {};
  const out: KnownPrograms = {};
  for (const k of Object.keys(p.programs) as ProgramKey[]) {
    const r = p.programs[k];
    if (r) out[r.address] = PROGRAM_NAMES[k];
  }
  return out;
}

type SimResult = { value: { err: unknown; logs: string[] | null } };

/** Reads what a simulation said into a verdict a person can act on. Pure. */
export function readSimulation(sim: SimResult['value'], known: KnownPrograms = {}, fallbackName?: string): DryRun {
  if (sim.err === null || sim.err === undefined) return { ok: true };
  const logs = sim.logs ?? [];
  const failed = [...logs].reverse().find((l) => /^Program \S+ failed/.test(l));
  const program = failed?.split(' ')[1];
  const fallback = logs.some((l) => l.includes('InstructionFallbackNotFound')) || (typeof sim.err === 'object' && sim.err !== null && JSON.stringify(sim.err).includes('"Custom":101'));
  if (fallback) {
    const who = program ? (known[program] ?? fallbackName ?? `the program ${program.slice(0, 4)}…`) : 'a program in this transaction';
    return { ok: false, kind: 'missing-instruction', message: `The cluster’s ${who.replace(/^the /, '')} does not have this instruction yet: it is still the first release (H27). Nothing was signed.` };
  }
  const reason = logs.find((l) => l.includes('Error Message:'))?.split('Error Message:')[1]?.trim();
  const code = logs.find((l) => l.includes('Error Code:'))?.split('Error Code:')[1]?.split('.')[0]?.trim();
  if (reason || code) return { ok: false, kind: 'refused', message: `The program would refuse this: ${reason ?? code}. Nothing was signed.` };
  if (typeof sim.err === 'string') {
    if (sim.err === 'AccountNotFound') return { ok: 'unknown', message: 'The wallet has no SOL on this network, so the transaction could not be simulated first.' };
    if (sim.err === 'InsufficientFundsForFee') return { ok: false, kind: 'refused', message: 'This wallet does not hold enough SOL to pay the network fee. Nothing was signed.' };
    return { ok: false, kind: 'refused', message: `The cluster refused this transaction (${sim.err}). Nothing was signed.` };
  }
  return { ok: false, kind: 'refused', message: `The cluster’s simulation failed: ${JSON.stringify(sim.err)}. Nothing was signed.` };
}

/** Simulates an unsigned transaction (base64) without checking signatures. A cluster that cannot answer gives `unknown`, never a pass. */
export async function dryRun(transactionBase64: string, known: KnownPrograms = {}, fallbackName?: string): Promise<DryRun> {
  for (const url of RPC_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [transactionBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }),
      });
      if (res.status === 429) continue;
      const body = (await res.json()) as { result?: SimResult; error?: { message: string } };
      if (body.result) return readSimulation(body.result.value, known, fallbackName);
      if (body.error) return { ok: 'unknown', message: `The cluster could not simulate this first: ${body.error.message}` };
    } catch {
      // try the next endpoint
    }
  }
  return { ok: 'unknown', message: 'The cluster could not be reached to simulate this first.' };
}
