// Exit codes, documented in the README and `opening-cross --help`. A script can branch on them without parsing text.
import { ActionError } from '@opening-cross/client';

export const EXIT = {
  /** The command did what it was asked to. */
  OK: 0,
  /** The command ran and the answer is no: a proof did not verify, a transaction was refused or failed on chain, a simulation failed. */
  FAILED: 1,
  /** The command was not understood or its input is wrong; nothing was sent. */
  USAGE: 2,
  /** The network or the API could not be reached (or was too busy); a send that timed out says so and gives the signature to check. */
  UNREACHABLE: 3,
  /** This deployment does not offer what was asked, for example best-execution quotes. */
  UNAVAILABLE: 4,
} as const;

export function exitCodeFor(e: ActionError): number {
  switch (e.code) {
    case 'INVALID_INPUT':
    case 'NOT_FOUND':
      return EXIT.USAGE;
    case 'API_UNREACHABLE':
    case 'RPC_UNREACHABLE':
    case 'RATE_LIMITED':
    case 'NOT_CONFIRMED':
      return EXIT.UNREACHABLE;
    default:
      return EXIT.FAILED;
  }
}

/** Thrown for a bad flag, a bad value or an unknown command: exit code 2, nothing sent. */
export class UsageError extends ActionError {
  constructor(message: string) {
    super(message, 'INVALID_INPUT');
    this.name = 'UsageError';
  }
}
