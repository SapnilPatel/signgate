import { SiteFooter, SiteHeader } from "@/components/site/chrome";

/** Public reading pages: security and legal. No session is read here, so they render for anyone, signed in or not. */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
