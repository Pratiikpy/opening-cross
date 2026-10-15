// Cleanverse as a KycProvider: an A-Pass registered on Solana for the wallet is the identity record.
//
// Mapping (reference v5.6): status 1 active / 2 frozen; expirationTime Unix seconds; countries are the ISO alpha-2 tags
// derived from the identity documents at registration; tier is Cleanverse's own number (the policy maps it to ours).
// The customer reference that feeds the identity id is chosen by `identityKey`:
//   customerId   the institution's customer id, from query_apass_list (only for A-Passes registered through this
//                institution: the one key that is the same for every wallet of the same person)
//   kycHash      currentKycHash from query_apass (a hash of the KYC data, if Cleanverse derives it per person)
//   cvRecordId   Cleanverse's record id from query_apass (per registration; the weakest guarantee)
// The key is part of the identity, so changing it changes every identity this provider issues.
import { BusinessError, type ApassRecord, type CleanverseClient, CleanverseError } from '@opening-cross/cleanverse';
import { type KycProvider, type ProviderRecord, ProviderUnavailableError } from './provider.js';

export type IdentityKey = 'customerId' | 'kycHash' | 'cvRecordId';

export type CleanverseProviderOptions = {
  identityKey?: IdentityKey;
  /** Business-failure texts that mean "no A-Pass for this wallet". The reference does not specify the text; confirm it on the sandbox. */
  notFoundPattern?: RegExp;
  /** Whether Cleanverse is asserted to hold verified KYC for every active A-Pass (otherwise a non-empty KYC hash is required). */
  assumeKyc?: boolean;
};

export const DEFAULT_NOT_FOUND = /not\s*found|no\s+a-?pass|does\s*not\s*exist|not\s*registered|no\s+record|unregistered/i;

export class CleanverseProvider implements KycProvider {
  readonly name = 'cleanverse';
  private readonly key: IdentityKey;
  private readonly notFound: RegExp;
  private readonly assumeKyc: boolean;

  constructor(private readonly client: CleanverseClient, o: CleanverseProviderOptions = {}) {
    this.key = o.identityKey ?? 'customerId';
    this.notFound = o.notFoundPattern ?? DEFAULT_NOT_FOUND;
    this.assumeKyc = o.assumeKyc ?? false;
  }

  async lookup(wallet: string): Promise<ProviderRecord> {
    let apass: ApassRecord;
    try {
      apass = await this.client.queryApass('solana', wallet);
    } catch (e) {
      if (e instanceof BusinessError && e.code === '0002' && this.notFound.test(e.message)) return { state: 'none' };
      throw this.unavailable(e);
    }

    let customerRef: string;
    if (this.key === 'customerId') {
      let customers: string[];
      try {
        const list = await this.client.queryApassList({ chain: 'solana', walletAddress: wallet, pageSize: 5 });
        customers = [...new Set(list.items.filter((i) => i.walletAddress === wallet && i.chain.toLowerCase() === 'solana').map((i) => i.customerId))];
      } catch (e) {
        throw this.unavailable(e);
      }
      if (customers.length === 0) return { state: 'unlinked' };
      if (customers.length > 1) throw new ProviderUnavailableError('Cleanverse lists several customers for one wallet');
      customerRef = customers[0]!;
    } else if (this.key === 'kycHash') {
      if (!apass.currentKycHash) return { state: 'unlinked' };
      customerRef = apass.currentKycHash;
    } else customerRef = apass.cvRecordId;

    return {
      state: apass.status === 1 ? 'active' : 'frozen',
      customerRef,
      tier: apass.tier,
      countries: apass.countries,
      expiresAt: apass.expirationTime,
      kycVerified: this.assumeKyc || apass.currentKycHash.length > 0,
      // The reference exposes no sanctions or accreditation field; the policy decides what to assert (see decision.ts).
      sanctionsScreened: false,
      accredited: false,
      capAtoms: 0n,
    };
  }

  private unavailable(e: unknown): ProviderUnavailableError {
    // Only the class and the provider's own message are kept; request bodies never reach an error.
    const what = e instanceof CleanverseError ? `${e.name}: ${e.message}` : (e as Error).message;
    return new ProviderUnavailableError(`Cleanverse: ${what}`, e);
  }
}
