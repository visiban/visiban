import { describe, expect, it } from "vitest";
import { MAX_SIGNATURE_VALUES, verifySignature } from "../src/webhooks.js";
import { fixtures } from "./helpers.js";

const sig = fixtures.signature;
const enc = (s: string) => new TextEncoder().encode(s);

describe("verifySignature", () => {
  it("accepts the documented test vector", () => {
    expect(
      verifySignature(sig.secret, { "X-Visiban-Timestamp": sig.timestamp, "X-Visiban-Signature": sig.signature }, enc(sig.body), { now: 1700000000 }),
    ).toBe(true);
  });

  for (const c of sig.cases) {
    it(`shared case: ${c.name}`, () => {
      expect(verifySignature(c.secret, c.headers, enc(c.body), { now: c.now })).toBe(c.expected);
    });
  }

  it("accepts a fetch Headers object and a Buffer secret/body", () => {
    const headers = new Headers({ "x-visiban-timestamp": sig.timestamp, "x-visiban-signature": sig.signature });
    expect(verifySignature(Buffer.from(sig.secret), headers, Buffer.from(sig.body), { now: 1700000000 })).toBe(true);
  });

  it("reads array-valued Node headers", () => {
    const headers = { "x-visiban-timestamp": [sig.timestamp], "x-visiban-signature": [sig.signature] };
    expect(verifySignature(sig.secret, headers, enc(sig.body), { now: 1700000000 })).toBe(true);
  });

  it("reads several signature header lines as one list", () => {
    const headers = { "x-visiban-timestamp": sig.timestamp, "x-visiban-signature": ["v1=" + "0".repeat(64), sig.signature] };
    expect(verifySignature(sig.secret, headers, enc(sig.body), { now: 1700000000 })).toBe(true);
  });

  it("refuses a signature header over the value cap", () => {
    const signature = [...Array(MAX_SIGNATURE_VALUES).fill("v2=x"), sig.signature].join(",");
    const headers = { "X-Visiban-Timestamp": sig.timestamp, "X-Visiban-Signature": signature };
    expect(verifySignature(sig.secret, headers, enc(sig.body), { now: 1700000000 })).toBe(false);
  });

  it("honors a custom tolerance and the default clock", () => {
    const headers = { "X-Visiban-Timestamp": sig.timestamp, "X-Visiban-Signature": sig.signature };
    expect(verifySignature(sig.secret, headers, enc(sig.body), { now: 1700000010, toleranceSeconds: 5 })).toBe(false);
    expect(verifySignature(sig.secret, headers, enc(sig.body))).toBe(false);
  });

  it("rejects an empty secret and a bad tolerance", () => {
    const h = { "X-Visiban-Timestamp": sig.timestamp, "X-Visiban-Signature": sig.signature };
    expect(() => verifySignature("", h, enc("x"))).toThrow(TypeError);
    for (const t of [NaN, Infinity, -1]) expect(() => verifySignature("s", h, enc("x"), { toleranceSeconds: t })).toThrow(RangeError);
  });

  it("returns false for a huge timestamp", () => {
    expect(verifySignature("s", { "X-Visiban-Timestamp": "9".repeat(5000), "X-Visiban-Signature": "v1=x" }, enc("x"))).toBe(false);
  });

  it("rejects a string body", () => {
    expect(() => verifySignature("s", {}, "x" as unknown as Uint8Array)).toThrow(TypeError);
  });
});
