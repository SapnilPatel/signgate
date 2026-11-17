"use server";

import { runAction, type ActionState } from "@/lib/action";
import { assertActor, getRequestMeta } from "@/lib/request";
import type { ImportRow } from "@/lib/services/csv";
import { importFiles, type ImportRowResult } from "@/lib/services/files";

/**
 * Imports one batch of rows. The page sends a large spreadsheet as several small
 * batches so each request stays well inside the platform's body size and time
 * limits; the service still checks every value and reports on every row.
 */
export async function importBatchAction(rows: ImportRow[], send: boolean): Promise<ActionState<ImportRowResult[]>> {
  return runAction(async () => {
    const { actor } = await assertActor();
    const results = await importFiles(
      actor,
      rows,
      // Shorter than the service defaults: a batch is small, and a row the budget does not
      // reach comes back as "not_processed" for the page to offer again.
      { send: send === true, budgetMs: 30_000, sendBudgetMs: 25_000 },
      await getRequestMeta(),
    );
    return { data: results };
  });
}
