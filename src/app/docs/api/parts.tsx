/** Building blocks of the API reference. Server components only: the page ships no script of its own. */
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A block of code or JSON. Long lines scroll inside the block, never the page, and the
 * block is focusable so a keyboard user can scroll it too.
 */
export function Code({ children, label }: { children: string; label: string }) {
  return (
    <figure className="mt-3 min-w-0">
      <figcaption className="text-[13px] font-medium text-ink-soft">{label}</figcaption>
      <pre
        tabIndex={0}
        aria-label={label}
        className="mt-1 max-h-[440px] overflow-auto rounded-md border border-rule bg-paper px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-ink"
      >
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export function Method({ children }: { children: string }) {
  return <span className="rounded-sm border border-ink px-1.5 py-px font-mono text-[12px] font-semibold text-ink">{children}</span>;
}

export interface Param {
  name: string;
  type: string;
  required?: boolean;
  children: ReactNode;
}

/** Parameters as a definition list: it reads well at phone width, where a four-column table does not. */
export function Params({ title, items, level = 4 }: { title: string; items: Param[]; level?: 3 | 4 }) {
  // Directly under a section heading it is an h3; inside an endpoint, which has its own h3, an h4.
  const Heading = level === 3 ? "h3" : "h4";
  return (
    <div className="mt-4">
      <Heading className="text-sm font-semibold text-ink">{title}</Heading>
      <dl className="mt-1 divide-y divide-rule-soft border-y border-rule-soft">
        {items.map((p) => (
          <div key={p.name} className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
            <dt className="min-w-0 text-sm">
              <code className="font-mono text-[13px] break-words text-ink">{p.name}</code>
              <span className="ml-2 text-[13px] text-ink-faint">
                {p.type}
                {p.required ? ", required" : ""}
              </span>
            </dt>
            <dd className="min-w-0 text-sm leading-relaxed text-ink-soft">{p.children}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-6 border-t border-rule pt-8 first:border-t-0 first:pt-0">
      <h2 id={id} className="font-serif text-2xl leading-tight font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Endpoint({
  id,
  method,
  path,
  title,
  children,
}: {
  id: string;
  method: string;
  path: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <article aria-labelledby={id} className="mt-8 scroll-mt-6 rounded-lg border border-rule bg-paper/60 p-4 sm:p-5">
      <h3 id={id} className="text-base font-semibold text-ink">
        {title}
      </h3>
      <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
        <Method>{method}</Method>
        <code className="min-w-0 font-mono text-[13px] break-all text-ink">{path}</code>
      </p>
      {children}
    </article>
  );
}

/**
 * A short reference list. A table from tablet width up; on a phone each row becomes a
 * small block, because three columns of prose do not fit in 390 pixels.
 */
export function RefTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-3 rounded-md border border-rule bg-paper sm:overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm max-sm:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="max-sm:sr-only">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="border-b border-rule px-3 py-2 font-semibold text-ink">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {rows.map((row, i) => (
            <tr key={i} className="align-top max-sm:block max-sm:border-b max-sm:border-rule-soft max-sm:px-3 max-sm:py-2 max-sm:last:border-b-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={cx(
                    "text-ink-soft sm:border-b sm:border-rule-soft sm:px-3 sm:py-2 max-sm:py-0.5",
                    // Short leading cells (a status number, a code) share the first line on a phone.
                    j === 0 && "text-ink sm:whitespace-nowrap",
                    j < row.length - 1 && row.length > 2 && j > 0 && "sm:min-w-[9rem]",
                    j === 0 || (j === 1 && row.length > 2 && head[1] === "code") ? "max-sm:mr-2 max-sm:inline-block" : "max-sm:block",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const prose =
  "[&_p]:mt-3 [&_p]:leading-relaxed [&_p]:text-ink-soft [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-ink-soft [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5 [&_ol]:text-ink-soft [&_li::marker]:text-ink-faint [&_strong]:font-semibold [&_strong]:text-ink [&_a]:text-ink [&_a]:underline [&_a]:decoration-ink-faint [&_a]:underline-offset-4 hover:[&_a]:decoration-ink [&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-rule-soft [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.88em] [&_:not(pre)>code]:text-ink";
