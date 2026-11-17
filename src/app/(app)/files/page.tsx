import type { Metadata } from "next";
import Link from "next/link";
import { canManage } from "@/lib/auth/session";
import type { FileRow } from "@/lib/db/schema";
import { requireActor } from "@/lib/request";
import { resolveSettings } from "@/lib/services/accounts";
import type { Actor } from "@/lib/services/context";
import { listEnvelopes, type EnvelopeListItem } from "@/lib/services/envelopes";
import { dashboardStats, fileCounts, listFiles, type FileCounts } from "@/lib/services/files";
import { orgTimeZone } from "@/lib/services/signing";
import { ButtonLink, EmptyState, Notice, PageHeader, STATUS_LABEL, StatusBadge, cx, formatDate, type AgreementStatus } from "@/components/ui";
import { STATUS_FILTERS, durationLabel, filesHref, isStatusFilter, shortDate, waitLabel } from "./format";
import { getSendingOutlook } from "./outlook";
import { SearchBox } from "./search-box";

export const metadata: Metadata = { title: "Files" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/** What a row is waiting for, taken from the envelope that is out on that file. */
interface Waiting {
  since: Date;
  /** True when the agreement is waiting for a countersignature this viewer may give. */
  needsViewer: boolean;
}

const OPEN = ["draft", "sent", "viewed", "client_signed"] as const;

/**
 * How long each waiting file on this page has been waiting, and on whom. One query
 * covers the usual case; a file whose envelope is older than the newest 200 open
 * ones is looked up by itself so the column is never silently blank.
 */
async function loadWaiting(actor: Actor, rows: FileRow[], mayCountersign: (envelope: EnvelopeListItem) => boolean): Promise<Map<string, Waiting>> {
  const waiting = rows.filter((f) => !f.archivedAt && (f.agreementStatus === "out_for_signature" || f.agreementStatus === "awaiting_countersign"));
  const found = new Map<string, EnvelopeListItem>();
  if (waiting.length === 0) return new Map();

  for (const envelope of await listEnvelopes(actor, { status: [...OPEN], limit: 200 })) {
    if (!found.has(envelope.fileId)) found.set(envelope.fileId, envelope);
  }
  const missing = waiting.filter((f) => !found.has(f.id));
  const extra = await Promise.all(missing.map((f) => listEnvelopes(actor, { fileId: f.id, status: [...OPEN], limit: 1 })));
  for (const list of extra) if (list[0]) found.set(list[0].fileId, list[0]);

  const out = new Map<string, Waiting>();
  for (const file of waiting) {
    const envelope = found.get(file.id);
    if (!envelope) continue;
    const client = envelope.signers.find((s) => s.role === "client");
    const company = envelope.signers.find((s) => s.role === "company");
    const withCompany = envelope.status === "client_signed";
    out.set(file.id, {
      // Waiting on us starts when the client signed; waiting on the client starts when the request went out.
      since: (withCompany ? client?.signedAt : null) ?? envelope.sentAt ?? envelope.createdAt,
      needsViewer: withCompany && Boolean(company) && company?.status !== "signed" && mayCountersign(envelope),
    });
  }
  return out;
}

function Stat({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("bg-paper px-4 py-3", className)}>
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className="mt-0.5 min-w-0">{children}</dd>
    </div>
  );
}

const statNumber = "font-serif text-2xl leading-tight font-semibold tabular";

function Tab({ href, current, count, children }: { href: string; current: boolean; count: number; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "-mb-px flex items-baseline gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap",
        current ? "border-ink font-semibold text-ink" : "border-transparent text-ink-soft hover:border-rule hover:text-ink",
      )}
    >
      {children}
      <span className={cx("tabular text-xs", current ? "text-ink-soft" : "text-ink-faint")}>{count}</span>
    </Link>
  );
}

