import { contentDisposition, withActor } from "@/lib/route";

/*
 * Headings the importer recognises, one row per client. The people are invented and
 * the addresses use example.com, which can never receive mail. "Policy number" shows
 * that a column the importer does not know is kept as an extra value on the file.
 */
const SAMPLE = [
  ["Name", "Email", "Company", "Title", "Phone", "Reference", "Notes", "Policy number"],
  ["Jane Doe", "jane.doe@example.com", "Doe Renovations Ltd", "Director", "555-0100", "F-1001", "Kitchen water damage claim", "POL-48213"],
  ["Sam Sample", "sam.sample@example.com", "", "", "555-0101", "F-1002", "Roof repair after storm", "POL-51877"],
  ["Alex Example", "alex@example.com", "Example Holdings Inc", "Office manager", "", "", "Leave Reference empty to have one generated", ""],
];

const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** A spreadsheet to copy the headings from. Signed-in only, like everything under /api/app. */
export const GET = withActor(async () => {
  // The byte-order mark makes Excel read the file as UTF-8 instead of guessing a legacy encoding.
  const body = "﻿" + SAMPLE.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition("client-list-sample.csv"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
