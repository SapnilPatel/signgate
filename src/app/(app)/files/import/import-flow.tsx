"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import { ServiceError } from "@/lib/services/context";
import { describeTarget, mapRows, parseCsv, type ImportRow, type MappedRows, type ParsedCsv } from "@/lib/services/csv";
import type { ImportRowResult } from "@/lib/services/files";
import { Button, ButtonLink, Notice, SectionTitle, Sheet, Textarea, buttonClass, cx } from "@/components/ui";
import type { SendingOutlook } from "../outlook";
import { importBatchAction } from "./actions";

const SAMPLE_HREF = "/api/app/files/import/sample";
/** Small enough that one request finishes quickly even when every row sends an email. */
const BATCH_ROWS = 25;
const PREVIEW_ROWS = 100;
/** How a pasted list is named on screen, since it has no file name. */
const PASTED = "the pasted rows";

interface Loaded {
  name: string;
  parsed: ParsedCsv;
  mapped: MappedRows;
  /** Spreadsheet row number -> what is wrong with it. Rows listed here are left out of the import. */
  problems: Map<number, string>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Problems that can be seen without the server, so they are shown before anything
 * is created. The service checks every row again; this only saves a round trip.
 */
function findProblems(rows: ImportRow[]): Map<number, string> {
  const problems = new Map<number, string>();
  const references = new Map<string, number>();
  rows.forEach((row, index) => {
    const number = row.row ?? index + 2;
    const name = text(row.clientName).trim();
    const email = text(row.clientEmail).trim();
    const reference = text(row.reference).trim().toLowerCase();
    const found: string[] = [];
    if (!name) found.push("No client name");
    else if (name.length > 200) found.push("The client name is longer than 200 characters");
    if (!email) found.push("No email address");
    else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) found.push(`"${email.slice(0, 60)}" is not an email address`);
    if (reference) {
      const first = references.get(reference);
      if (first !== undefined) found.push(`Same file reference as row ${first}`);
      else references.set(reference, number);
    }
    if (found.length > 0) problems.set(number, found.join(". ") + ".");
  });
  return problems;
}

function read(input: string | Uint8Array, name: string): Loaded {
  const parsed = parseCsv(input);
  const mapped = mapRows(parsed.headers, parsed.rows, parsed.rowNumbers);
  return { name, parsed, mapped, problems: mapped.error ? new Map() : findProblems(mapped.rows) };
}

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const STATUS_TEXT: Record<ImportRowResult["status"] | "left_out", string> = {
  created: "Created",
  skipped: "Skipped",
  error: "Not imported",
  not_processed: "Not reached",
  left_out: "Left out",
};

const th = "px-3 py-2 text-left text-[13px] font-semibold text-ink-soft";
const td = "px-3 py-2 align-top";

