import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { rateLimit, clearRateLimit, clearRateLimitPrefix, describeWait } from "@/lib/services/rate-limit";
import {
  normalizeEmail,
  isValidEmail,
  cleanText,
  cleanMultilineText,
  isHexColor,
  normalizeHexColor,
  parseImageDataUrl,
  emailSchema,
  textSchema,
  optionalTextSchema,
  isSecretToken,
} from "@/lib/validation";

let n = 0;
const key = (label: string) => `test:${label}:${++n}`;

async function expireWindow(k: string) {
  const db = await getDb();
  await db.update(rateLimits).set({ resetAt: new Date(Date.now() - 5_000) }).where(eq(rateLimits.key, k));
}

describe("rateLimit", () => {
  it("allows up to the limit, then blocks with a wait time", async () => {
    const k = key("basic");
    for (let i = 0; i < 3; i++) expect(await rateLimit(k, 3, 60)).toEqual({ ok: true, retryAfterSeconds: 0 });
    const blocked = await rateLimit(k, 3, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("keeps separate counters per key", async () => {
    const a = key("a");
    const b = key("b");
    expect((await rateLimit(a, 1, 60)).ok).toBe(true);
    expect((await rateLimit(a, 1, 60)).ok).toBe(false);
    expect((await rateLimit(b, 1, 60)).ok).toBe(true);
  });

  it("starts a fresh window once the old one has passed", async () => {
    const k = key("window");
    expect((await rateLimit(k, 1, 60)).ok).toBe(true);
    expect((await rateLimit(k, 1, 60)).ok).toBe(false);
    await expireWindow(k);
    expect((await rateLimit(k, 1, 60)).ok).toBe(true);
    const db = await getDb();
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, k));
    expect(row.count).toBe(1);
    expect(row.resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not extend the window when blocked calls keep arriving", async () => {
    const k = key("fixed");
    await rateLimit(k, 1, 60);
    const db = await getDb();
    const [before] = await db.select().from(rateLimits).where(eq(rateLimits.key, k));
    await rateLimit(k, 1, 600);
    await rateLimit(k, 1, 600);
    const [after] = await db.select().from(rateLimits).where(eq(rateLimits.key, k));
    expect(after.resetAt.getTime()).toBe(before.resetAt.getTime());
    expect(after.count).toBe(3);
  });

  it("lets exactly `limit` of many concurrent calls through", async () => {
    const k = key("concurrent");
    const results = await Promise.all(Array.from({ length: 25 }, () => rateLimit(k, 7, 60)));
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect(results.filter((r) => !r.ok)).toHaveLength(18);
  });

  it("treats a zero, negative or nonsense limit as always blocked", async () => {
    for (const limit of [0, -1, Number.NaN, 0.5]) {
      const r = await rateLimit(key("zero"), limit, 60);
      expect(r.ok).toBe(false);
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("survives nonsense windows and very long or strange keys", async () => {
    expect((await rateLimit(key("w"), 1, 0)).ok).toBe(true);
    expect((await rateLimit(key("w"), 1, Number.NaN)).ok).toBe(true);
    expect((await rateLimit(key("w"), 1, Number.POSITIVE_INFINITY)).ok).toBe(true);
    expect((await rateLimit(key("w"), 1, -50)).ok).toBe(true);

    const long = key("long") + "x".repeat(5000);
    expect((await rateLimit(long, 1, 60)).ok).toBe(true);
    expect((await rateLimit(long, 1, 60)).ok).toBe(false);
    // A different long key with the same first 200 characters has its own counter.
    expect((await rateLimit(long + "y", 1, 60)).ok).toBe(true);

    const odd = key("odd") + "'; drop table rate_limits; -- " + String.fromCodePoint(0x1f600);
    expect((await rateLimit(odd, 1, 60)).ok).toBe(true);
    expect((await rateLimit(odd, 1, 60)).ok).toBe(false);
  });

  it("clearRateLimit forgets a key", async () => {
    const k = key("clear");
    await rateLimit(k, 1, 60);
    expect((await rateLimit(k, 1, 60)).ok).toBe(false);
    await clearRateLimit(k);
    expect((await rateLimit(k, 1, 60)).ok).toBe(true);
    await expect(clearRateLimit(key("never-used"))).resolves.toBeUndefined();
  });

  it("clearRateLimitPrefix forgets every key under a prefix and nothing else", async () => {
    const base = key("prefix");
    const inside = [`${base}:a`, `${base}:b`, `${base}:`];
    // "%" and "_" must be matched literally, not as wildcards.
    const outside = [`${base}x:a`, `x${base}:a`, base.replace("test", "tes%") + ":a", base.replace(":", "_") + ":a"];
    for (const k of [...inside, ...outside]) await rateLimit(k, 1, 60);

    await clearRateLimitPrefix(`${base}:`);
    for (const k of inside) expect((await rateLimit(k, 1, 60)).ok).toBe(true);
    for (const k of outside) expect((await rateLimit(k, 1, 60)).ok).toBe(false);
  });

  it("clearRateLimitPrefix ignores an empty, wildcard-only or oversized prefix", async () => {
    const k = key("survivor");
    await rateLimit(k, 1, 60);
    await expect(clearRateLimitPrefix("")).resolves.toBeUndefined();
    await expect(clearRateLimitPrefix("%")).resolves.toBeUndefined();
    await expect(clearRateLimitPrefix("x".repeat(5000))).resolves.toBeUndefined();
    await expect(clearRateLimitPrefix(undefined as never)).resolves.toBeUndefined();
    expect((await rateLimit(k, 1, 60)).ok).toBe(false);
  });

  it("describes waits in plain words", () => {
    expect(describeWait(1)).toBe("in 1 minute");
    expect(describeWait(60)).toBe("in 1 minute");
    expect(describeWait(61)).toBe("in 2 minutes");
    expect(describeWait(900)).toBe("in 15 minutes");
    expect(describeWait(86_400)).toBe("in about 24 hours");
  });
});

describe("validation", () => {
  it("normalizes emails and tolerates non-strings", () => {
    expect(normalizeEmail("  Ada@Example.COM \n")).toBe("ada@example.com");
    for (const v of [undefined, null, 42, {}, [], true]) expect(normalizeEmail(v)).toBe("");
  });

  it("accepts ordinary addresses", () => {
    for (const email of [
      "ada@example.com",
      "first.last+tag@sub.example.co.uk",
      "o'brien@example.org",
      "a@b.io",
      "user_name-1@example-domain.com",
      "x@xn--bcher-kva.example",
    ]) {
      expect(isValidEmail(email), email).toBe(true);
    }
  });

  it("rejects junk", () => {
    const tooLongLocal = "a".repeat(65) + "@example.com";
    const tooLong = "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(63) + "." + "e".repeat(60) + ".com";
    for (const email of [
      "",
      " ",
      "plain",
      "@example.com",
      "ada@",
      "ada@example",
      "ada@@example.com",
      "ada@exa mple.com",
      "ada smith@example.com",
      "ada@example..com",
      ".ada@example.com",
      "ada.@example.com",
      "a..b@example.com",
      "ada@-example.com",
      "ada@example-.com",
      "ada@example.c",
      "ada@example.123",
      "ada@10.0.0.1",
      "ada@[10.0.0.1]",
      '"ada"@example.com',
      "ada@example.com\nbcc: victim@example.org",
      "ada@example.com, other@example.com",
      "Ada <ada@example.com>",
      "ada@example.com" + String.fromCharCode(0),
      tooLongLocal,
      tooLong,
    ]) {
      expect(isValidEmail(email), JSON.stringify(email)).toBe(false);
    }
    for (const v of [undefined, null, 42, {}, ["a@b.com"]]) expect(isValidEmail(v)).toBe(false);
  });

  it("cleans single-line text", () => {
    expect(cleanText("  Ada \t\n  Lovelace  ", 50)).toBe("Ada Lovelace");
    expect(cleanText("a" + String.fromCharCode(0) + "b" + String.fromCharCode(7) + "c" + String.fromCharCode(0x1b) + "[31m", 50)).toBe("abc[31m");
    // Right-to-left override and zero-width space are removed; they can disguise text.
    expect(cleanText("evil" + String.fromCharCode(0x202e) + "txt" + String.fromCharCode(0x200b), 50)).toBe("eviltxt");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("ab cdef", 3)).toBe("ab");
    expect(cleanText(42, 10)).toBe("42");
    for (const v of [undefined, null, {}, [], true, Number.NaN]) expect(cleanText(v, 10)).toBe("");
    expect(cleanText("abc", -1)).toBe("");
    expect(cleanText("abc", Number.NaN)).toBe("");
  });

  it("never returns half of an emoji", () => {
    const grin = String.fromCodePoint(0x1f600);
    const cut = cleanText("ab" + grin, 3);
    expect(cut).toBe("ab");
    expect(cleanText(grin.slice(0, 1) + "x", 10)).toBe("x");
    expect(cleanText("x" + grin.slice(1), 10)).toBe("x");
    expect(cleanText(grin, 10)).toBe(grin);
  });

  it("keeps paragraphs in multi-line text", () => {
    expect(cleanMultilineText("  Hello,  \r\n\r\n\r\n\r\n  please   sign.\rThanks  ", 500)).toBe("Hello,\n\nplease sign.\nThanks");
    expect(cleanMultilineText(undefined, 10)).toBe("");
    expect(cleanMultilineText("abcdef", 4)).toBe("abcd");
  });

  it("recognises hex colours", () => {
    expect(isHexColor("#1f3a5f")).toBe(true);
    expect(isHexColor("#ABC")).toBe(true);
    for (const v of ["1f3a5f", "#1f3a5", "#1f3a5f80", "#ggg", "red", "rgb(0,0,0)", "#fff; background:url(x)", "", null, 123]) {
      expect(isHexColor(v), String(v)).toBe(false);
    }
    expect(normalizeHexColor(" #AbC ")).toBe("#aabbcc");
    expect(normalizeHexColor("#1F3A5F")).toBe("#1f3a5f");
    expect(normalizeHexColor("blue")).toBeNull();
  });

  it("checks image data URLs by their bytes, not their label", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const url = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

    const ok = parseImageDataUrl(url("image/png", png), ["png"], 1000);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.kind).toBe("png");
      expect(ok.bytes.equals(png)).toBe(true);
      expect(ok.dataUrl).toBe(url("image/png", png));
    }
    expect(parseImageDataUrl(url("image/jpeg", jpeg), ["png", "jpeg"], 1000).ok).toBe(true);
    expect(parseImageDataUrl(url("image/jpg", jpeg), ["png", "jpeg"], 1000).ok).toBe(true);

    expect(parseImageDataUrl(url("image/jpeg", jpeg), ["png"], 1000)).toEqual({ ok: false, reason: "format" });
    expect(parseImageDataUrl(url("image/svg+xml", svg), ["png", "jpeg"], 1000)).toEqual({ ok: false, reason: "format" });
    // SVG or HTML bytes labelled as PNG.
    expect(parseImageDataUrl(url("image/png", svg), ["png", "jpeg"], 1000)).toEqual({ ok: false, reason: "corrupt" });
    // Real JPEG labelled as PNG.
    expect(parseImageDataUrl(url("image/png", jpeg), ["png", "jpeg"], 1000)).toEqual({ ok: false, reason: "format" });
    expect(parseImageDataUrl(url("image/png", png), ["png"], png.length - 1)).toEqual({ ok: false, reason: "too_large" });
    expect(parseImageDataUrl("data:image/png;base64,", ["png"], 1000)).toEqual({ ok: false, reason: "corrupt" });
    expect(parseImageDataUrl("data:image/png;base64,!!!not base64!!!", ["png"], 1000)).toEqual({ ok: false, reason: "corrupt" });
    expect(parseImageDataUrl("data:image/png," + png.toString("base64"), ["png"], 1000)).toEqual({ ok: false, reason: "format" });
    expect(parseImageDataUrl("https://example.com/logo.png", ["png"], 1000)).toEqual({ ok: false, reason: "format" });
    // Truncated to the signature only: no header chunk.
    expect(parseImageDataUrl(url("image/png", png.subarray(0, 8)), ["png"], 1000)).toEqual({ ok: false, reason: "corrupt" });
    // Zero-width PNG.
    const zero = Buffer.from(png);
    zero.writeUInt32BE(0, 16);
    expect(parseImageDataUrl(url("image/png", zero), ["png"], 1000)).toEqual({ ok: false, reason: "corrupt" });
    for (const v of [undefined, null, 5, {}, []]) expect(parseImageDataUrl(v, ["png"], 1000).ok).toBe(false);
  });

  it("exposes zod schemas that clean before validating", () => {
    expect(emailSchema.parse("  Ada@Example.com ")).toBe("ada@example.com");
    expect(emailSchema.safeParse("nope").success).toBe(false);
    expect(emailSchema.safeParse(undefined).success).toBe(false);
    expect(textSchema(10, "Name").parse("  Ada   L ")).toBe("Ada L");
    const blank = textSchema(10, "Name").safeParse("   ");
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error.issues[0].message).toBe("Name is required.");
    expect(textSchema(3, "Name").safeParse("abcd").success).toBe(false);
    expect(optionalTextSchema(10).parse("")).toBeNull();
    expect(optionalTextSchema(10).parse(undefined)).toBeNull();
    expect(optionalTextSchema(10).parse(" x ")).toBe("x");
  });

  it("recognises link secrets", () => {
    expect(isSecretToken("a".repeat(32))).toBe(true);
    for (const v of ["a".repeat(31), "A".repeat(32), "a".repeat(31) + "/", "", null, 7]) expect(isSecretToken(v)).toBe(false);
  });
});
