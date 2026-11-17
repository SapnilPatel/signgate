"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Input } from "@/components/ui";
import { filesHref } from "./format";

/**
 * Search that lives in the address bar: typing updates `?q=` after a short pause,
 * so a search can be bookmarked, shared and survives a refresh. Without JavaScript
 * it is an ordinary form that submits on Enter.
 */
export function SearchBox({ q, status, archived }: { q: string; status: string | null; archived: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(q);
  const [pending, startTransition] = useTransition();
  // `sent` is the search this box last asked for; `seen` is the address as last rendered.
  const [sent, setSent] = useState(q);
  const [seen, setSeen] = useState(q);

  // Back and forward change the address without remounting this box. Our own search
  // arriving back as a prop is not a reason to overwrite what is being typed.
  if (q !== seen) {
    setSeen(q);
    // While a search of ours is still loading, an older one landing must not undo newer typing.
    if (q !== sent && !pending) {
      setSent(q);
      setValue(q);
    }
  }

  useEffect(() => {
    const next = value.trim();
    if (next === sent) return;
    const timer = setTimeout(() => {
      setSent(next);
      // A new search starts on its first page; replace keeps Back from stepping through every keystroke.
      startTransition(() => router.replace(filesHref({ status, archived, q: next }), { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [value, sent, status, archived, router]);

  return (
    <form action="/files" method="get" role="search" className="relative w-full sm:w-80">
      {archived ? <input type="hidden" name="view" value="archived" /> : status ? <input type="hidden" name="status" value={status} /> : null}
      <label htmlFor="file-search" className="sr-only">
        Search files by client, email, company or reference
      </label>
      <Input
        id="file-search"
        name="q"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search by client, company or reference"
        autoComplete="off"
        maxLength={120}
        className="h-9"
      />
      <span role="status" className="sr-only">
        {pending ? "Searching" : ""}
      </span>
      {pending ? <span aria-hidden className="absolute top-1/2 right-9 h-1.5 w-1.5 -translate-y-1/2 animate-pulse rounded-full bg-ink-faint" /> : null}
    </form>
  );
}
