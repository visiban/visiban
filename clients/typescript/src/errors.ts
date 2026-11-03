/** Typed errors. Everything derives from VisibanError so one catch covers the package. */

export class VisibanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The server answered with a non-success status. */
export class APIError extends VisibanError {
  constructor(
    readonly status: number,
    readonly detail: string = "",
    readonly code: string | null = null,
    readonly body: unknown = null,
  ) {
    super(`HTTP ${status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`);
  }
}

/** 401 or 403: the token is missing, revoked, expired, or lacks the read scope. */
export class AuthenticationError extends APIError {}
/** 404: no such board, or the token's user has no access to it. */
export class NotFoundError extends APIError {}
/** 400: a rejected `after` or `limit`. */
export class BadRequestError extends APIError {}
/** 429, 5xx, or a network failure persisted through every retry. */
export class RetriesExhausted extends APIError {}
/** The response did not match the documented feed contract. */
export class ProtocolError extends VisibanError {}

/**
 * A 410 arrived without `next_cursor` (a pre-1.3 server). There is no safe
 * resume point, so the client refuses rather than guess. Upgrade to 1.3+.
 */
export class ResyncUnsupported extends VisibanError {
  constructor(
    message: string,
    readonly resyncUrl: string | null = null,
  ) {
    super(message);
  }
}
