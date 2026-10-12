#!/usr/bin/env node
// opening-cross-verify-promise <signed-promise.json | url> [--signer <address>] [--inputs <file|url>] [--rpc <url>]
//
// Checks a promise the way a stranger would, with nothing from us but the document:
//   1. the id is the hash of the body (nothing was altered after issuance);
//   2. the signature is valid for the signer, and the signer is the one you expect;
//   3. with --inputs, the published book hashes to `inputsHash` and gives the claimed point;
//   4. with --rpc, the outcome is read from the cross account on chain and the promise is graded.
// Exits 0 only when every check that was asked for passes.
import { readFileSync } from 'node:fs';
import { type Address, address, fetchEncodedAccount } from '@solana/kit';
import { createRetryingRpc } from '@opening-cross/verifier';
import { CrossState, getCrossDecoder } from '@opening-cross/cross-core-client';
import { type BookSnapshot, type Outcome, gradeClearBand, indicativeTick } from './clear-band.js';
import { type Json, hashJcs } from './jcs.js';
import { verifySigned } from './promise.js';
import type { SignedPromise } from './types.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
if (!source) {
  console.error('usage: opening-cross-verify-promise <signed-promise.json | url> [--signer <address>] [--inputs <file|url>] [--rpc <url>]');
  process.exit(2);
}

async function load<T>(where: string): Promise<T> {
  const text = /^https?:\/\//.test(where) ? await (await fetch(where)).text() : readFileSync(where, 'utf8');
  return JSON.parse(text) as T;
}

const signed = await load<SignedPromise>(source);
const p = signed.promise;
let failed = false;
const line = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed = true;
};

const v = await verifySigned(signed, flag('--signer'));
line(v.ok, v.ok ? `id and signature are valid for ${signed.signer}` : `signature check failed: ${v.reason}`);

const inputsPath = flag('--inputs');
if (inputsPath) {
  const inputs = await load<{ grid: BookSnapshot['grid']; referenceTick: number | null; levels: [number, string, string][] }>(inputsPath);
  line(hashJcs(inputs as unknown as Json) === p.inputsHash, 'the published book hashes to inputsHash');
  const buy = new Array<bigint>(inputs.grid.ticks).fill(0n);
  const sell = new Array<bigint>(inputs.grid.ticks).fill(0n);
  for (const [t, b, s] of inputs.levels) {
    buy[t] = BigInt(b);
    sell[t] = BigInt(s);
  }
  const point = indicativeTick({ grid: inputs.grid, buy, sell, referenceTick: inputs.referenceTick });
  line(point === p.claim.pointTick, `recomputed point is tick ${point}, the promise says ${p.claim.pointTick}`);
}

const rpcUrl = flag('--rpc');
if (rpcUrl) {
  const rpc = createRetryingRpc(rpcUrl);
  const acct = await fetchEncodedAccount(rpc, address(p.subject.cross) as Address, { commitment: 'finalized' });
  if (!acct.exists) {
    line(false, `cross ${p.subject.cross} not found on this cluster`);
  } else {
    const c = getCrossDecoder().decode(acct.data);
    const now = Math.floor(Date.now() / 1000);
    let outcome: Outcome = { kind: 'PENDING' };
    if (c.state !== CrossState.Live && c.clearing.__option === 'Some') {
      outcome = { kind: 'CLEARED', priceTick: Number((c.clearing.value.price - c.minPrice) / c.tick), atS: now };
    } else if (c.state === CrossState.NoPrint || (c.state === CrossState.Finalized && c.clearing.__option === 'None')) {
      outcome = { kind: 'NO_PRINT', reason: c.noPrintReason.__option === 'Some' ? String(c.noPrintReason.value) : 'unknown', atS: now };
    }
    const g = gradeClearBand(p, outcome, now);
    console.log(`GRADE ${g.status}${g.reason ? ` (${g.reason})` : ''}${g.outcomeTick !== null ? `: cleared at tick ${g.outcomeTick}, error ${g.errorTicks} ticks, claimed [${p.claim.loTick}, ${p.claim.hiTick}]` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
