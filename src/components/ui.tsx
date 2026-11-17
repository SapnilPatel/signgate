/**
 * Shared interface primitives. Server-component safe (no hooks, no handlers of
 * their own), so they can be used from both server and client components.
 * Keep every screen on these so the product reads as one thing.
 */
import Link from "next/link";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
type ButtonSize = "md" | "sm" | "lg";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap transition-colors " +
  "disabled:opacity-50 disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:pointer-events-none";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-white hover:bg-[#22355a]",
  secondary: "bg-paper text-ink border border-rule hover:border-ink-faint hover:bg-desk",
  quiet: "text-ink-soft hover:text-ink hover:bg-rule-soft",
  danger: "bg-paper text-stop border border-rule hover:border-stop hover:bg-stop-soft",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  // Large targets for the signing page on phones.
  lg: "h-12 px-6 text-base",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string): string {
  return cx(buttonBase, buttonVariants[variant], buttonSizes[size], extra);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const inputClass =
  "block w-full h-10 rounded-md border border-rule bg-paper px-3 text-sm text-ink placeholder:text-ink-faint " +
  "hover:border-ink-faint focus:border-note focus:outline-none focus:ring-2 focus:ring-note/25 " +
  "disabled:bg-desk disabled:text-ink-faint aria-[invalid=true]:border-stop";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cx(inputClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputClass, "h-auto min-h-24 py-2 leading-normal", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cx(inputClass, "pr-8", className)} {...props} />;
}

/** A labelled control with optional hint and error. Pass the control as children and give it the same id. */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // The control is told which paragraph explains it, so a screen reader that lands on
  // an invalid field reads the reason and not only "invalid".
  const noteId = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  let control = children;
  if (noteId && isValidElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" }>(children)) {
    const existing = children.props["aria-describedby"];
    control = cloneElement(children, {
      "aria-describedby": existing ? `${existing} ${noteId}` : noteId,
      ...(error ? { "aria-invalid": true } : {}),
    });
  }
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="flex items-baseline justify-between text-sm font-semibold text-ink">
        <span>{label}</span>
        {optional ? <span className="text-xs font-normal text-ink-soft">Optional</span> : null}
      </label>
      {control}
      {error ? (
        <p id={noteId} className="text-[13px] text-stop" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-[13px] text-ink-soft">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces and structure
// ---------------------------------------------------------------------------

/** A sheet of paper on the desk. The only raised surface in the product. */
export function Sheet({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("rounded-lg border border-rule bg-paper shadow-sheet", className)} {...props} />;
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6">
      {back ? (
        <Link href={back.href} className="mb-2 inline-block text-[13px] text-ink-soft hover:text-ink">
          ‹ {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="font-serif text-[28px] leading-tight font-semibold text-ink">{title}</h1>
          {description ? <p className="mt-1 max-w-[65ch] text-ink-soft">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cx("text-base font-semibold text-ink", className)}>{children}</h2>;
}

type Tone = "info" | "success" | "warning" | "error";

const toneClass: Record<Tone, string> = {
  info: "bg-note-soft border-note/30 text-ink",
  success: "bg-signed-soft border-signed/30 text-ink",
  warning: "bg-flag-soft border-flag text-ink",
  error: "bg-stop-soft border-stop/30 text-ink",
};

/** An inline message. Errors say what happened and what to do next. */
export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx("rounded-md border px-4 py-3 text-sm", toneClass[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cx(title && "mt-0.5", "text-ink-soft [&_a]:underline")}>{children}</div> : null}
    </div>
  );
}

/** Shown where a list would be. Always offers the next action. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule px-6 py-12 text-center">
      <p className="font-serif text-xl font-semibold text-ink">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-[52ch] text-ink-soft">{children}</div> : null}
      {action ? <div className="mt-5 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type AgreementStatus =
  | "no_agreement"
  | "out_for_signature"
  | "awaiting_countersign"
  | "signed"
  | "declined"
  | "needs_attention";

/** One vocabulary for agreement status across lists, file pages, the API docs and emails. */
export const STATUS_LABEL: Record<AgreementStatus, string> = {
  no_agreement: "Not sent",
  out_for_signature: "Waiting on client",
  awaiting_countersign: "Waiting on us",
  signed: "Signed",
  declined: "Declined",
  needs_attention: "Needs attention",
};

export function StatusBadge({ status, className }: { status: AgreementStatus; className?: string }) {
  if (status === "out_for_signature") {
    return <span className={cx("flag inline-block", className)}>{STATUS_LABEL[status]}</span>;
  }
  const styles: Record<Exclude<AgreementStatus, "out_for_signature">, string> = {
    no_agreement: "bg-rule-soft text-ink-soft",
    awaiting_countersign: "bg-flag-soft text-flag-ink border border-flag",
    signed: "bg-signed-soft text-signed",
    declined: "bg-stop-soft text-stop",
    needs_attention: "bg-stop-soft text-stop",
  };
  return (
    <span
      className={cx(
        "inline-block rounded-sm px-2 py-0.5 text-xs font-semibold leading-[18px] whitespace-nowrap",
        styles[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Consistent, unambiguous timestamps. Render dates on the server in UTC unless a zone is given. */
export function formatDate(date: Date | string | null | undefined, opts: { time?: boolean; timeZone?: string } = {}): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(opts.time ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } : {}),
    timeZone: opts.timeZone ?? "UTC",
  }).format(d);
}
