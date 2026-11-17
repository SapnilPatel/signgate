import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui";
import { StatusScreen } from "@/components/site/chrome";

export const metadata: Metadata = { title: "Page not found" };

/*
 * Reached by a mistyped address and by notFound() anywhere in the app, signed in
 * or not. It does not read the session (a 404 should never depend on the database
 * being up), so it offers both ways back and lets the destination sort out who you are:
 * /files sends a signed-out visitor to sign-in.
 */
export default function NotFound() {
  return (
    <StatusScreen
      title="We could not find that page"
      actions={
        <>
          <ButtonLink href="/files">Go to your files</ButtonLink>
          <ButtonLink href="/" variant="secondary">
            Home page
          </ButtonLink>
        </>
      }
    >
      <p>The address may be mistyped, or the file or agreement may have been removed or belong to a different company account.</p>
      <p>
        If you followed a link from a signing email, open the most recent email you received and use the link in that one. Older links
        stop working when a new one is sent.
      </p>
    </StatusScreen>
  );
}
