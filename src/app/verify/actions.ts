"use server";

import { getRequestMeta } from "@/lib/request";
import { ServiceError } from "@/lib/services/context";
import { verifyDocument, type VerifyResult } from "@/lib/services/signing";

export type VerifyOutcome = { ok: true; result: VerifyResult } | { ok: false; error: string };

/** Looks up a fingerprint the browser computed. The document itself never reaches the server. */
export async function verifyFingerprintAction(sha256: string): Promise<VerifyOutcome> {
  try {
    return { ok: true, result: await verifyDocument({ sha256 }, await getRequestMeta()) };
  } catch (err) {
    if (err instanceof ServiceError) return { ok: false, error: err.message };
    console.error("verify failed", err);
    return { ok: false, error: "The check could not be completed on our side. Try again in a moment." };
  }
}
