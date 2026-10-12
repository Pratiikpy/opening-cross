// Parsing and checking what the user typed, before anything touches the network.
import { isAddress } from '@solana/kit';
import { type CrossDetail, type Side, readCrossFromChain } from '@opening-cross/client';
import type { Context } from './context.js';
import { UsageError } from './exit.js';

export function addressArg(v: string | undefined, name: string): string {
  if (v === undefined || v === '') throw new UsageError(`Missing ${name}.`);
  if (!isAddress(v)) throw new UsageError(`${name} must be a base58 Solana address (got "${v.length > 60 ? `${v.slice(0, 20)}...` : v}").`);
  return v;
}

export function u64Arg(v: string | undefined, name: string): bigint {
  if (v === undefined || v === '') throw new UsageError(`Missing ${name}.`);
  if (!/^\d{1,20}$/.test(v) || BigInt(v) > 0xffff_ffff_ffff_ffffn) throw new UsageError(`${name} must be a whole number from 0 to 18446744073709551615 (got "${v.length > 30 ? `${v.slice(0, 20)}...` : v}").`);
  return BigInt(v);
}

export function sideArg(v: string | undefined): Side {
  if (v === 'buy' || v === 'sell') return v;
  throw new UsageError(`--side must be "buy" or "sell"${v === undefined ? ' and is required' : ` (got "${v}")`}.`);
}

export function stringOpt(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A random nonce for an order: 48 bits, so two orders by one wallet do not collide. */
export function freshNonce(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): bigint {
  return random(6).reduce((acc, x) => acc * 256n + BigInt(x), 0n);
}

export type LoadedCross = Awaited<ReturnType<typeof readCrossFromChain>> & { now: bigint };

/** Reads the cross from the cluster (never from the API: a client that signs trusts the chain) and the cluster's clock. */
export async function loadCross(ctx: Context, address: string): Promise<LoadedCross> {
  const [cross, now] = await Promise.all([readCrossFromChain(ctx.rpc, address), ctx.rpc.unixTime()]);
  return { ...cross, now };
}

/** The signer's address, or the named wallet when only simulating and no key was given. */
export async function actingAddress(ctx: Context, flag: string | undefined, flagName = '--owner'): Promise<string> {
  if (ctx.dryRun && flag !== undefined) return addressArg(flag, flagName);
  try {
    return (await ctx.signer()).address;
  } catch (e) {
    if (ctx.dryRun && e instanceof UsageError) throw new UsageError(`${e.message} For a dry run you can pass ${flagName} <address> instead.`);
    throw e;
  }
}

export function progress(ctx: Context): ((s: string) => void) | undefined {
  // Status lines go to stderr so stdout carries only the result.
  return ctx.json ? undefined : (s) => ctx.io.err(s);
}

export type { CrossDetail };
