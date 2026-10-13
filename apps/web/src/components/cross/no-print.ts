// Why a cross ended without a price. The codes are the program's NoPrintReason variants
// (packages/cross-core-client: NoCross, BelowMinimumVolume, ImbalanceTooHigh, SettlementExpired,
// OracleDivergence, OracleUnavailable, BelowMinimumRaise, FloatTooLow, FdvTooHigh, PriceMoved, Halted, CorporateAction,
// IssuerPaused, OracleDisagreement). A code that is not recognised is shown as it is.
const SENTENCE: Record<string, string> = {
  NoCross: 'no buy order and sell order overlapped at any price',
  BelowMinimumVolume: 'the volume that would have traded was below the minimum the issuer set',
  ImbalanceTooHigh: 'buyers and sellers were too far apart at the best price for the issuerâ€™s limit',
  SettlementExpired: 'the token was not created before the settlement deadline',
  OracleDivergence: 'the price strayed too far from the oracle price',
  OracleUnavailable: 'the oracle price was missing, stale or unverified',
  BelowMinimumRaise: 'the amount raised at the clearing price was below the minimum the issuer set',
  FloatTooLow: 'the share of the supply that would have been sold was below the issuer’s minimum float',
  FdvTooHigh: 'the clearing price implied a fully diluted value above the issuer’s ceiling',
  PriceMoved: 'the price moved too far from the reference price the issuer set',
  Halted: 'trading in the asset was halted when the cross was cleared',
  CorporateAction: 'a corporate action on the asset was flagged when the cross was cleared',
  IssuerPaused: 'the issuer paused this cross before it was cleared',
  OracleDisagreement: 'the oracles the issuer named disagreed with each other',
};

export function explainNoPrint(reason: string | null): string {
  if (!reason) return 'no reason is recorded on chain';
  return SENTENCE[reason] ?? reason;
}
