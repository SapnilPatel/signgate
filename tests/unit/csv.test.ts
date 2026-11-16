import { describe, it, expect } from "vitest";
import { parseCsv, mapRows, normalizeDataKey, describeTarget, CSV_LIMITS, MAX_DATA_COLUMNS } from "@/lib/services/csv";
import { ServiceError } from "@/lib/services/context";

const bytes = (text: string) => new TextEncoder().encode(text);

function expectInvalid(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("invalid");
    expect((err as ServiceError).message).toMatch(pattern);
    return;
  }
  throw new Error("expected a ServiceError");
}

describe("parseCsv", () => {
  it("parses a plain file", () => {
    const csv = parseCsv("Name,Email\nJane Doe,jane@example.com\nSam Lee,sam@example.com\n");
    expect(csv.headers).toEqual(["Name", "Email"]);
    expect(csv.rows).toEqual([
      ["Jane Doe", "jane@example.com"],
      ["Sam Lee", "sam@example.com"],
    ]);
    expect(csv.rowNumbers).toEqual([2, 3]);
    expect(csv.delimiter).toBe(",");
    expect(csv.warnings).toEqual([]);
  });

  it("handles quoted fields with delimiters, escaped quotes and embedded newlines", () => {
    const csv = parseCsv('Name,Notes\r\n"Doe, Jane","She said ""hello""\r\nthen left"\r\n"Lee, Sam",""\r\n');
    expect(csv.rows).toEqual([
      ["Doe, Jane", 'She said "hello"\r\nthen left'],
      ["Lee, Sam", ""],
    ]);
    // The row after a multi-line cell is still spreadsheet row 3.
    expect(csv.rowNumbers).toEqual([2, 3]);
  });

  it("accepts CRLF, LF and bare CR line endings and no trailing newline", () => {
    for (const eol of ["\r\n", "\n", "\r"]) {
      const csv = parseCsv(`a,b${eol}1,2${eol}3,4`);
      expect(csv.rows).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    }
  });

  it("strips a UTF-8 byte-order mark from text and from bytes", () => {
    expect(parseCsv("﻿Name,Email\nA,a@example.com").headers).toEqual(["Name", "Email"]);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("Name,Email\nA,a@example.com")]);
    expect(parseCsv(withBom).headers).toEqual(["Name", "Email"]);
  });

  it("detects semicolon, tab and pipe delimiters from the header", () => {
    expect(parseCsv("Name;Email\nDoe, Jane;jane@example.com").rows).toEqual([["Doe, Jane", "jane@example.com"]]);
    expect(parseCsv("Name\tEmail\nJane\tjane@example.com").delimiter).toBe("\t");
    expect(parseCsv("Name|Email\nJane|jane@example.com").delimiter).toBe("|");
  });

  it("is not fooled by delimiters inside a quoted header", () => {
    const csv = parseCsv('"Name; full";Email\nJane;jane@example.com');
    expect(csv.delimiter).toBe(";");
    expect(csv.headers).toEqual(["Name; full", "Email"]);
  });

  it("honours Excel's sep= line", () => {
    const csv = parseCsv("sep=;\r\nName;Email\r\nJane;jane@example.com\r\n");
    expect(csv.headers).toEqual(["Name", "Email"]);
    expect(csv.rows).toEqual([["Jane", "jane@example.com"]]);
  });

  it("drops trailing and interleaved empty lines but keeps spreadsheet row numbers", () => {
    const csv = parseCsv("Name,Email\n\nJane,jane@example.com\n,\n   \nSam,sam@example.com\n\n\n\n");
    expect(csv.rows).toEqual([
      ["Jane", "jane@example.com"],
      ["Sam", "sam@example.com"],
    ]);
    expect(csv.rowNumbers).toEqual([3, 6]);
  });

  it("skips blank lines before the header", () => {
    expect(parseCsv("\n\n  \nName,Email\nJane,jane@example.com").headers).toEqual(["Name", "Email"]);
  });

  it("pads short rows and warns about values beyond the header", () => {
    const csv = parseCsv("Name,Email,Company\nJane\nSam,sam@example.com,Acme,Extra,More\n");
    expect(csv.rows).toEqual([
      ["Jane", "", ""],
      ["Sam", "sam@example.com", "Acme"],
    ]);
    expect(csv.warnings.join(" ")).toMatch(/1 row has more values/);
  });

  it("ignores trailing empty header cells and names blank ones", () => {
    const csv = parseCsv("Name,,Email,,,\nJane,x,jane@example.com,,,\n");
    expect(csv.headers).toEqual(["Name", "Column 2", "Email"]);
    expect(csv.rows).toEqual([["Jane", "x", "jane@example.com"]]);
    expect(csv.warnings).toEqual([]);
  });

  it("treats a quote inside an unquoted field as text", () => {
    const csv = parseCsv('Name,Height\nJane,5\'10" tall\nSam "Sammy" Lee,6ft\n');
    expect(csv.rows).toEqual([
      ["Jane", '5\'10" tall'],
      ['Sam "Sammy" Lee', "6ft"],
    ]);
  });

  it("recovers from an unterminated quote with a warning instead of throwing", () => {
    const csv = parseCsv('Name,Email\n"Jane,jane@example.com\nSam,sam@example.com');
    expect(csv.rows).toHaveLength(1);
    expect(csv.warnings.join(" ")).toMatch(/never closed/);
  });

  it("keeps text after a closing quote", () => {
    expect(parseCsv('a,b\n"x"y,z').rows).toEqual([["xy", "z"]]);
  });

  it("decodes UTF-16 with a byte-order mark (Excel Unicode Text) in both byte orders", () => {
    const text = "Name\tEmail\nZoë\tzoe@example.com\n";
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    const be = new Uint8Array(2 + text.length * 2);
    be.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      le[2 + i * 2] = code & 0xff;
      le[3 + i * 2] = code >> 8;
      be[2 + i * 2] = code >> 8;
      be[3 + i * 2] = code & 0xff;
    }
    for (const input of [le, be]) {
      const csv = parseCsv(input);
      expect(csv.delimiter).toBe("\t");
      expect(csv.rows).toEqual([["Zoë", "zoe@example.com"]]);
    }
  });

  it("falls back to Windows-1252 when the bytes are not UTF-8", () => {
    const input = new Uint8Array([...bytes("Name,Email\nRen"), 0xe9, ...bytes("e,renee@example.com\n")]);
    expect(parseCsv(input).rows[0][0]).toBe("Renée");
  });

  it("keeps non-ASCII text and emoji intact", () => {
    const csv = parseCsv(bytes("Name,Email\n山田太郎 😀,taro@example.com\n"));
    expect(csv.rows[0][0]).toBe("山田太郎 😀");
  });

  it("removes NUL and zero-width characters from cells", () => {
    const csv = parseCsv("Name,Email\nJa\u0000ne​, jane@example.com \n");
    expect(csv.rows).toEqual([["Jane", "jane@example.com"]]);
  });

  it("rejects empty and whitespace-only input with a message that says what to do", () => {
    expectInvalid(() => parseCsv(""), /empty/);
    expectInvalid(() => parseCsv(" \n\r\n\t\n"), /empty/);
    expectInvalid(() => parseCsv(new Uint8Array()), /empty/);
    expectInvalid(() => parseCsv(",,,\n1,2,3"), /no column headings/);
  });

  it("recognises spreadsheets and other files uploaded by mistake", () => {
    expectInvalid(() => parseCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])), /Excel workbook/);
    expectInvalid(() => parseCsv(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])), /\.xls/);
    expectInvalid(() => parseCsv(bytes("%PDF-1.7 something")), /PDF/);
    expectInvalid(() => parseCsv(new Uint8Array(400)), /not a CSV/);
  });

  it("rejects input that is not text or bytes, and oversized files", () => {
    expectInvalid(() => parseCsv(null as unknown as string), /No spreadsheet/);
    expectInvalid(() => parseCsv({} as unknown as string), /No spreadsheet/);
    expectInvalid(() => parseCsv("a".repeat(CSV_LIMITS.maxBytes + 1)), /larger than 5 MB/);
    expectInvalid(() => parseCsv(Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(",")), /columns/);
  });

  it("caps the number of rows and says so", () => {
    const lines = ["Name"];
    for (let i = 0; i < CSV_LIMITS.maxRows + 50; i++) lines.push(`n${i}`);
    const csv = parseCsv(lines.join("\n"));
    expect(csv.rows).toHaveLength(CSV_LIMITS.maxRows);
    expect(csv.warnings.join(" ")).toMatch(/Only the first/);
  });

  it("reads a header-only file as zero rows", () => {
    const csv = parseCsv("Name,Email\n");
    expect(csv.headers).toEqual(["Name", "Email"]);
    expect(csv.rows).toEqual([]);
  });

  it("never throws anything but ServiceError on mangled input", () => {
    // Deterministic generator so a failure can be reproduced.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['"', ",", ";", "\t", "\n", "\r", "a", "é", " ", "\u0000", "|", "="];
    for (let i = 0; i < 300; i++) {
      let s = "";
      const len = Math.floor(rand() * 60);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      try {
        const csv = parseCsv(s);
        for (const row of csv.rows) expect(row).toHaveLength(csv.headers.length);
        expect(csv.rows).toHaveLength(csv.rowNumbers.length);
        mapRows(csv.headers, csv.rows, csv.rowNumbers);
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
      }
    }
  });
});

