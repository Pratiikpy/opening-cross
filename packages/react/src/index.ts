// @opening-cross/react: hooks and components for building a client on Opening Cross.
// Import the stylesheet once: `import '@opening-cross/react/styles.css'`.
export { OpeningCrossProvider, useOpeningCross, type OpeningCross, type OpeningCrossProviderProps, type Wallet } from './context.js';
export { type Signer, type SolanaSignTransactionFeature, type WalletStandardAccount, walletStandardSigner } from './signer.js';
export * from './hooks/index.js';
export { ActionButton, type ActionButtonProps } from './components/action-button.js';
export { CancelButton, ClaimButton, FinalizeButton, RevealButton, SettleButton, type CancelButtonProps, type ClaimButtonProps, type FinalizeButtonProps, type RevealButtonProps, type SettleButtonProps } from './components/actions.js';
export { BestExecution, type BestExecutionProps } from './components/best-execution.js';
export { BookDepth, type BookDepthProps } from './components/book-depth.js';
export { CrossStatus, type CrossStatusProps } from './components/cross-status.js';
export { FairnessReceipt, type FairnessReceiptProps } from './components/fairness-receipt.js';
export { OrderList, type OrderListProps } from './components/order-list.js';
export { OrderTicket, type OrderTicketProps } from './components/order-ticket.js';

// Everything a UI needs from the framework-free client, so an app can depend on this package alone.
export {
  ActionError,
  type ActionErrorCode,
  type BookResponse,
  type BuiltAction,
  type ClientStore,
  type CrossDetail,
  type CrossStateName,
  type FairnessProofView,
  type Market,
  type OrderView,
  type Phase,
  type SealedBid,
  type Side,
  buyerPays,
  formatAtoms,
  formatDuration,
  formatPrice,
  formatSol,
  marketOf,
  memoryStore,
  parseAtoms,
  parsePrice,
  phaseOf,
  previewOrder,
  priceOnGrid,
  shortAddress,
  storageStore,
  validateOrderInput,
} from '@opening-cross/client';
