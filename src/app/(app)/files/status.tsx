import { StatusBadge, cx, type AgreementStatus } from "@/components/ui";

/**
 * The file's status badge. A file whose only request was voided is stored as "no agreement",
 * which would read "Not sent" straight after the sender voided something they did send; that
 * one case says "Voided" instead. Every other status keeps the shared vocabulary.
 */
export function FileStatusBadge({ status, voided, className }: { status: AgreementStatus; voided?: boolean; className?: string }) {
  if (voided && status === "no_agreement") {
    return <span className={cx("inline-block rounded-sm bg-rule-soft px-2 py-0.5 text-xs font-semibold leading-[18px] whitespace-nowrap text-ink-soft", className)}>Voided</span>;
  }
  return <StatusBadge status={status} className={className} />;
}
