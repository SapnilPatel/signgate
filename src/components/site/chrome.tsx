/**
 * Header, footer and marks shared by the public pages (landing, security, legal)
 * and the not-found and error screens. Server-component safe.
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { ButtonLink, cx } from "@/components/ui";

// Hard-coded rather than imported from @/lib/env so the error boundaries, which
// are client components, can use these marks without pulling server config along.
const NAME = "Signgate";

/** The same notched tab as the `.flag` status badge, at any size. Decorative unless given children. */
export function Flag({
  children,
  className,
  notch = 10,
  decorative,
  style,
}: {
  children?: ReactNode;
  className?: string;
  /** Depth of the notch in pixels. */
  notch?: number;
  /** Hide a flag that has text from assistive technology when the text only repeats what is next to it. */
  decorative?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden={decorative || !children ? true : undefined}
      className={cx("inline-block bg-flag font-semibold whitespace-nowrap text-flag-ink", className)}
      style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${notch}px 50%)`, ...style }}
    >
      {children}
    </span>
  );
}

export function Wordmark({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-2 font-serif text-xl font-semibold text-ink", className)}>
      <Flag className="h-[14px] w-[22px]" notch={6} />
      {NAME}
    </Link>
  );
}

const quietLink = "rounded-sm px-2 py-1.5 text-sm text-ink-soft hover:text-ink";

export function SiteHeader({ landing = false }: { landing?: boolean }) {
  // On the landing page the section links are same-page anchors; elsewhere they lead back to it.
  const base = landing ? "" : "/";
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-6">
        <Wordmark />
        <nav aria-label="Site" className="order-3 -mx-2 flex w-full gap-1 overflow-x-auto px-1 py-1 sm:order-none sm:mx-0 sm:ml-4 sm:w-auto">
          <a href={`${base}#how-it-works`} className={quietLink}>
            How it works
          </a>
          <a href={`${base}#questions`} className={quietLink}>
            Questions
          </a>
          <Link href="/security" className={quietLink}>
            Security
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/login" className={quietLink}>
            Sign in
          </Link>
          <ButtonLink href="/signup" size="sm">
            Create an account
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const link = "text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink-faint";
  return (
    <footer className="mt-auto border-t border-rule bg-paper">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-ink-soft">
          <span className="font-serif text-base font-semibold text-ink">{NAME}</span>
          <span className="ml-2">Your client agreement, signed on every file.</span>
        </p>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link href="/security" className={link}>
                Security
              </Link>
            </li>
            <li>
              <Link href="/legal/esign-disclosure" className={link}>
                Electronic signature disclosure
              </Link>
            </li>
            <li>
              <Link href="/legal/terms" className={link}>
                Terms
              </Link>
            </li>
            <li>
              <Link href="/legal/privacy" className={link}>
                Privacy
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}

/**
 * The frame for not-found and error screens: wordmark, one sheet, the way back.
 * Kept free of data fetching so it still renders when the thing that failed was the data.
 */
export function StatusScreen({
  title,
  children,
  actions,
  reference,
  bare = false,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Shown so support can find the matching log line. Never the error message itself. */
  reference?: string;
  /** Inside the signed-in layout the header is already there. */
  bare?: boolean;
}) {
  return (
    <main className={cx("flex flex-1 flex-col items-center px-4", bare ? "py-6" : "py-10 sm:py-16")}>
      {bare ? null : <Wordmark className="text-2xl" />}
      <div className={cx("w-full max-w-[520px] rounded-lg border border-rule bg-paper p-6 shadow-sheet sm:p-8", !bare && "mt-8")}>
        <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink">{title}</h1>
        <div className="mt-3 space-y-3 text-ink-soft">{children}</div>
        <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
        {reference ? (
          <p className="mt-6 border-t border-rule-soft pt-4 text-[13px] text-ink-faint">
            If you contact support, quote this reference: <span className="font-mono break-all text-ink-soft select-all">{reference}</span>
          </p>
        ) : null}
      </div>
    </main>
  );
}
