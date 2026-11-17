import type { Metadata } from "next";
import Link from "next/link";
import { canManage } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import { resolveSettings } from "@/lib/services/accounts";
import { listTemplates, type TemplateSummary } from "@/lib/services/templates";
import { ButtonLink, EmptyState, Notice, PageHeader, cx, formatDate } from "@/components/ui";
import { AgreementStatusTag, DefaultTag } from "./status";

export const metadata: Metadata = { title: "Agreements" };

const th = "px-3 py-2.5 text-left text-[13px] font-semibold text-ink-soft";
const td = "px-3 py-3 align-top";

function needsWork(t: TemplateSummary): string | null {
  if (t.status === "archived" || t.readiness.ready) return null;
  const count = t.readiness.problems.length;
  return t.status === "active" ? `Cannot be sent: ${count === 1 ? "1 thing" : `${count} things`} to fix` : `${count === 1 ? "1 thing" : `${count} things`} to fix before use`;
}

function NameCell({ t }: { t: TemplateSummary }) {
  const problem = needsWork(t);
  return (
    <>
      <Link href={`/agreements/${t.id}`} className="font-semibold break-words text-ink underline decoration-rule underline-offset-2 hover:decoration-ink">
        {t.name}
      </Link>
      <span className="mt-0.5 block text-[13px] text-ink-soft">
        {t.pages.length} {t.pages.length === 1 ? "page" : "pages"}, {t.fields.length} {t.fields.length === 1 ? "field" : "fields"}
      </span>
      {problem ? <span className={cx("mt-0.5 block text-[13px] font-semibold", t.status === "active" ? "text-stop" : "text-ink-soft")}>{problem}</span> : null}
    </>
  );
}

function StatusCell({ t }: { t: TemplateSummary }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <AgreementStatusTag status={t.status} />
      {t.isDefault ? <DefaultTag /> : null}
    </span>
  );
}

export default async function AgreementsPage() {
  const { viewer, actor } = await requireActor();
  const manage = canManage(viewer.user);
  const templates = await listTemplates(actor);
  const settings = resolveSettings(viewer.org);
  const timeZone = settings.timeZone;

  const live = templates.filter((t) => t.status !== "archived");
  const hasDefault = templates.some((t) => t.isDefault);
  const hasActive = templates.some((t) => t.status === "active");
  const brokenDefault = templates.find((t) => t.isDefault && !t.readiness.ready);

  if (templates.length === 0) {
    return (
      <>
        <PageHeader title="Agreements" />
        <EmptyState
          title="Add your agreement once"
          action={
            manage ? (
              <ButtonLink href="/agreements/new" size="lg">
                Add your agreement
              </ButtonLink>
            ) : undefined
          }
        >
          <p>
            Upload the agreement your clients sign. From then on it goes out for signature on every new file, the client is reminded until they sign, and the signed
            copy is filed for you.
          </p>
          {!manage ? <p className="mt-3">Only an owner or admin can add the agreement. Ask one of them to add it.</p> : null}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Agreements"
        description="The agreement marked Default is the one sent on every new file."
        actions={
          manage ? (
            <ButtonLink href="/agreements/new">Add an agreement</ButtonLink>
          ) : undefined
        }
      />

      {!manage ? (
        <Notice tone="info" className="mb-4">
          You can open and read these agreements. Only an owner or admin can add or change them, because they are what every client signs.
        </Notice>
      ) : null}

      {brokenDefault ? (
        <Notice tone="error" title="Your default agreement cannot be sent right now" className="mb-4">
          <p>
            {brokenDefault.readiness.problems[0]?.message} <Link href={`/agreements/${brokenDefault.id}`}>Open “{brokenDefault.name}” to fix it.</Link>
          </p>
        </Notice>
      ) : !hasDefault && live.length > 0 ? (
        <Notice tone="warning" title="No agreement is sent on new files yet" className="mb-4">
          {hasActive
            ? "None of your agreements is the default. Open the one you want sent on every new file and choose “Make this the default”."
            : "Your agreement is still a draft. Open it, check the fields, then choose “Use this agreement”."}
        </Notice>
      ) : hasDefault && !settings.autoSendOnFileCreate ? (
        <Notice tone="info" className="mb-4">
          Sending on new files is turned off in Settings, so the default agreement goes out only when someone sends it from a file.
        </Notice>
      ) : null}

      {/* Wide screens: a table to scan. */}
      <div className="hidden overflow-hidden rounded-lg border border-rule bg-paper md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Agreements, the default first</caption>
          <thead className="border-b border-rule bg-desk/60">
            <tr>
              <th scope="col" className={cx(th, "w-[40%] pl-4")}>
                Agreement
              </th>
              <th scope="col" className={cx(th, "w-[20%]")}>
                Status
              </th>
              <th scope="col" className={cx(th, "w-[10%] text-right")}>
                Sent
              </th>
              <th scope="col" className={cx(th, "w-[10%] text-right")}>
                Signed
              </th>
              <th scope="col" className={cx(th, "w-[20%] pr-4")}>
                Last changed
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule-soft">
            {templates.map((t) => (
              <tr key={t.id} className={cx(t.status === "archived" && "bg-desk/40")}>
                <td className={cx(td, "pl-4")}>
                  <NameCell t={t} />
                </td>
                <td className={td}>
                  <StatusCell t={t} />
                </td>
                <td className={cx(td, "tabular text-right")}>{t.sentCount}</td>
                <td className={cx(td, "tabular text-right")}>{t.signedCount}</td>
                <td className={cx(td, "pr-4 text-ink-soft")}>{formatDate(t.updatedAt, { timeZone })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: the same rows as a list. */}
      <ul className="divide-y divide-rule-soft overflow-hidden rounded-lg border border-rule bg-paper md:hidden">
        {templates.map((t) => (
          <li key={t.id} className={cx("px-4 py-3", t.status === "archived" && "bg-desk/40")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <NameCell t={t} />
              </div>
              <StatusCell t={t} />
            </div>
            <p className="tabular mt-1.5 text-[13px] text-ink-soft">
              {t.sentCount} sent, {t.signedCount} signed. Changed {formatDate(t.updatedAt, { timeZone })}.
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