export default async function FilesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const { viewer, actor } = await requireActor();
  const archived = first(params.view) === "archived";
  const status = !archived && isStatusFilter(first(params.status)) ? (first(params.status) as AgreementStatus) : null;
  const q = first(params.q).trim().slice(0, 120);
  const page = Number.parseInt(first(params.page), 10) || 1;

  const [list, counts, stats, outlook] = await Promise.all([
    listFiles(actor, { q, status: status ?? undefined, archived, page }),
    fileCounts(actor),
    dashboardStats(actor),
    getSendingOutlook(actor, viewer.org),
  ]);

  const settings = resolveSettings(viewer.org);
  const waiting = await loadWaiting(actor, list.files, (envelope) => {
    // Mirrors who the service lets countersign; the file page asks the service itself before offering the button.
    const company = envelope.signers.find((s) => s.role === "company");
    return canManage(viewer.user) || settings.countersignerUserId === viewer.user.id || company?.email === viewer.user.email;
  });

  const timeZone = orgTimeZone(viewer.org) ?? "UTC";
  const now = new Date();
  const manager = canManage(viewer.user);
  const noFilesAtAll = counts.all === 0 && counts.archived === 0;
  const view = { status, q, archived };

  return (
    <>
      <PageHeader
        title="Files"
        description="One file for each client job. A file is cleared to start once its agreement is signed."
        actions={
          <>
            <ButtonLink href="/files/import" variant="secondary">
              Import from a spreadsheet
            </ButtonLink>
            <ButtonLink href="/files/new">New file</ButtonLink>
          </>
        }
      />

      {outlook.blocked ? (
        <Notice tone="info" title={outlook.needsAgreement ? "Set up your agreement before sending" : "Your agreement cannot be sent yet"} className="mb-6">
          <p>
            {outlook.blocked}{" "}
            {manager ? (
              outlook.needsAgreement ? (
                <>
                  <Link href="/agreements/new">Upload your agreement</Link> and activate it. You can create files in the meantime; nothing is sent until then.
                </>
              ) : (
                <>
                  Fix it under <Link href="/agreements">Agreements</Link>. You can create files in the meantime; nothing is sent until then.
                </>
              )
            ) : (
              "Ask an owner or admin of your company to set it up. You can create files in the meantime; nothing is sent until then."
            )}
          </p>
        </Notice>
      ) : null}

      {noFilesAtAll ? null : <Summary counts={counts} stats={stats} now={now} timeZone={timeZone} />}

      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <nav aria-label="Filter files by agreement status" className="-mx-4 flex max-w-[100vw] overflow-x-auto border-b border-rule px-4 sm:mx-0 sm:max-w-full sm:px-0">
          <Tab href={filesHref({ q })} current={!archived && !status} count={counts.all}>
            All
          </Tab>
          {STATUS_FILTERS.map((s) => (
            <Tab key={s} href={filesHref({ q, status: s })} current={status === s} count={counts[s]}>
              {STATUS_LABEL[s]}
            </Tab>
          ))}
          <Tab href={filesHref({ q, archived: true })} current={archived} count={counts.archived}>
            Archived
          </Tab>
        </nav>
        <SearchBox q={q} status={status} archived={archived} />
      </div>

      {list.total === 0 ? (
        noFilesAtAll ? (
          <EmptyState
            title="No files yet"
            action={
              <>
                <ButtonLink href="/files/new">Create your first file</ButtonLink>
                <ButtonLink href="/files/import" variant="secondary">
                  Import a client list
                </ButtonLink>
              </>
            }
          >
            <p>
              Create a file for each client job. {outlook.blocked ? "Once your agreement is set up, creating a file sends it to the client for signature." : "Creating a file sends your agreement to the client for signature."}
            </p>
          </EmptyState>
        ) : (
          <EmptyState
            title={q ? `No files match "${q}"` : archived ? "No archived files" : "No files with this status"}
            action={
              q || status || archived ? (
                <ButtonLink href="/files" variant="secondary">
                  Show all files
                </ButtonLink>
              ) : (
                <ButtonLink href="/files/new">New file</ButtonLink>
              )
            }
          >
            <p>
              {q
                ? `Nothing ${archived ? "in the archive" : status ? `marked "${STATUS_LABEL[status]}"` : "in your files"} has that in the client name, email, company or reference. Check the spelling, or look in ${archived ? "your current files" : "the other tabs"}.`
                : archived
                  ? "Files you archive leave your working list and are kept here."
                  : `No current file is "${STATUS_LABEL[status ?? "no_agreement"]}" right now.`}
            </p>
          </EmptyState>
        )
      ) : (
        <>
          <FileTable files={list.files} waiting={waiting} now={now} timeZone={timeZone} archived={archived} />
          <FileList files={list.files} waiting={waiting} now={now} timeZone={timeZone} archived={archived} />
          <Pagination view={view} page={list.page} pageCount={list.pageCount} total={list.total} pageSize={list.pageSize} shown={list.files.length} />
        </>
      )}
    </>
  );
}

