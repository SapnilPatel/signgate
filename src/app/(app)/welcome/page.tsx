import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/session";
import { ButtonLink, PageHeader, Sheet, cx } from "@/components/ui";
import { ResendVerificationButton } from "./resend-button";
import { getSetup } from "./setup";

export const metadata: Metadata = { title: "Getting started" };

export default async function WelcomePage() {
  const viewer = await requireViewer();
  const setup = await getSetup();
  // Nothing left to do: the checklist gets out of the way.
  if (setup.complete) redirect("/files");
  const next = setup.steps.find((s) => !s.done);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Welcome to Signgate, ${viewer.user.name.split(" ")[0]}`}
        description={`A few steps and every new file at ${viewer.org.name} gets its agreement signed without anyone chasing it. This list ticks itself off as you go.`}
      />
      <Sheet>
        <p
          className="border-b border-rule-soft px-5 py-3 text-sm text-ink-soft sm:px-6"
          aria-live="polite"
        >
          <span className="tabular font-semibold text-ink">
            {setup.doneCount} of {setup.steps.length}
          </span>{" "}
          done
        </p>
        <ol className="divide-y divide-rule-soft">
          {setup.steps.map((step, index) => {
            const isNext = step === next;
            return (
              <li key={step.key} className="flex gap-4 px-5 py-4 sm:px-6">
                <span
                  aria-hidden="true"
                  className={cx(
                    "tabular mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    step.done
                      ? "bg-signed-soft text-signed"
                      : isNext
                        ? "bg-ink text-white"
                        : "border border-rule text-ink-soft",
                  )}
                >
                  {step.done ? "✓" : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2
                    className={cx(
                      "text-base font-semibold",
                      step.done ? "text-ink-soft" : "text-ink",
                    )}
                  >
                    {step.title}
                    <span className="sr-only">
                      {step.done ? " (done)" : " (still to do)"}
                    </span>
                  </h2>
                  {step.done ? null : (
                    <p className="mt-0.5 max-w-[60ch] text-sm text-ink-soft">
                      {step.detail}
                    </p>
                  )}
                  {step.done || !step.href || !step.action ? null : (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <ButtonLink
                        href={step.href}
                        variant={isNext ? "primary" : "secondary"}
                        size={isNext ? "md" : "sm"}
                      >
                        {step.action}
                      </ButtonLink>
                      {step.key === "email" && !setup.email.viewerVerified ? (
                        <ResendVerificationButton
                          email={viewer.user.email}
                          compact={!isNext}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </Sheet>
      <p className="mt-4 text-sm text-ink-soft">
        You can leave this page at any time. Until everything is done,
        &ldquo;Finish setting up&rdquo; at the top of every page brings you
        back.
      </p>
    </div>
  );
}
