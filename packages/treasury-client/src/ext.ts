// Decoder for the treasury extension tail (ADR-0470). The tail is not an Anchor account, so the
// generated client has no decoder for it: it sits in the same account as `Treasury`, after the
// first release's fixed-size prefix, and starts with the magic `TEX1`.
import {
  type Address,
  type Encoder,
  type ReadonlyUint8Array,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getBooleanDecoder,
  getBooleanEncoder,
  getBytesDecoder,
  getBytesEncoder,
  getI64Decoder,
  getI64Encoder,
  getStructDecoder,
  getStructEncoder,
  getU128Decoder,
  getU128Encoder,
  getU16Decoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  getU8Decoder,
  getU8Encoder,
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

/** The tail as a caller supplies it to the encoder: numbers may be given as bigint or number. */
export type TreasuryExtArgs = Omit<TreasuryExt, 'coinVaultBump' | 'distVaultBump' | 'quorumBps'> & { coinVaultBump: number; distVaultBump: number; quorumBps: number };

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

/** The encoder of the tail: what `init_ext` writes. Used to build fixtures and to check the decoder against the layout. */
export function getTreasuryExtEncoder(): Encoder<TreasuryExtArgs> {
  const bytesE = (n: number) => fixEncoderSize(getBytesEncoder(), n);
  return getStructEncoder([
    ['magic', bytesE(4)],
    ['coinVaultBump', getU8Encoder()],
    ['distVaultBump', getU8Encoder()],
    ['votePeriodSecs', getI64Encoder()],
    ['timelockSecs', getI64Encoder()],
    ['quorumBps', getU16Encoder()],
    ['thresholdBps', getU16Encoder()],
    ['maxProposalBps', getU16Encoder()],
    ['proposerMinBps', getU16Encoder()],
    ['proposalCount', getU64Encoder()],
    ['votesLocked', getU64Encoder()],
    ['totalStaked', getU64Encoder()],
    ['grantsUnreleased', getU64Encoder()],
    ['grantCount', getU64Encoder()],
    ['minLockupSecs', getI64Encoder()],
    ['navOpen', getBooleanEncoder()],
    ['navPeriodSecs', getI64Encoder()],
    ['navCapBps', getU16Encoder()],
    ['navPeriodStart', getI64Encoder()],
    ['navPeriodSupply', getU64Encoder()],
    ['navBurned', getU64Encoder()],
    ['insiders', getArrayEncoder(getAddressEncoder(), { size: 4 })],
    ['accPerStake', getU128Encoder()],
    ['streamSecs', getI64Encoder()],
    ['streamAmount', getU64Encoder()],
    ['streamEnd', getI64Encoder()],
    ['streamLast', getI64Encoder()],
    ['revShareBps', getU16Encoder()],
    ['revCredential', getAddressEncoder()],
    ['revSchema', getAddressEncoder()],
    ['roundSecs', getI64Encoder()],
    ['revStart', getI64Encoder()],
    ['payGraceSecs', getI64Encoder()],
    ['missedRounds', getU32Encoder()],
    ['trancheMinRevenue', getU64Encoder()],
    ['trancheAmount', getU64Encoder()],
    ['disclosurePeriodSecs', getI64Encoder()],
    ['lastDisclosureTs', getI64Encoder()],
    ['lastDisclosureHash', bytesE(32)],
    ['disclosures', getU32Encoder()],
    ['openRequestTs', getI64Encoder()],
    ['requestMinBps', getU16Encoder()],
    ['assignRequired', getBooleanEncoder()],
    ['assigned', getBooleanEncoder()],
    ['assignCredential', getAddressEncoder()],
    ['assignSchema', getAddressEncoder()],
    ['windowSecs', getI64Encoder()],
    ['recovery', getAddressEncoder()],
    ['windStart', getI64Encoder()],
    ['swept', getBooleanEncoder()],
  ]);
}