export function ImportFlow({ outlook, manager, maxRows }: { outlook: SendingOutlook; manager: boolean; maxRows: number }) {
  const [sheet, setSheet] = useState<Loaded | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pasted, setPasted] = useState("");
  const [send, setSend] = useState(!outlook.blocked && outlook.autoSend);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<Map<number, ImportRowResult> | null>(null);
  const [remaining, setRemaining] = useState<ImportRow[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  // Guards against a second click landing before React has drawn the disabled button.
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = useId();

  const good = useMemo(() => (sheet ? sheet.mapped.rows.filter((row) => !sheet.problems.has(row.row ?? -1)) : []), [sheet]);
  const byNumber = useMemo(() => new Map((sheet?.mapped.rows ?? []).map((row) => [row.row ?? -1, row])), [sheet]);

  function open(input: string | Uint8Array, name: string) {
    setReadError(null);
    try {
      setSheet(read(input, name));
      setOnlyProblems(false);
    } catch (err) {
      setSheet(null);
      setReadError(err instanceof ServiceError ? err.message : "That file could not be read. Save your spreadsheet as CSV and try again.");
    }
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      // Bytes, not text: the parser recognises Excel's own encodings and files that are not spreadsheets at all.
      open(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch {
      setReadError("Your browser could not open that file. Try choosing it again.");
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function startOver() {
    setSheet(null);
    setResults(null);
    setRemaining([]);
    setRunError(null);
    setReadError(null);
    setPasted("");
  }

  async function run(rows: ImportRow[]) {
    if (inFlight.current || rows.length === 0) return;
    inFlight.current = true;
    setRunning(true);
    setRunError(null);
    setProgress({ done: 0, total: rows.length });
    const collected = new Map(results ?? []);
    // Moves the screen to the results view at once, where the progress is shown.
    setResults(new Map(collected));
    const left: ImportRow[] = [];
    let stopped: string | null = null;

    for (let at = 0; at < rows.length; at += BATCH_ROWS) {
      const batch = rows.slice(at, at + BATCH_ROWS);
      if (stopped) {
        left.push(...batch);
        continue;
      }
      let outcome;
      try {
        outcome = await importBatchAction(batch, send);
      } catch {
        outcome = { ok: false as const, error: "The import lost its connection to the server. The rows already imported are safe." };
      }
      if (!outcome || !outcome.ok || !outcome.data) {
        stopped = outcome && !outcome.ok ? outcome.error : "The server did not answer for these rows.";
        left.push(...batch);
        continue;
      }
      for (const result of outcome.data) {
        if (result.status === "not_processed") {
          const row = batch.find((r) => r.row === result.row);
          if (row) left.push(row);
          // An earlier answer for this row (from a previous pass) is more useful than "not reached".
          if (!collected.has(result.row)) collected.set(result.row, result);
        } else {
          collected.set(result.row, result);
        }
      }
      setResults(new Map(collected));
      setProgress({ done: Math.min(rows.length, at + batch.length), total: rows.length });
    }

    setResults(new Map(collected));
    setRemaining(left);
    setRunError(stopped);
    setRunning(false);
    inFlight.current = false;
  }

  function downloadFailed() {
    if (!sheet || !results) return;
    const lines = [[...sheet.parsed.headers, "Problem"].map(csvCell).join(",")];
    sheet.parsed.rows.forEach((cells, index) => {
      const number = sheet.parsed.rowNumbers[index];
      const result = results.get(number);
      const problem = sheet.problems.get(number) ?? (result && (result.status === "error" || result.status === "not_processed") ? result.message : null);
      if (problem) lines.push([...cells, problem].map(csvCell).join(","));
    });
    // The byte-order mark makes Excel read accented names correctly.
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sheet.name === PASTED ? "import" : sheet.name.replace(/\.[a-z0-9]+$/i, "") || "import"}-rows-to-fix.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------ step 3: results
  if (sheet && results) {
    const all = [...results.values()];
    const count = (status: ImportRowResult["status"]) => all.filter((r) => r.status === status).length;
    const created = count("created");
    const skipped = count("skipped");
    const errors = count("error");
    const sent = all.filter((r) => r.agreementSent).length;
    const failedCount = errors + sheet.problems.size + remaining.length;
    const order: Record<string, number> = { error: 0, left_out: 1, not_processed: 2, skipped: 3, created: 4 };
    const lines = [
      ...all.map((r) => ({ row: r.row, status: r.status as ImportRowResult["status"] | "left_out", message: r.message, fileId: r.fileId })),
      ...[...sheet.problems].map(([row, message]) => ({ row, status: "left_out" as const, message, fileId: undefined })),
    ].sort((a, b) => order[a.status] - order[b.status] || a.row - b.row);

    return (
      <div className="space-y-6">
        <Sheet className="space-y-4 p-5 sm:p-6">
          <div aria-live="polite">
            <h2 className="font-serif text-xl font-semibold">
              {running ? `Importing, ${progress.done} of ${progress.total} rows done` : remaining.length > 0 ? "The import is not finished" : "The import is finished"}
            </h2>
            <p className="mt-1 text-ink-soft">
              {plural(created, "file")} created{send ? `, ${plural(sent, "agreement")} sent` : ""}
              {skipped > 0 ? `, ${plural(skipped, "row")} skipped` : ""}
              {errors > 0 ? `, ${plural(errors, "row")} could not be imported` : ""}
              {sheet.problems.size > 0 ? `, ${plural(sheet.problems.size, "row")} left out because of problems` : ""}.
            </p>
          </div>
          {running ? <progress className="block h-2 w-full accent-ink" max={progress.total} value={progress.done} aria-label="Rows imported" /> : null}
          {runError ? (
            <Notice tone="error" title="The import stopped early">
              <p>{runError} Nothing is lost: continue below and the rows already imported are not created twice.</p>
            </Notice>
          ) : null}
          {!running && remaining.length > 0 ? (
            <Notice tone="warning" title={`${plural(remaining.length, "row")} ${remaining.length === 1 ? "has" : "have"} not been imported yet`}>
              <p>The import ran out of time before reaching {remaining.length === 1 ? "it" : "them"}. Continue to import the rest; nothing already created is created again.</p>
            </Notice>
          ) : null}
          {!running ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {remaining.length > 0 ? <Button onClick={() => run(remaining)}>Continue with the remaining {plural(remaining.length, "row")}</Button> : <ButtonLink href="/files">Go to your files</ButtonLink>}
              {failedCount > 0 ? (
                <Button variant="secondary" onClick={downloadFailed}>
                  Download the {plural(failedCount, "row")} to fix
                </Button>
              ) : null}
              <Button variant="quiet" onClick={startOver}>
                Import another spreadsheet
              </Button>
            </div>
          ) : null}
        </Sheet>

        <section aria-labelledby={`${ids}-results`}>
          <SectionTitle className="mb-2">
            <span id={`${ids}-results`}>Row by row</span>
          </SectionTitle>
          <div className="overflow-x-auto rounded-lg border border-rule bg-paper">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">The result for each row of the spreadsheet, problems first</caption>
              <thead className="border-b border-rule bg-desk/60">
                <tr>
                  <th scope="col" className={cx(th, "w-16 pl-4")}>
                    Row
                  </th>
                  <th scope="col" className={th}>
                    Client
                  </th>
                  <th scope="col" className={cx(th, "w-28")}>
                    Result
                  </th>
                  <th scope="col" className={cx(th, "hidden pr-4 sm:table-cell")}>
                    What happened
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={`${line.status}-${line.row}`} className="border-b border-rule-soft last:border-b-0">
                    <td className={cx(td, "tabular pl-4 text-ink-soft")}>{line.row}</td>
                    <td className={cx(td, "[overflow-wrap:anywhere]")}>
                      {text(byNumber.get(line.row)?.clientName) || text(byNumber.get(line.row)?.clientEmail)}
                      {/* On a phone there is no room for a fourth column, so the explanation sits under the name. */}
                      <span className="mt-0.5 block text-[13px] text-ink-soft sm:hidden">
                        {line.message}{" "}
                        {line.fileId ? (
                          <Link href={`/files/${line.fileId}`} className="font-semibold whitespace-nowrap text-ink underline">
                            Open file
                          </Link>
                        ) : null}
                      </span>
                    </td>
                    <td className={cx(td, "font-semibold whitespace-nowrap", line.status === "error" || line.status === "left_out" ? "text-stop" : line.status === "created" ? "text-ink" : "text-ink-soft")}>
                      {STATUS_TEXT[line.status]}
                    </td>
                    <td className={cx(td, "hidden pr-4 text-ink-soft sm:table-cell")}>
                      {line.message}{" "}
                      {line.fileId ? (
                        <Link href={`/files/${line.fileId}`} className="font-semibold whitespace-nowrap text-ink underline">
                          Open file
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }

  // ------------------------------------------------------------------ step 2: preview
  if (sheet) {
    const { mapped, parsed, problems } = sheet;
    const tooMany = mapped.rows.length > maxRows;
    const canRun = !mapped.error && !tooMany && good.length > 0;
    const warnings = [...parsed.warnings, ...mapped.warnings];
    const listed = (onlyProblems ? mapped.rows.filter((row) => problems.has(row.row ?? -1)) : mapped.rows).slice(0, PREVIEW_ROWS);
    const totalListed = onlyProblems ? problems.size : mapped.rows.length;

    return (
      <div className="space-y-6">
        <Sheet className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-serif text-xl font-semibold break-words">
                {plural(mapped.rows.length, "client")} found in {sheet.name}
              </h2>
              <p className="mt-1 text-ink-soft">Nothing has been created yet. Check the columns and the rows below, then import.</p>
            </div>
            <Button variant="secondary" size="sm" onClick={startOver}>
              Choose a different spreadsheet
            </Button>
          </div>

          {mapped.error ? (
            <Notice tone="error" title="This spreadsheet cannot be imported as it is">
              <p>
                {mapped.error}{" "}
                <a href={SAMPLE_HREF}>Download a sample spreadsheet</a> to see the headings that work.
              </p>
            </Notice>
          ) : null}
          {tooMany ? (
            <Notice tone="error" title="Too many rows for one import">
              <p>
                An import can have at most {maxRows} rows and this one has {mapped.rows.length}. Split the spreadsheet into smaller files and import them one at a time.
              </p>
            </Notice>
          ) : null}
          {warnings.length > 0 ? (
            <Notice tone="info" title="Worth checking">
              <ul className="list-disc space-y-1 pl-5">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {!mapped.error && problems.size > 0 ? (
            <Notice tone="warning" title={`${plural(problems.size, "row")} ${problems.size === 1 ? "has a problem" : "have problems"} and will be left out`}>
              <p>
                {good.length > 0
                  ? `The other ${plural(good.length, "row")} can be imported now. After the import you can download the rows that were left out, fix them and import that file.`
                  : "No row can be imported. Fix the spreadsheet and upload it again."}
              </p>
            </Notice>
          ) : null}
        </Sheet>

        <section aria-labelledby={`${ids}-columns`}>
          <SectionTitle className="mb-2">
            <span id={`${ids}-columns`}>How your columns are used</span>
          </SectionTitle>
          <div className="overflow-hidden rounded-lg border border-rule bg-paper">
            <table className="w-full border-collapse text-sm">
              <thead className="border-b border-rule bg-desk/60">
                <tr>
                  <th scope="col" className={cx(th, "w-1/2 pl-4")}>
                    Column in your spreadsheet
                  </th>
                  <th scope="col" className={cx(th, "pr-4")}>
                    Used as
                  </th>
                </tr>
              </thead>
              <tbody>
                {mapped.columns
                  .filter((column) => column.header)
                  .map((column) => (
                    <tr key={column.index} className="border-b border-rule-soft last:border-b-0">
                      <td className={cx(td, "pl-4 font-semibold break-words")}>{column.header}</td>
                      <td className={cx(td, "pr-4 break-words", column.target === null ? "text-ink-faint" : "text-ink-soft")}>
                        {column.target?.startsWith("data:") ? "Kept on the file as an extra value" : column.target === "description" ? "Notes" : describeTarget(column.target)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        {!mapped.error ? (
          <section aria-labelledby={`${ids}-rows`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>
                <span id={`${ids}-rows`}>Rows</span>
              </SectionTitle>
              {problems.size > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} className="h-4 w-4 accent-ink" />
                  Show only rows with problems
                </label>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-lg border border-rule bg-paper">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Rows read from the spreadsheet, as they would be imported</caption>
                <thead className="border-b border-rule bg-desk/60">
                  <tr>
                    <th scope="col" className={cx(th, "w-12 pl-4")}>
                      Row
                    </th>
                    <th scope="col" className={th}>
                      Client
                    </th>
                    <th scope="col" className={cx(th, "hidden md:table-cell")}>
                      Email
                    </th>
                    <th scope="col" className={cx(th, "hidden md:table-cell")}>
                      Company
                    </th>
                    <th scope="col" className={cx(th, "hidden md:table-cell")}>
                      Reference
                    </th>
                    <th scope="col" className={cx(th, "w-[38%] pr-4 md:w-auto")}>
                      Problem
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((row) => {
                    const problem = problems.get(row.row ?? -1);
                    return (
                      <tr key={row.row} className={cx("border-b border-rule-soft last:border-b-0", problem && "bg-stop-soft/50")}>
                        <td className={cx(td, "tabular pl-4 text-ink-soft")}>{row.row}</td>
                        <td className={cx(td, "max-w-[14rem] [overflow-wrap:anywhere]")}>
                          {text(row.clientName)}
                          {/* Narrow screens fold the email into this cell instead of scrolling sideways. */}
                          <span className="block text-[13px] [overflow-wrap:anywhere] text-ink-soft md:hidden">{text(row.clientEmail)}</span>
                        </td>
                        <td className={cx(td, "hidden max-w-[16rem] break-all text-ink-soft md:table-cell")}>{text(row.clientEmail)}</td>
                        <td className={cx(td, "hidden max-w-[12rem] [overflow-wrap:anywhere] text-ink-soft md:table-cell")}>{text(row.clientCompany)}</td>
                        <td className={cx(td, "tabular hidden [overflow-wrap:anywhere] text-ink-soft md:table-cell")}>{text(row.reference) || <span className="text-ink-faint">Generated</span>}</td>
                        <td className={cx(td, "pr-4", problem ? "text-stop" : "text-ink-faint")}>{problem ?? "None"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {totalListed > listed.length ? (
              <p className="mt-2 text-[13px] text-ink-soft">
                Showing the first {listed.length} of {totalListed} rows. Every row is checked, not only the ones shown.
              </p>
            ) : null}
          </section>
        ) : null}

        {canRun ? (
          <Sheet className="space-y-4 p-5 sm:p-6">
            <fieldset className="space-y-2">
              <legend className="mb-2 text-base font-semibold text-ink">Send the agreement to these clients?</legend>
              {outlook.blocked ? (
                <Notice tone="info">
                  <p>
                    {outlook.blocked} The files are created without sending anything.{" "}
                    {manager ? <Link href={outlook.needsAgreement ? "/agreements/new" : "/agreements"}>{outlook.needsAgreement ? "Upload your agreement" : "Fix it under Agreements"}</Link> : "Ask an owner or admin to set it up."}
                  </p>
                </Notice>
              ) : (
                <>
                  <label className="flex items-start gap-2.5 text-sm">
                    <input type="radio" name="send" checked={send} onChange={() => setSend(true)} className="mt-0.5 h-4 w-4 accent-ink" />
                    <span>
                      <span className="font-semibold">Yes, send it now.</span>{" "}
                      <span className="text-ink-soft">
                        {outlook.email === "ok"
                          ? `"${outlook.agreement?.name}" is emailed to each of the ${plural(good.length, "client")} as their file is created.`
                          : `"${outlook.agreement?.name}" is prepared for each client but not emailed${outlook.email === "not_configured" ? ", because email is not set up" : ""}. ${outlook.email === "unverified" ? (outlook.emailReason ?? "") : ""} You copy each signing link from its file.`}
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 text-sm">
                    <input type="radio" name="send" checked={!send} onChange={() => setSend(false)} className="mt-0.5 h-4 w-4 accent-ink" />
                    <span>
                      <span className="font-semibold">No, only create the files.</span> <span className="text-ink-soft">Send the agreement from each file when you are ready.</span>
                    </span>
                  </label>
                </>
              )}
            </fieldset>
            <div>
              <Button disabled={running} aria-busy={running} onClick={() => run(good)}>
                {running ? "Starting the import…" : send && !outlook.blocked ? `Import ${plural(good.length, "file")} and send the agreement` : `Import ${plural(good.length, "file")}`}
              </Button>
            </div>
          </Sheet>
        ) : null}
      </div>
    );
  }

  // ------------------------------------------------------------------ step 1: choose
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Sheet className="space-y-6 p-5 sm:p-8">
        {readError ? <Notice tone="error">{readError}</Notice> : null}
        <div>
          <SectionTitle>Upload a CSV file</SectionTitle>
          <p className="mt-1 text-ink-soft">In Excel or Google Sheets, save or download your client list as CSV, then choose that file here.</p>
          <div className="mt-3">
            <input
              ref={fileInput}
              id={`${ids}-file`}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only peer"
              disabled={reading}
              onChange={(event) => choose(event.target.files?.[0])}
            />
            {/* The label is the visible control; the focus ring follows the hidden input. */}
            <label htmlFor={`${ids}-file`} className={cx(buttonClass("primary"), "cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-note", reading && "opacity-50")}>
              {reading ? "Reading the file…" : "Choose a CSV file"}
            </label>
          </div>
        </div>

        <form
          className="space-y-3 border-t border-rule-soft pt-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (pasted.trim()) open(pasted, PASTED);
          }}
        >
          <label htmlFor={`${ids}-paste`} className="block text-base font-semibold text-ink">
            Or paste the rows
          </label>
          <p className="text-ink-soft">Select the cells in your spreadsheet, including the row of headings, copy them and paste them here.</p>
          <Textarea
            id={`${ids}-paste`}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            rows={6}
            spellCheck={false}
            className="font-mono text-[13px] whitespace-pre"
            placeholder={"Name\tEmail\tCompany\nJane Doe\tjane.doe@example.com\tDoe Renovations Ltd"}
          />
          <Button type="submit" variant="secondary" disabled={!pasted.trim()}>
            Check the pasted rows
          </Button>
        </form>
      </Sheet>

      <aside className="rounded-lg border border-rule bg-paper p-4 text-sm">
        <SectionTitle>What the spreadsheet needs</SectionTitle>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-soft">
          <li>A first row of headings.</li>
          <li>
            A column for the client&rsquo;s <strong className="text-ink">name</strong> and one for their <strong className="text-ink">email</strong>.
          </li>
          <li>Company, title, phone, reference and notes are used when present.</li>
          <li>Any other column is kept on the file, and can fill in blanks on your agreement.</li>
          <li>Up to {maxRows} rows at a time.</li>
        </ul>
        <p className="mt-3">
          <a href={SAMPLE_HREF} className="font-semibold text-ink underline">
            Download a sample spreadsheet
          </a>
        </p>
      </aside>
    </div>
  );
}
