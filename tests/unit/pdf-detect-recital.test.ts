import { describe, expect, it } from "vitest";
import { classifyBodyBlank } from "@/lib/pdf/detect/labels";
import { pdfResponse } from "@/lib/route";

describe("blanks in an opening recital", () => {
  it("reads the name blank and the address blank from the words on both sides", () => {
    const name = classifyBodyBlank('Suite 1200, San Francisco, California ("Consultant"), and', ', with its principal place of business at ____ ("Client").');
    expect(name).toMatchObject({ role: "prefill", mergeKey: "client_name", label: "Client name" });
    const address = classifyBodyBlank("____ , with its principal place of business at", ' ("Client").');
    expect(address).toMatchObject({ role: "client", type: "text", label: "Client address", settled: true });
    expect(address.mergeKey).toBeUndefined();
  });

  it("never labels a field with the tail of a sentence", () => {
    expect(classifyBodyBlank("the parties shall meet in Springfield and", "to discuss the work.").label).toBe("");
    expect(classifyBodyBlank("Preferred start time:", "").label).toBe("Preferred start time");
  });

  it("splits '____, 20__' into month and day, then a two-digit year", () => {
    expect(classifyBodyBlank("is entered into as of", ', 20 ____ (the "Effective Date")')).toMatchObject({ mergeKey: "custom:today_month_day" });
    expect(classifyBodyBlank("is entered into as of ____ , 20", '(the "Effective Date")')).toMatchObject({ mergeKey: "custom:today_year_short" });
    expect(classifyBodyBlank("is entered into as of", "by and between")).toMatchObject({ mergeKey: "today", type: "date" });
  });
});

describe("pdfResponse", () => {
  it("streams a large PDF in slices and delivers every byte", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
    const res = pdfResponse(bytes, "big");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const parts = [first.value!];
    for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value);
    expect(Buffer.compare(Buffer.concat(parts), Buffer.from(bytes))).toBe(0);
  });
});
