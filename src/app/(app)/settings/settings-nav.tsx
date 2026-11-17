"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/settings/company", label: "Company" },
  { href: "/settings/branding", label: "Branding" },
  { href: "/settings/signing", label: "Signing" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/developers", label: "Developers" },
  { href: "/settings/email", label: "Email status" },
] as const;

/** Section list: a column beside the content on wide screens, one scrolling row on a phone. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
      <ul className="flex gap-1 border-b border-rule md:flex-col md:gap-0.5 md:border-b-0">
        {SECTIONS.map((section) => {
          const current = pathname === section.href || pathname.startsWith(`${section.href}/`);
          return (
            <li key={section.href} className="shrink-0">
              <Link
                href={section.href}
                aria-current={current ? "page" : undefined}
                className={
                  "block px-3 py-2 text-sm whitespace-nowrap md:rounded-md md:border-l-2 md:py-1.5 " +
                  // The current section is marked with ink weight and a rule, not a colour: colour is kept for status.
                  (current
                    ? "-mb-px border-b-2 border-ink font-semibold text-ink md:mb-0 md:border-b-0 md:border-l-ink md:bg-paper"
                    : "border-b-2 border-transparent text-ink-soft hover:text-ink md:border-b-0 md:border-l-transparent md:hover:bg-rule-soft")
                }
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
