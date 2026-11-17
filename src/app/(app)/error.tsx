"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui";
import { StatusScreen } from "@/components/site/chrome";

function digestOf(error: unknown): string | undefined {
  if (error instanceof Error && "digest" in error && typeof error.digest === "string") return error.digest.slice(0, 80);
  return undefined;
}

/**
 * Catches errors on signed-in pages. It renders inside the signed-in layout, so the
 * navigation is still there and the person can move to another part of the product.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusScreen
      bare
      title="This page could not be loaded"
      reference={digestOf(error)}
      actions={
        <>
          <Button onClick={() => retry()}>Try again</Button>
          <ButtonLink href="/files" variant="secondary">
            Back to files
          </ButtonLink>
        </>
      }
    >
      <p>
        Something went wrong on our side while loading it. Your files and agreements are not affected, and anything already sent for
        signature carries on as normal.
      </p>
      <p>
        If you were in the middle of saving or sending something, check the file before doing it again, so that nothing is sent
        twice.
      </p>
    </StatusScreen>
  );
}