function Summary({ counts, stats, now, timeZone }: { counts: FileCounts; stats: Awaited<ReturnType<typeof dashboardStats>>; now: Date; timeZone: string }) {
  const oldest = stats.oldestOutstanding;
  return (
    <section aria-label="Where things stand" className="mb-6 overflow-hidden rounded-lg border border-rule bg-rule-soft">
      <dl className="grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Waiting on clients">
          <Link href={filesHref({ status: "out_for_signature" })} className={cx(statNumber, "hover:underline")}>
            {counts.out_for_signature}
          </Link>
        </Stat>
        <Stat label="Waiting on us">
          <Link href={filesHref({ status: "awaiting_countersign" })} className={cx(statNumber, "hover:underline")}>
            {counts.awaiting_countersign}
          </Link>
        </Stat>
        <Stat label="Signed this month">
          <span className={statNumber}>{stats.signedThisMonth}</span>
        </Stat>
        <Stat label="Typical time to sign">
          {stats.medianSecondsToSign === null ? (
            <span className="text-sm text-ink-soft">Shown after your first signed agreement</span>
          ) : (
            <span className={statNumber}>{durationLabel(stats.medianSecondsToSign)}</span>
          )}
        </Stat>
        <Stat label="Oldest outstanding" className="col-span-2 lg:col-span-1">
          {oldest ? (
            <Link href={`/files/${oldest.fileId}`} className="group block min-w-0">
              <span className={statNumber}>{waitLabel(oldest.sentAt, now)}</span>
              <span className="block truncate text-[13px] text-ink-soft group-hover:underline" title={`${oldest.clientName}, ${oldest.reference}, out since ${formatDate(oldest.sentAt, { timeZone })}`}>
                {oldest.clientName}, {oldest.reference}
              </span>
            </Link>
          ) : (
            <span className="text-sm text-ink-soft">Nothing is out for signature</span>
          )}
        </Stat>
      </dl>
    </section>
  );
}

interface RowsProps {
  files: FileRow[];
  waiting: Map<string, Waiting>;
  now: Date;
  timeZone: string;
  archived: boolean;
}

function waitingText(file: FileRow, waiting: Map<string, Waiting>, now: Date): string | null {
  const w = waiting.get(file.id);
  return w ? waitLabel(w.since, now) : null;
}

