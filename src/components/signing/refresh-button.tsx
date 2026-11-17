"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui";

/** Asks the server for this link's current state again, without a full reload. */
export function RefreshButton({ children, variant = "secondary" }: { children: ReactNode; variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      size="lg"
      className="w-full sm:w-auto"
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true);
        router.refresh();
        // The screen changes by itself when there is news; otherwise the button comes back.
        setTimeout(() => setBusy(false), 4000);
      }}
    >
      {busy ? "Checking…" : children}
    </Button>
  );
}
