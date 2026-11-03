/**
 * Webhook signature verification. EXPERIMENTAL until webhooks are declared
 * stable (#2070). Node only (node:crypto): import it from
 * "@visiban/client/webhooks" so the main entry point stays browser-safe.
 *
 * X-Visiban-Signature = "v1=" + hex(HMAC-SHA256(secret, `${timestamp}.${raw body}`))
 *
 * During a secret rotation the header lists two comma-separated values,
 * `v1=<new>,v1=<old>`; a request is accepted when any listed value matches.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;
export const MAX_SIGNATURE_VALUES = 8;

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeadersLike, name: string): string {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? "";
  }
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      // Several header lines mean what one comma-joined line means.
      const joined = Array.isArray(value) ? value.join(",") : value;
      return typeof joined === "string" ? joined : "";
    }
  }
  return "";
}

export interface VerifyOptions {
  /** Seconds of clock skew allowed in either direction. Default 300. */
  toleranceSeconds?: number;
  /** Current unix time in seconds; for tests. */
  now?: number;
}

/**
 * True when the delivery is authentic and fresh. `rawBody` must be the exact
 * bytes received, before JSON parsing. Never throws on bad input headers. More
 * than MAX_SIGNATURE_VALUES values in the signature header is a refusal.
 */
export function verifySignature(
  secret: string | Uint8Array,
  headers: HeadersLike,
  rawBody: Uint8Array,
  options: VerifyOptions = {},
): boolean {
  if (secret.length === 0) {
    // An empty key would let anyone forge a valid signature.
    throw new TypeError("secret must not be empty");
  }
  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("toleranceSeconds must be a finite number >= 0");
  }
  if (!(rawBody instanceof Uint8Array)) {
    throw new TypeError("rawBody must be bytes: verify the unparsed request body");
  }
  const timestamp = header(headers, "X-Visiban-Timestamp");
  const signature = header(headers, "X-Visiban-Signature");
  // Length cap keeps the check cheap and the number exactly representable.
  if (!/^[0-9]{1,12}$/.test(timestamp)) return false;
  const now = options.now ?? Date.now() / 1000;
  // abs(): reject a timestamp too far in the future as well as one too old.
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    return false;
  }
  const expected = "v1=" + createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const values = signature.split(",");
  if (values.length > MAX_SIGNATURE_VALUES) return false;
  // Every value is compared, with no early exit, so the time taken does not say
  // which one matched. An unknown scheme is just a value that does not match.
  let matched = false;
  for (const value of values) {
    const b = Buffer.from(value.trim());
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}
