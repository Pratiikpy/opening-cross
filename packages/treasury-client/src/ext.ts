// Decoder for the treasury extension tail (ADR-0470). The tail is not an Anchor account, so the
// generated client has no decoder for it: it sits in the same account as `Treasury`, after the
// first release's fixed-size prefix, and starts with the magic `TEX1`.
import {
  type Address,
  type ReadonlyUint8Array,
  fixDecoderSize,
  getAddressDecoder,
  getArrayDecoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getStructDecoder,
  getU128Decoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU8Decoder,
} from '@solana/kit';

/** `8 + Treasury::INIT_SPACE`: where the extension tail starts in a treasury account. */
export const TREASURY_EXT_OFFSET = 237;
export const TREASURY_EXT_MAGIC = new Uint8Array([0x54, 0x45, 0x58, 0x31]); // "TEX1"

const bytes = (n: number) => fixDecoderSize(getBytesDecoder(), n);

export type TreasuryExt = {
  magic: ReadonlyUint8Array;
  coinVaultBump: number;
  distVaultBump: number;
  votePeriodSecs: bigint;
  timelockSecs: bigint;
  quorumBps: number;
  thresholdBps: number;
  maxProposalBps: number;
  proposerMinBps: number;
  proposalCount: bigint;
  votesLocked: bigint;
  totalStaked: bigint;
  grantsUnreleased: bigint;
  grantCount: bigint;
  minLockupSecs: bigint;
  navOpen: boolean;
  navPeriodSecs: bigint;
  navCapBps: number;
  navPeriodStart: bigint;
  navPeriodSupply: bigint;
  navBurned: bigint;
  insiders: Address[];
  accPerStake: bigint;
  streamSecs: bigint;
  streamAmount: bigint;
  streamEnd: bigint;
  streamLast: bigint;
  revShareBps: number;
  revCredential: Address;
  revSchema: Address;
  roundSecs: bigint;
  revStart: bigint;
  payGraceSecs: bigint;
  missedRounds: number;
  trancheMinRevenue: bigint;
  trancheAmount: bigint;
  disclosurePeriodSecs: bigint;
  lastDisclosureTs: bigint;
  lastDisclosureHash: ReadonlyUint8Array;
  disclosures: number;
  openRequestTs: bigint;
  requestMinBps: number;
  assignRequired: boolean;
  assigned: boolean;
  assignCredential: Address;
  assignSchema: Address;
  windowSecs: bigint;
  recovery: Address;
  windStart: bigint;
  swept: boolean;
};

export function getTreasuryExtDecoder() {
  return getStructDecoder([
    ['magic', bytes(4)],
    ['coinVaultBump', getU8Decoder()],
    ['distVaultBump', getU8Decoder()],
    ['votePeriodSecs', getI64Decoder()],
    ['timelockSecs', getI64Decoder()],
    ['quorumBps', getU16Decoder()],
    ['thresholdBps', getU16Decoder()],
    ['maxProposalBps', getU16Decoder()],
    ['proposerMinBps', getU16Decoder()],
    ['proposalCount', getU64Decoder()],
    ['votesLocked', getU64Decoder()],
    ['totalStaked', getU64Decoder()],
    ['grantsUnreleased', getU64Decoder()],
    ['grantCount', getU64Decoder()],
    ['minLockupSecs', getI64Decoder()],
    ['navOpen', getBooleanDecoder()],
    ['navPeriodSecs', getI64Decoder()],
    ['navCapBps', getU16Decoder()],
    ['navPeriodStart', getI64Decoder()],
    ['navPeriodSupply', getU64Decoder()],
    ['navBurned', getU64Decoder()],
    ['insiders', getArrayDecoder(getAddressDecoder(), { size: 4 })],
    ['accPerStake', getU128Decoder()],
    ['streamSecs', getI64Decoder()],
    ['streamAmount', getU64Decoder()],
    ['streamEnd', getI64Decoder()],
    ['streamLast', getI64Decoder()],
    ['revShareBps', getU16Decoder()],
    ['revCredential', getAddressDecoder()],
    ['revSchema', getAddressDecoder()],
    ['roundSecs', getI64Decoder()],
    ['revStart', getI64Decoder()],
    ['payGraceSecs', getI64Decoder()],
    ['missedRounds', getU32Decoder()],
    ['trancheMinRevenue', getU64Decoder()],
    ['trancheAmount', getU64Decoder()],
    ['disclosurePeriodSecs', getI64Decoder()],
    ['lastDisclosureTs', getI64Decoder()],
    ['lastDisclosureHash', bytes(32)],
    ['disclosures', getU32Decoder()],
    ['openRequestTs', getI64Decoder()],
    ['requestMinBps', getU16Decoder()],
    ['assignRequired', getBooleanDecoder()],
    ['assigned', getBooleanDecoder()],
    ['assignCredential', getAddressDecoder()],
    ['assignSchema', getAddressDecoder()],
    ['windowSecs', getI64Decoder()],
    ['recovery', getAddressDecoder()],
    ['windStart', getI64Decoder()],
    ['swept', getBooleanDecoder()],
  ]);
}

/**
 * Reads the extension of a treasury account's raw data, or `null` when the account has none (a
 * treasury written by the first release, or one that was never extended).
 */
export function decodeTreasuryExt(data: ReadonlyUint8Array): TreasuryExt | null {
  const tail = data.subarray(TREASURY_EXT_OFFSET);
  if (tail.length < 4 || TREASURY_EXT_MAGIC.some((b, i) => tail[i] !== b)) return null;
  return getTreasuryExtDecoder().decode(tail) as TreasuryExt;
}