describe("mapRows", () => {
  it("maps the common header aliases", () => {
    const headers = ["Client Name", "E-mail", "Company", "Phone", "File #", "Notes", "Job Title", "External ID"];
    const mapped = mapRows(headers, [["Jane Doe", "Jane@Example.com", "Acme", "555-0100", "A-1", "Kitchen", "Owner", "crm-9"]]);
    expect(mapped.error).toBeNull();
    expect(mapped.missing).toEqual([]);
    expect(mapped.columns.map((c) => c.target)).toEqual([
      "clientName", "clientEmail", "clientCompany", "clientPhone", "reference", "description", "clientTitle", "externalId",
    ]);
    expect(mapped.rows[0]).toEqual({
      row: 2,
      clientName: "Jane Doe",
      clientEmail: "Jane@Example.com",
      clientCompany: "Acme",
      clientPhone: "555-0100",
      reference: "A-1",
      description: "Kitchen",
      clientTitle: "Owner",
      externalId: "crm-9",
    });
  });

  it.each([
    ["name", "clientName"],
    ["Full name", "clientName"],
    ["CUSTOMER", "clientName"],
    ["Email address", "clientEmail"],
    ["e_mail", "clientEmail"],
    ["  EMAIL  ", "clientEmail"],
    ["Organisation", "clientCompany"],
    ["Mobile", "clientPhone"],
    ["Reference", "reference"],
    ["Matter", "reference"],
    ["Case number", "reference"],
    ["Job No.", "reference"],
    ["File Number", "reference"],
    ["Ref #", "reference"],
    ["Description", "description"],
    ["Comments", "description"],
    ["ID", "externalId"],
  ])("recognises %s", (header, target) => {
    const other = target === "clientEmail" ? "Name" : "Email";
    const mapped = mapRows([header, other], [["x", "y"]]);
    expect(mapped.columns[0].target).toBe(target);
  });

  it("joins first and last name columns when there is no full name", () => {
    const mapped = mapRows(["First Name", "Last Name", "Email"], [
      ["Jane", "Doe", "jane@example.com"],
      ["Cher", "", "cher@example.com"],
    ]);
    expect(mapped.error).toBeNull();
    expect(mapped.rows.map((r) => r.clientName)).toEqual(["Jane Doe", "Cher"]);
  });

  it("prefers the full name column but falls back to the split ones for a blank cell", () => {
    const mapped = mapRows(["Name", "First", "Last", "Email"], [
      ["Dr Jane Doe", "Jane", "Doe", "a@example.com"],
      ["", "Sam", "Lee", "b@example.com"],
    ]);
    expect(mapped.rows.map((r) => r.clientName)).toEqual(["Dr Jane Doe", "Sam Lee"]);
  });

  it("keeps unknown columns as custom values under a normalized key", () => {
    const mapped = mapRows(["Name", "Email", "Policy Number", "Loss Date"], [["Jane", "jane@example.com", "P-77", ""]]);
    expect(mapped.dataColumns).toEqual(["Policy Number", "Loss Date"]);
    expect(mapped.columns[2].target).toBe("data:policy_number");
    // Empty cells are not stored.
    expect(mapped.rows[0].data).toEqual({ policy_number: "P-77" });
    expect(describeTarget(mapped.columns[2].target)).toBe("Extra value (policy_number)");
    expect(describeTarget(mapped.columns[1].target)).toBe("Client email");
    expect(describeTarget(null)).toBe("Ignored");
  });

  it("reports missing required columns with the headings it found", () => {
    const mapped = mapRows(["Company", "Phone"], [["Acme", "555"]]);
    expect(mapped.missing).toEqual(["Client name", "Client email"]);
    expect(mapped.error).toMatch(/"Name"/);
    expect(mapped.error).toMatch(/"Email"/);
    expect(mapped.error).toMatch(/"Company", "Phone"/);

    const onlyEmailMissing = mapRows(["Name"], [["Jane"]]);
    expect(onlyEmailMissing.missing).toEqual(["Client email"]);
    expect(onlyEmailMissing.error).not.toMatch(/First name/);
  });

  it("reports a header row with no data", () => {
    const mapped = mapRows(["Name", "Email"], []);
    expect(mapped.error).toMatch(/no clients/);
    expect(mapped.rows).toEqual([]);
  });

  it("keeps the first of two columns that mean the same thing and stores the other as an extra value", () => {
    const mapped = mapRows(["Email", "Contact Email", "Name"], [["a@example.com", "b@example.com", "Jane"]]);
    expect(mapped.rows[0].clientEmail).toBe("a@example.com");
    expect(mapped.rows[0].data).toEqual({ contact_email: "b@example.com" });
    expect(mapped.warnings.join(" ")).toMatch(/both look like the client email/);
  });

  it("ignores exact duplicate and blank headings and says so", () => {
    const mapped = mapRows(["Name", "Email", "Region", "Region", ""], [["Jane", "jane@example.com", "North", "South", "stray"]]);
    expect(mapped.rows[0].data).toEqual({ region: "North" });
    expect(mapped.unmapped).toEqual(["Region", "Column 5"]);
    expect(mapped.warnings.join(" ")).toMatch(/more than one column named "Region"/);
    expect(mapped.warnings.join(" ")).toMatch(/Column 5 has no heading/);
  });

  it("does not warn about a blank heading whose column is empty", () => {
    const mapped = mapRows(["Name", "Email", "Column 3"], [["Jane", "jane@example.com", ""]]);
    expect(mapped.warnings).toEqual([]);
    expect(mapped.unmapped).toEqual([]);
  });

  it("caps the number of extra columns", () => {
    const extra = Array.from({ length: MAX_DATA_COLUMNS + 5 }, (_, i) => `Extra ${i}`);
    const mapped = mapRows(["Name", "Email", ...extra], [["Jane", "jane@example.com", ...extra.map(() => "v")]]);
    expect(mapped.dataColumns).toHaveLength(MAX_DATA_COLUMNS);
    expect(Object.keys(mapped.rows[0].data as object)).toHaveLength(MAX_DATA_COLUMNS);
    expect(mapped.unmapped).toHaveLength(5);
    expect(mapped.warnings.join(" ")).toMatch(/Only 50 extra columns/);
  });

  it("tidies emails written as a display name or a mailto link", () => {
    const mapped = mapRows(["Name", "Email"], [
      ["Jane", "Jane Doe <jane@example.com>"],
      ["Sam", "mailto:sam@example.com"],
    ]);
    expect(mapped.rows.map((r) => r.clientEmail)).toEqual(["jane@example.com", "sam@example.com"]);
  });

  it("uses the supplied spreadsheet row numbers", () => {
    const csv = parseCsv("Name,Email\n\nJane,jane@example.com\n\nSam,sam@example.com\n");
    const mapped = mapRows(csv.headers, csv.rows, csv.rowNumbers);
    expect(mapped.rows.map((r) => r.row)).toEqual([3, 5]);
  });

  it("cannot be used to set object prototype keys", () => {
    const mapped = mapRows(["Name", "Email", "__proto__", "constructor"], [["Jane", "jane@example.com", "x", "y"]]);
    const data = mapped.rows[0].data as Record<string, string>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(data).toEqual({ proto: "x", constructor: "y" });
  });

  it("survives input that is not what the types promise", () => {
    expect(mapRows(null, null).error).toMatch(/no column headings/);
    const mapped = mapRows(["Name", 7, null, "Email"], [["Jane", 1, {}, "jane@example.com"], "nonsense", null] as unknown[]);
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0].clientName).toBe("Jane");
    expect(mapped.rows[0].data).toEqual({ "7": "1" });
  });
});

describe("normalizeDataKey", () => {
  it("gives one key for every spelling of a heading", () => {
    for (const label of ["Policy Number", "policy_number", " POLICY  NUMBER ", "policy-number", "Policy Number:"]) {
      expect(normalizeDataKey(label)).toBe("policy_number");
    }
  });

  it("keeps letters from other scripts, bounds the length and rejects non-text", () => {
    expect(normalizeDataKey("Número de póliza")).toBe("número_de_póliza");
    expect(normalizeDataKey("保険番号")).toBe("保険番号");
    expect(normalizeDataKey("x".repeat(500))).toHaveLength(60);
    expect(normalizeDataKey("###")).toBe("");
    expect(normalizeDataKey(null)).toBe("");
    expect(normalizeDataKey({})).toBe("");
    expect(normalizeDataKey(12)).toBe("12");
  });
});
