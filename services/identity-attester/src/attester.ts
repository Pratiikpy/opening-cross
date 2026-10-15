// The attester: turns what a KYC provider says about a wallet into the wallet's `oc-identity` attestation, keeps those
// attestations true, and closes them when the provider stops vouching. It fails closed: an unanswered question never
// creates an attestation, and an answered "no" removes one.
import { type Address, isAddress } from '@solana/kit';
import { deriveIdentityId } from '@opening-cross/cleanverse';
import { countryAlpha2, unpackIdentityData, type IdentityRecord } from '@opening-cross/cross-gate-client';
import { type Decision, type Policy, type Reason, decide, reason, validatePolicy } from './decision.js';
import { type KycProvider, type ProviderRecord, type VerifiedRecord, ProviderUnavailableError } from './provider.js';
import type { AttestationStore } from './sas.js';

export class InvalidWalletError extends Error {
  constructor() {
    super('wallet must be a base58 Solana address (32 bytes)');
    this.name = 'InvalidWalletError';
  }
}

export type AttestOutcome =
  | { status: 'attested'; action: 'created' | 'replaced' | 'unchanged'; attestation: Address; expiry: number; country: string | null; tier: number; flags: number; signature?: string; reasons: [] }
  | { status: 'ineligible'; reasons: Reason[]; /** An earlier attestation was closed because the provider no longer vouches. */ closed: boolean }
  | { status: 'provider_unavailable'; reasons: Reason[]; closed: false };

export type SyncReport = { checked: number; unchanged: number; refreshed: number; closed: number; skipped: number; errors: { wallet: string; message: string }[] };

export type AttesterOptions = {
  provider: KycProvider;
  sas: AttestationStore;
  policy: Policy;
  /** The identity-id secret (32 bytes or more). Separate from the signing key so identities survive a key rotation. */
  secret: Uint8Array;
  /** Unix seconds. */
  now?: () => number;
  /** Pause between provider calls during a sync (ms). */
  syncDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives one line per decision; carries wallet addresses and outcomes only, never provider data. */
  log?: (line: string) => void;
};

export class Attester {
  private readonly o: AttesterOptions;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(o: AttesterOptions) {
    this.o = { ...o, policy: validatePolicy(o.policy) };
    if (o.secret.length < 32) throw new RangeError('the identity secret must be at least 32 bytes');
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get provider() {
    return this.o.provider;
  }

  /** Runs `fn` after any earlier operation on the same wallet, so a double click cannot create two writes at once. */
  private serial<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(wallet) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(wallet, next);
    void next.finally(() => {
      if (this.locks.get(wallet) === next) this.locks.delete(wallet);
    }).catch(() => undefined);
    return next;
  }

  private identity(rec: VerifiedRecord): Uint8Array {
    return deriveIdentityId(this.o.secret, this.o.provider.name, rec.customerRef);
  }

  /** Asks the provider and attests the wallet if it qualifies; removes its attestation if the provider says it no longer does. */
  attest(wallet: string): Promise<AttestOutcome> {
    if (!isAddress(wallet)) throw new InvalidWalletError();
    return this.serial(wallet, () => this.attestNow(wallet as Address));
  }

  private async attestNow(wallet: Address): Promise<AttestOutcome> {
    let rec: ProviderRecord;
    try {
      rec = await this.o.provider.lookup(wallet);
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError)) throw e;
      this.o.log?.(`attest ${wallet}: provider unavailable`);
      return { status: 'provider_unavailable', reasons: [reason('PROVIDER_UNAVAILABLE')], closed: false };
    }
    const d = decide(rec, this.o.policy, this.now());
    if (!d.eligible) {
      const closed = (await this.o.sas.close(wallet)).closed;
      this.o.log?.(`attest ${wallet}: ineligible ${d.reasons.map((r) => r.code).join(',')}${closed ? ' (attestation closed)' : ''}`);
      return { status: 'ineligible', reasons: d.reasons, closed };
    }
    const identity = this.identity(rec as VerifiedRecord);
    const r = await this.o.sas.upsert(wallet, { identity, ...d.record }, BigInt(d.expiry));
    this.o.log?.(`attest ${wallet}: ${r.action}`);
    return { status: 'attested', action: r.action, attestation: r.address, expiry: d.expiry, country: d.countryAlpha2, tier: d.record.tier, flags: d.record.flags, ...(r.signature ? { signature: r.signature } : {}), reasons: [] };
  }

  /**
   * Re-asks the provider about every attestation issued and keeps the chain true to the answer: closes the attestations
   * of wallets the provider no longer vouches for (so anyone can revoke their passes), refreshes the ones whose expiry,
   * tier, country or flags moved. A provider that does not answer leaves the attestation as it is; it still lapses at its
   * own expiry.
   */
  async sync(): Promise<SyncReport> {
    const report: SyncReport = { checked: 0, unchanged: 0, refreshed: 0, closed: 0, skipped: 0, errors: [] };
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (const att of await this.o.sas.list()) {
      report.checked++;
      try {
        const out = await this.serial(att.wallet, async () => {
          // Re-read inside the lock: an attest may have changed it since the listing.
          const have = await this.o.sas.read(att.wallet);
          if (!have) return 'gone' as const;
          let rec: ProviderRecord;
          try {
            rec = await this.o.provider.lookup(att.wallet);
          } catch (e) {
            if (e instanceof ProviderUnavailableError) return 'skipped' as const;
            throw e;
          }
          const d: Decision = decide(rec, this.o.policy, this.now());
          if (!d.eligible) {
            await this.o.sas.close(att.wallet);
            this.o.log?.(`sync ${att.wallet}: closed ${d.reasons.map((r) => r.code).join(',')}`);
            return 'closed' as const;
          }
          const identity = this.identity(rec as VerifiedRecord);
          const r = await this.o.sas.upsert(att.wallet, { identity, ...d.record } as IdentityRecord, BigInt(d.expiry));
          if (r.action !== 'unchanged') this.o.log?.(`sync ${att.wallet}: refreshed`);
          return r.action === 'unchanged' ? ('unchanged' as const) : ('refreshed' as const);
        });
        if (out === 'gone') report.skipped++;
        else report[out]++;
      } catch (e) {
        report.errors.push({ wallet: att.wallet, message: (e as Error).message });
      }
      if ((this.o.syncDelayMs ?? 0) > 0) await sleep(this.o.syncDelayMs!);
    }
    return report;
  }

  /** The wallet's attestation as it stands on chain, decoded; nothing is asked of the provider. */
  async onChain(wallet: string): Promise<OnChainState> {
    if (!isAddress(wallet)) throw new InvalidWalletError();
    const have = await this.o.sas.read(wallet as Address);
    if (!have) return { exists: false };
    let rec: IdentityRecord;
    try {
      rec = unpackIdentityData(have.data);
    } catch {
      return { exists: true, attestation: have.address, valid: false };
    }
    const expiry = Number(have.expiry);
    return {
      exists: true,
      attestation: have.address,
      valid: expiry === 0 || expiry > this.now(),
      expiry,
      country: rec.country === 0 ? null : (countryAlpha2(rec.country) ?? null),
      countryNumeric: rec.country,
      tier: rec.tier,
      flags: rec.flags,
      cap: rec.cap.toString(),
    };
  }
}

export type OnChainState =
  | { exists: false }
  | { exists: true; attestation: Address; valid: false; expiry?: number; country?: string | null; countryNumeric?: number; tier?: number; flags?: number; cap?: string }
  | { exists: true; attestation: Address; valid: true; expiry: number; country: string | null; countryNumeric: number; tier: number; flags: number; cap: string };
