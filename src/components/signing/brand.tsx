/**
 * The frame every client-facing page shares: the company's own name, logo and
 * colour at the top, because the client knows the company, not this product.
 * Server-component safe.
 */
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

export interface Brand {
  name: string;
  brandColor: string;
  logo: string | null;
}

const FALLBACK_COLOR = "#16233b";

/** A stored colour is only used when it is a plain six-digit hex; anything else falls back to ink. */
export function safeColor(value: string | null | undefined): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : FALLBACK_COLOR;
}

/** White or ink, whichever reads on the given background (WCAG relative luminance). */
export function readableOn(hex: string): string {
  const c = safeColor(hex);
  const channel = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? "#16233b" : "#ffffff";
}

/** Only raster and SVG data URLs are shown as a logo; in an <img> none of them can run script. */
function safeLogo(value: string | null | undefined): string | null {
  return typeof value === "string" && /^data:image\/(png|jpeg|svg\+xml)[;,]/i.test(value) ? value : null;
}

export function BrandHeader({ brand, aside }: { brand: Brand | null; aside?: ReactNode }) {
  const color = safeColor(brand?.brandColor);
  const logo = safeLogo(brand?.logo);
  return (
    <header className="border-b border-rule bg-paper">
      {/* The company's colour as a single band, the way a letterhead carries it. */}
      <div aria-hidden className="h-1.5" style={{ backgroundColor: color }} />
      <div className="mx-auto flex max-w-[920px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL stored with the company's settings
            <img src={logo} alt="" className="h-9 max-w-[140px] shrink-0 object-contain" />
          ) : null}
          <p className="min-w-0 truncate font-serif text-lg font-semibold text-ink">{brand?.name || "Signgate"}</p>
        </div>
        {aside ? <div className="shrink-0 text-[13px] text-ink-soft">{aside}</div> : null}
      </div>
    </header>
  );
}

export function PoweredBy({ className }: { className?: string }) {
  return (
    <p className={cx("text-[13px] text-ink-faint", className)}>
      Signed securely with Signgate. Every signature is recorded with its time and sealed into the final PDF.
    </p>
  );
}

/** One sheet with a title, an explanation and the next step. Used for every state that is not "sign now". */
export function StateScreen({
  brand,
  title,
  tone = "plain",
  children,
  actions,
  footer,
}: {
  brand: Brand | null;
  title: string;
  /** "signed" is the only state that gets colour: green means signed and nothing else. */
  tone?: "plain" | "signed";
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <BrandHeader brand={brand} />
      <main className="flex flex-1 flex-col items-center px-4 py-8 sm:py-14">
        <div className="w-full max-w-[560px] rounded-lg border border-rule bg-paper p-6 shadow-sheet sm:p-8">
          {tone === "signed" ? (
            <p className="mb-3 inline-block rounded-sm bg-signed-soft px-2 py-0.5 text-xs font-semibold leading-[18px] text-signed">Signed</p>
          ) : null}
          <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink">{title}</h1>
          <div className="mt-3 space-y-3 text-ink-soft [overflow-wrap:anywhere]">{children}</div>
          {actions ? <div className="mt-6 flex flex-wrap gap-2">{actions}</div> : null}
          {footer ? <div className="mt-6 border-t border-rule-soft pt-4 text-[13px] text-ink-soft">{footer}</div> : null}
        </div>
        <PoweredBy className="mt-6 max-w-[560px] text-center" />
      </main>
    </div>
  );
}
