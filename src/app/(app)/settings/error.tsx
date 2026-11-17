"use client";

import { Button, Notice } from "@/components/ui";

export default function SettingsError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="space-y-4">
      <Notice tone="error" title="These settings could not be loaded">
        Something went wrong on our side and nothing was changed. Try again; if it keeps happening, contact support.
      </Notice>
      <Button variant="secondary" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
