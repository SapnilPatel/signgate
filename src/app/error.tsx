"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui";
import { StatusScreen } from "@/components/site/chrome";

/** The digest is the only part of a server error that is safe to show: it matches a log line and reveals nothing. */
function digestOf(error: unknown): string | undefined {
  if (error instanceof Error && "digest" in error && typeof error.digest === "string") return error.digest.slice(0, 80);
  return undefined;
}

/** Catches anything thrown outside the signed-in area: the public pages, sign-in and the signing ceremony. */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    // For whoever opens the browser console while helping the person; the message never reaches the page.
    console.error(error);
  }, [error]);

  return (
    <StatusScreen
      title="Something went wrong on our side"
      reference={digestOf(error)}
      actions={
        <>
          <Button onClick={() => retry()}>Try again</Button>
          <ButtonLink href="/" variant="secondary">
            Home page
          </ButtonLink>
        </>
      }
    >
      <p>This page could not be shown. Nothing you entered has been sent twice, and nothing has been signed that you did not sign.</p>
      <p>Try again. If it keeps happening, wait a few minutes: the problem is usually temporary.</p>
    </StatusScreen>
  );
}
