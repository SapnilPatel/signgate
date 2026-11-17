import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/site/chrome";

/** Public documentation. No session is read here, so it renders for anyone. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
