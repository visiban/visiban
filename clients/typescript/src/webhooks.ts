/**
 * Webhook signature verification. EXPERIMENTAL until webhooks are declared
 * stable (#2070). Node only (node:crypto): import it from
 * "@visiban/client/webhooks" so the main entry point stays browser-safe.
 *
 * X-Visiban-Signature = "v1=" + hex(HMAC-SHA256(secret, `${timestamp}.${raw body}`))
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeadersLike, name: string): string {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? "";
  }
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === "string" ? first : "";
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
 * bytes received, before JSON parsing. Never throws on bad input headers.
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
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
