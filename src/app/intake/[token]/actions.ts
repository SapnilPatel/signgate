"use server";

import { redirect } from "next/navigation";
import { field, runAction, type ActionState } from "@/lib/action";
import { getRequestMeta } from "@/lib/request";
import { ServiceError, type RequestMeta } from "@/lib/services/context";

/**
 * The service function this page is built against. It resolves the intake token to
 * its agreement and company, applies the public rate limit, creates the file with
 * source "intake", sends that agreement and returns the client's own signing link.
 */
type CreateIntakeFile = (
  token: unknown,
  input: { clientName: unknown; clientEmail: unknown; clientCompany?: unknown; clientPhone?: unknown },
  meta?: RequestMeta,
) => Promise<{ signingUrl?: string | null; agreement?: { signingUrl?: string | null } | null }>;

/** Only the path of the signing link is used, so the visitor stays on the site they are already on. */
function signingPath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const path = new URL(url, "http://local.invalid").pathname;
    return /^\/sign\/[A-Za-z0-9._~-]+$/.test(path) ? path : null;
  } catch {
    return null;
  }
}

export async function startIntakeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    // A field people cannot see. Software that fills in every field gives itself away.
    if (field(form, "contact_preference_note")) {
      throw new ServiceError("invalid", "This form could not be sent. Reload the page and try again.");
    }
    // Looked up by name so this page does not break the build before the function exists.
    const services = (await import("@/lib/services/files")) as unknown as { createIntakeFile?: CreateIntakeFile };
    if (typeof services.createIntakeFile !== "function") {
      throw new ServiceError("not_ready", "This form is not accepting requests at the moment. Contact the company directly and they will send you the agreement.");
    }
    const result = await services.createIntakeFile(
      field(form, "token"),
      {
        clientName: field(form, "clientName"),
        clientEmail: field(form, "clientEmail"),
        clientCompany: field(form, "clientCompany"),
        clientPhone: field(form, "clientPhone"),
      },
      await getRequestMeta(),
    );
    const path = signingPath(result?.signingUrl ?? result?.agreement?.signingUrl);
    if (!path) {
      // The file exists but there is no link to hand over here; the email carries it.
      return { message: "Thank you. Your details were received, and the agreement is on its way to your email address. Open the link in that email to sign." };
    }
    redirect(path);
  });
}
