import { ButtonLink } from "@/components/ui";

/*
 * Shown for a file address that does not exist or belongs to another company; the two look
 * the same on purpose. It sits inside the signed-in layout, which already provides the
 * page's main landmark, so it adds none of its own.
 */
export default function FileNotFound() {
  return (
    <div className="mx-auto w-full max-w-[520px] rounded-lg border border-rule bg-paper p-6 shadow-sheet sm:p-8">
      <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink">File not found</h1>
      <div className="mt-3 space-y-3 text-ink-soft">
        <p>The address may be mistyped, or the file may have been removed or belong to a different company account.</p>
        <p>Open your list of files to find the one you were looking for.</p>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <ButtonLink href="/files">Back to files</ButtonLink>
      </div>
    </div>
  );
}
