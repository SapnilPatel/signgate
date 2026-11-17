"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Top navigation item; marks itself current for its section and anything beneath it.
 * `quiet` is for the account link, which sits apart from the three sections and
 * shows it is current with an underline instead of a filled tab.
 */
export function NavLink({ href, children, quiet = false, title }: { href: string; children: ReactNode; quiet?: boolean; title?: string }) {
  const pathname = usePathname();
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      title={title}
      aria-current={current ? "page" : undefined}
      className={
        quiet
          ? "min-w-0 hover:text-ink " + (current ? "font-semibold text-ink underline decoration-2 underline-offset-4" : "text-ink-soft")
          : "rounded-md px-3 py-1.5 text-sm font-semibold whitespace-nowrap " +
            (current ? "bg-ink text-white" : "text-ink-soft hover:bg-rule-soft hover:text-ink")
      }
    >
      {children}
    </Link>
  );
}

/** The compact way back to the checklist. Hidden on the checklist itself. */
export function SetupPrompt({ done, total }: { done: number; total: number }) {
  const pathname = usePathname();
  if (pathname === "/welcome") return null;
  return (
    <Link
      href="/welcome"
      className="rounded-md border border-rule px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap text-ink hover:border-ink-faint hover:bg-desk"
    >
      Finish setting up
      <span className="tabular ml-1.5 font-normal text-ink-soft">
        {done} of {total}
      </span>
    </Link>
  );
}
