import { cx } from "@/components/ui";

const tag = "inline-block rounded-sm px-2 py-0.5 text-xs font-semibold leading-[18px] whitespace-nowrap";

/** Where an agreement stands. Deliberately quiet: yellow and green are kept for signatures. */
export function AgreementStatusTag({ status, className }: { status: "draft" | "active" | "archived"; className?: string }) {
  if (status === "active") return <span className={cx(tag, "border border-ink/30 bg-paper text-ink", className)}>In use</span>;
  if (status === "archived") return <span className={cx(tag, "bg-rule-soft text-ink-faint", className)}>Archived</span>;
  return <span className={cx(tag, "bg-rule-soft text-ink-soft", className)}>Draft</span>;
}

export function DefaultTag({ className }: { className?: string }) {
  return <span className={cx(tag, "bg-ink text-white", className)}>Default</span>;
}
