/**
 * Long-form reading layout for the security and legal pages: one column at a
 * comfortable measure, serif headings, quiet rules. Server-component safe.
 */
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

export function Article({
  title,
  lead,
  updated,
  notice,
  children,
}: {
  title: string;
  lead?: ReactNode;
  /** Shown as written, e.g. "November 16, 2026". */
  updated?: string;
  /** A boxed note above the body, for "have your own counsel review this". */
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-[760px] flex-1 px-4 py-10 sm:px-6 sm:py-16">
      <header>
        <h1 className="font-serif text-[36px] leading-[1.1] font-semibold text-ink sm:text-[44px]">{title}</h1>
        {lead ? <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">{lead}</p> : null}
        {updated ? <p className="mt-3 text-sm text-ink-faint">Last updated {updated}</p> : null}
      </header>
      {notice ? (
        <div role="note" className="mt-8 rounded-md border border-rule bg-paper px-4 py-3 text-sm text-ink-soft [&_strong]:text-ink">
          {notice}
        </div>
      ) : null}
      <Prose className="mt-10">{children}</Prose>
    </main>
  );
}

export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "text-base leading-[1.65] text-ink-soft",
        "[&_h2]:mt-12 [&_h2]:mb-3 [&_h2]:border-t [&_h2]:border-rule [&_h2]:pt-8 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:leading-tight [&_h2]:font-semibold [&_h2]:text-ink",
        "[&_h2:first-child]:mt-0 [&_h2:first-child]:border-t-0 [&_h2:first-child]:pt-0",
        "[&_h3]:mt-6 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-ink",
        "[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5",
        "[&_li]:pl-1 [&_li::marker]:text-ink-faint [&_strong]:font-semibold [&_strong]:text-ink",
        "[&_a]:text-ink [&_a]:underline [&_a]:decoration-ink-faint [&_a]:underline-offset-4 hover:[&_a]:decoration-ink",
        "[&_code]:rounded-sm [&_code]:bg-rule-soft [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-ink",
        className,
      )}
    >
      {children}
    </div>
  );
}
