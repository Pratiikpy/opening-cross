// Why a cross ended without a price. The codes are the program's NoPrintReason variants
// (packages/cross-core-client: NoCross, BelowMinimumVolume, ImbalanceTooHigh, SettlementExpired,
// OracleDivergence, OracleUnavailable). A code that is not recognised is shown as it is.
const SENTENCE: Record<string, string> = {
  NoCross: 'no buy order and sell order overlapped at any price',
  BelowMinimumVolume: 'the volume that would have traded was below the minimum the issuer set',
  ImbalanceTooHigh: 'buyers and sellers were too far apart at the best price for the issuer’s limit',
  SettlementExpired: 'the token was not created before the settlement deadline',
  OracleDivergence: 'the price strayed too far from the oracle price',
  OracleUnavailable: 'the oracle price was missing, stale or unverified',
};

export function explainNoPrint(reason: string | null): string {
  if (!reason) return 'no reason is recorded on chain';
  return SENTENCE[reason] ?? reason;
}
