// What can go wrong when calling Cleanverse, as distinct classes so a caller can act on each: a gateway refusal is not a
// business failure, and neither is a body that does not look like the documented one.

export class CleanverseError extends Error {
  constructor(message: string, readonly endpoint: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP 400: invalid parameters or encryption format. */
export class BadRequestError extends CleanverseError {}
/** HTTP 403: invalid or missing api-id, IP not allowed, unauthorised, or the body could not be decrypted. */
export class ForbiddenError extends CleanverseError {}
/** HTTP 404. */
export class NotFoundHttpError extends CleanverseError {}
/** HTTP 409: the resource already exists. */
export class ConflictError extends CleanverseError {}
/** HTTP 5xx. Retried for calls that are safe to repeat. */
export class ServerError extends CleanverseError {
  constructor(message: string, endpoint: string, readonly status: number) {
    super(message, endpoint);
  }
}
/** The request did not complete (connection failure or timeout). */
export class TransportError extends CleanverseError {}
/** The response was not the documented shape. Never replaced by a default. */
export class MalformedResponseError extends CleanverseError {}

/** Envelope code `0001`: the parameter is incorrect. */
export class ParameterError extends CleanverseError {
  constructor(message: string, endpoint: string, readonly code = '0001') {
    super(message, endpoint);
  }
}

/** Envelope code `0002` and the validator codes `12026` / `12027`: the call reached Cleanverse and was refused. */
export class BusinessError extends CleanverseError {
  constructor(
    message: string,
    endpoint: string,
    readonly code: string,
    /** The bracketed sub-code in the message, such as `RM_007`, `400` or `12026`. */
    readonly subCode: string | null,
  ) {
    super(message, endpoint);
  }
}

/** Envelope code `1000`: an A-Pass group would change; repeat the call with `override: true` if that is intended. */
export class OverrideRequiredError extends CleanverseError {}

export function subCodeOf(message: string): string | null {
  return /^\s*\[([A-Za-z0-9_]+)\]/.exec(message)?.[1] ?? null;
}
