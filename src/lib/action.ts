import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AuthError } from "@/lib/auth/session";
import { ServiceError } from "@/lib/services/context";

/** What every server action returns to its form. */
export type ActionState<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; fields?: Record<string, string>; code?: string }
  | null;

/**
 * Runs a server action body and converts failures into something a form can show.
 * Expected failures (ServiceError, AuthError) keep their message; anything else is
 * a bug, so it is logged and reported generically without leaking internals.
 */
export async function runAction<T>(fn: () => Promise<{ message?: string; data?: T } | void>): Promise<ActionState<T>> {
  try {
    const result = await fn();
    return { ok: true, message: result?.message, data: result?.data };
  } catch (err) {
    // redirect() and notFound() work by throwing; let the framework handle them.
    if (isRedirectError(err)) throw err;
    if (err instanceof Error && "digest" in err && String(err.digest).startsWith("NEXT_")) throw err;
    if (err instanceof ServiceError) return { ok: false, error: err.message, fields: err.fields, code: err.code };
    if (err instanceof AuthError) return { ok: false, error: err.message, code: "auth" };
    console.error("action failed", err);
    return { ok: false, error: "Something went wrong on our side. Try again; if it keeps happening, contact support." };
  }
}

/** Reads a form field as a trimmed string ("" when absent or a file). */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
