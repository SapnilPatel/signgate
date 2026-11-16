"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Top navigation item; marks itself current for its section and anything beneath it. */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        "rounded-md px-3 py-1.5 text-sm font-semibold whitespace-nowrap " +
        (current ? "bg-ink text-white" : "text-ink-soft hover:bg-rule-soft hover:text-ink")
      }
    >
      {children}
    </Link>
  );
}
