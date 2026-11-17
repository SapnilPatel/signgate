/**
 * An agreement added from a file starts out named after the file, and that name is
 * what clients read as the heading of the signing page. A file name is written for a
 * folder ("MSA_final_v3 (2)", "client-services-agreement"), so the review screen
 * offers this tidied version for the person to accept or change before the
 * agreement goes into use.
 */

/** Words people add to a file name to tell copies apart; they mean nothing to a client. */
const TRAILING_NOISE = /[\s._-]+(?:\(\d+\)|copy(?:\s*\d+)?|final|draft|new|v\d+(?:[._]\d+)*|rev(?:ision)?\s*\d+)$/i;

/**
 * The name as a person would write it: separators become spaces, copy and version
 * markers at the end go, and an all-lowercase name gets a capital first letter.
 * A name that already reads well comes back unchanged.
 */
export function readableName(name: string): string {
  // Without the extension even when nothing else is changed: "v2.pdf" is never a name for a client to read.
  const original = name.trim().replace(/\.(pdf|docx?|png|jpe?g|gif|webp|tiff?|heic|rtf|odt|txt)$/i, "") || name.trim();
  let text = original.replace(/_+/g, " ");
  // "(2)" directly after a word, as browsers write for a second download.
  text = text.replace(/\s*\(\d+\)$/, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(TRAILING_NOISE, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  // A hyphen is a separator only when what is left has no spaces of its own: "Non-disclosure agreement" keeps its hyphen.
  // Decided after the copy markers are gone, so tidying a tidied name changes nothing.
  if (!/\s/.test(text)) text = text.replace(/-+/g, " ").trim();
  // Too little left to be a name ("v2.pdf"): the original is the better guess.
  if (text.length < 3) return original;
  if (text === text.toLowerCase()) text = text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}