/** The table people scan on a desk-sized screen. */
function FileTable({ files, waiting, now, timeZone, archived }: RowsProps) {
  const th = "px-3 py-2 text-left text-[13px] font-semibold text-ink-soft";
  return (
    <div className="hidden overflow-hidden rounded-lg border border-rule bg-paper md:block">
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Files, newest first</caption>
        <thead className="border-b border-rule bg-desk/60">
          <tr>
            <th scope="col" className={cx(th, "w-[15%] pl-4")}>
              Reference
            </th>
            <th scope="col" className={cx(th, "w-[27%]")}>
              Client
            </th>
            <th scope="col" className={cx(th, "w-[18%]")}>
              Company
            </th>
            <th scope="col" className={cx(th, "w-[19%]")}>
              Agreement
            </th>
            <th scope="col" className={cx(th, "w-[10%]")}>
              Waiting
            </th>
            <th scope="col" className={cx(th, "w-[11%] pr-4")}>
              {archived ? "Archived" : "Created"}
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => {
            const w = waiting.get(file.id);
            const td = "px-3 py-2 align-top";
            return (
              <tr key={file.id} className={cx("border-b border-rule-soft last:border-b-0 hover:bg-desk/50", w?.needsViewer && "bg-flag-soft/60 hover:bg-flag-soft")}>
                <td className={cx(td, "pl-4", w?.needsViewer && "shadow-[inset_3px_0_0_var(--color-flag)]")}>
                  <Link href={`/files/${file.id}`} className="tabular block truncate font-semibold text-ink hover:underline" title={file.reference}>
                    {file.reference}
                  </Link>
                </td>
                <td className={td}>
                  <Link href={`/files/${file.id}`} className="block truncate text-ink hover:underline" title={file.clientName}>
                    {file.clientName}
                  </Link>
                  <span className="block truncate text-[13px] text-ink-soft" title={file.clientEmail}>
                    {file.clientEmail}
                  </span>
                </td>
                <td className={cx(td, "text-ink-soft")}>
                  <span className="block truncate" title={file.clientCompany ?? undefined}>
                    {file.clientCompany ?? ""}
                  </span>
                </td>
                <td className={td}>
                  <StatusBadge status={file.agreementStatus} />
                  {w?.needsViewer ? <span className="mt-1 block text-[13px] font-semibold text-flag-ink">Your signature is needed</span> : null}
                </td>
                <td className={cx(td, "tabular text-ink-soft")} title={w ? `Since ${formatDate(w.since, { time: true, timeZone })}` : undefined}>
                  {waitingText(file, waiting, now) ?? ""}
                </td>
                <td className={cx(td, "tabular pr-4 whitespace-nowrap text-ink-soft")} title={formatDate(archived ? file.archivedAt : file.createdAt, { time: true, timeZone })}>
                  {shortDate((archived ? file.archivedAt : null) ?? file.createdAt, now, timeZone)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The same rows as a list, for screens too narrow for six columns. */
function FileList({ files, waiting, now, timeZone, archived }: RowsProps) {
  return (
    <ul className="overflow-hidden rounded-lg border border-rule bg-paper md:hidden">
      {files.map((file) => {
        const w = waiting.get(file.id);
        const wait = waitingText(file, waiting, now);
        return (
          <li key={file.id} className={cx("border-b border-rule-soft last:border-b-0", w?.needsViewer && "bg-flag-soft/60 shadow-[inset_3px_0_0_var(--color-flag)]")}>
            <Link href={`/files/${file.id}`} className="block px-4 py-3 active:bg-desk">
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 truncate font-semibold text-ink">{file.clientName}</span>
                <StatusBadge status={file.agreementStatus} className="shrink-0" />
              </span>
              <span className="mt-0.5 block truncate text-[13px] text-ink-soft">
                <span className="tabular">{file.reference}</span>
                {file.clientCompany ? `, ${file.clientCompany}` : ""}
              </span>
              <span className="mt-0.5 block text-[13px] text-ink-soft">
                {w?.needsViewer ? <span className="font-semibold text-flag-ink">Your signature is needed. </span> : null}
                {wait ? `Waiting ${wait}. ` : ""}
                {archived && file.archivedAt ? `Archived ${shortDate(file.archivedAt, now, timeZone)}` : `Created ${shortDate(file.createdAt, now, timeZone)}`}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Pagination({
  view,
  page,
  pageCount,
  total,
  pageSize,
  shown,
}: {
  view: { status: string | null; q: string; archived: boolean };
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  shown: number;
}) {
  const from = (page - 1) * pageSize + 1;
  const to = from + shown - 1;
  const link = "rounded-md border border-rule bg-paper px-3 py-1.5 text-sm font-semibold text-ink hover:border-ink-faint hover:bg-desk";
  const off = "rounded-md border border-rule-soft px-3 py-1.5 text-sm font-semibold text-ink-faint";
  return (
    <nav aria-label="Pages of files" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-soft">
      <p className="tabular">
        {total === 1 ? "1 file" : pageCount === 1 ? `${total} files` : `${from} to ${to} of ${total} files`}
      </p>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={filesHref({ ...view, page: page - 1 })} className={link} rel="prev">
              Previous
            </Link>
          ) : (
            <span className={off} aria-disabled="true">
              Previous
            </span>
          )}
          <span className="tabular px-1">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={filesHref({ ...view, page: page + 1 })} className={link} rel="next">
              Next
            </Link>
          ) : (
            <span className={off} aria-disabled="true">
              Next
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
