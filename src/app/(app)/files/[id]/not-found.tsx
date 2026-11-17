import { ButtonLink, buttonClass } from "@/components/ui";
import { getViewer } from "@/lib/auth/session";
import { logOutAction } from "../../../(auth)/actions";

/*
 * Shown for a file address that does not exist or belongs to another company; the two look
 * the same on purpose. It sits inside the signed-in layout, which already provides the
 * page's main landmark, so it adds none of its own.
 *
 * The usual way to land here is an emailed link opened in a browser that is signed in to a
 * different company, so the page says which account is in use and offers to switch.
 */
export default async function FileNotFound() {
  const viewer = await getViewer();
  return (
    <div className="mx-auto w-full max-w-[520px] rounded-lg border border-rule bg-paper p-6 shadow-sheet sm:p-8">
      <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink">File not found</h1>
      <div className="mt-3 space-y-3 text-ink-soft">
        {viewer ? (
          <p>
            You are signed in as <strong className="text-ink">{viewer.user.email}</strong> at{" "}
            <strong className="text-ink">{viewer.org.name}</strong>, and this company has no file at this address.
          </p>
        ) : null}
        <p>
          If you followed a link from an email, the file probably belongs to a different company account. Sign out,
          sign in with that account, and open the link again.
        </p>
        <p>Otherwise the address may be mistyped, or the file may have been removed.</p>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <form action={logOutAction}>
          <button type="submit" className={buttonClass("primary")}>
            Sign out and switch account
          </button>
        </form>
        <ButtonLink href="/files" variant="secondary">
          Back to files
        </ButtonLink>
      </div>
    </div>
  );
}
