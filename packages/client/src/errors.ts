// One error type for everything a caller can be told about an action, with a stable code to branch on.

export type ActionErrorCode =
  | 'INVALID_INPUT'
  | 'API_UNREACHABLE'
  | 'API_REFUSED'
  | 'RATE_LIMITED'
  | 'RPC_UNREACHABLE'
  | 'RPC_REFUSED'
  | 'WALLET_DECLINED'
  | 'WALLET_ERROR'
  | 'FAILED_ON_CHAIN'
  | 'NOT_CONFIRMED'
  | 'NOT_FOUND'
  | 'CONFLICT';

export class ActionError extends Error {
  /** How many of a multi-transaction action had already landed when it failed. */
  completed = 0;
  readonly code: ActionErrorCode;
  constructor(message: string, code: ActionErrorCode = 'API_REFUSED') {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}
