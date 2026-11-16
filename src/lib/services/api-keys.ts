import { and, count, desc, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiKeys, orgs, type ApiKey, type Org } from "@/lib/db/schema";
import { newId, newSecret, sha256Hex } from "@/lib/ids";
import { assertActiveActor } from "./accounts";
import { ServiceError, type Actor } from "./context";
import { cleanText, recordEvent } from "./events";

export const API_KEY_PREFIX = "sg_live_";
/** Shape of a key this product issued. Checked before hashing so a multi-megabyte
 *  or binary Authorization header costs nothing. */
const KEY_SHAPE = /^sg_live_[0-9a-z]{32}$/;
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 4;
const MAX_NAME_LENGTH = 80;
/** Enough for every integration a company runs, small enough to stay reviewable. */
export const MAX_ACTIVE_API_KEYS = 25;
const LAST_USED_RESOLUTION_MS = 60_000;

/** What the UI and API may see. The hash is never returned: it is the credential's verifier. */
export type ApiKeySummary = Omit<ApiKey, "keyHash">;

function summarize(row: ApiKey): ApiKeySummary {
  const { keyHash: _keyHash, ...rest } = row;
  void _keyHash;
  return rest;
}

/** Keys grant full API access to the org, so only an owner or admin who is signed
 *  in may mint or revoke one. An API key can never create another key. */
function assertSignedIn(actor: Actor, action: string): asserts actor is Extract<Actor, { type: "user" }> {
  if (!actor || actor.type !== "user") {
    throw new ServiceError("forbidden", `Only an owner or admin can ${action}. Ask one of them to do it for you.`);
  }
}

export async function createApiKey(actor: Actor, name: string): Promise<{ key: string; row: ApiKeySummary }> {
  assertSignedIn(actor, "create API keys");
  const db = await getDb();
  // The role is read from the stored row: the one in the Actor can predate a demotion.
  await assertActiveActor(db, actor, "manage");
  const cleanName = cleanText(typeof name === "string" ? name.replace(/\s+/g, " ") : "", MAX_NAME_LENGTH + 1);
  if (!cleanName) {
    throw new ServiceError("invalid", "Give the key a name so you can tell it apart later, for example the system that will use it.", {
      name: "Enter a name.",
    });
  }
  if (cleanName.length > MAX_NAME_LENGTH) {
    throw new ServiceError("invalid", `Key names can be at most ${MAX_NAME_LENGTH} characters. Shorten the name and try again.`, {
      name: `Use ${MAX_NAME_LENGTH} characters or fewer.`,
    });
  }

  const key = API_KEY_PREFIX + newSecret();
  const row = await db.transaction(async (tx) => {
    const [{ active }] = await tx
      .select({ active: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, actor.orgId), isNull(apiKeys.revokedAt)));
    if (active >= MAX_ACTIVE_API_KEYS) {
      throw new ServiceError("conflict", `You already have ${MAX_ACTIVE_API_KEYS} active API keys. Revoke one you no longer use, then create a new one.`);
    }
    const [inserted] = await tx
      .insert(apiKeys)
      .values({
        id: newId("key"),
        orgId: actor.orgId,
        name: cleanName,
        prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
        keyHash: sha256Hex(key),
        createdBy: actor.userId,
      })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: "api_key.created", actor, data: { keyId: inserted.id, name: cleanName } });
    return inserted;
  });
  return { key, row: summarize(row) };
}

/** All of the org's keys, newest first, including revoked ones so their history stays visible. */
export async function listApiKeys(actor: Actor): Promise<ApiKeySummary[]> {
  const db = await getDb();
  await assertActiveActor(db, actor, "read");
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.orgId, actor.orgId)).orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(summarize);
}

/** Revoke a key. Revoking an already revoked key succeeds and changes nothing. */
export async function revokeApiKey(actor: Actor, id: string): Promise<ApiKeySummary> {
  assertSignedIn(actor, "revoke API keys");
  const db = await getDb();
  await assertActiveActor(db, actor, "manage");
  const notFound = () => new ServiceError("not_found", "That API key does not exist. Refresh the page to see the current list.");
  if (typeof id !== "string" || !id) throw notFound();
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, actor.orgId), isNull(apiKeys.revokedAt)))
      .returning();
    if (revoked) {
      await recordEvent(tx, { orgId: actor.orgId, type: "api_key.revoked", actor, data: { keyId: revoked.id, name: revoked.name } });
      return summarize(revoked);
    }
    const [existing] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, actor.orgId)))
      .limit(1);
    if (!existing) throw notFound();
    return summarize(existing);
  });
}

/**
 * Resolve an Authorization header to an API actor. Returns null for anything that
 * is not a live key: missing header, wrong scheme, malformed, unknown or revoked.
 * The caller answers 401 without saying which, so keys cannot be probed.
 */
export async function authenticateApiKey(authorizationHeader: string | null): Promise<{ actor: Actor; org: Org } | null> {
  if (typeof authorizationHeader !== "string" || authorizationHeader.length > 200) return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
  if (!match || !KEY_SHAPE.test(match[1])) return null;

  const db = await getDb();
  const [found] = await db
    .select({ key: apiKeys, org: orgs })
    .from(apiKeys)
    .innerJoin(orgs, eq(orgs.id, apiKeys.orgId))
    .where(and(eq(apiKeys.keyHash, sha256Hex(match[1])), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!found) return null;

  const now = new Date();
  const last = found.key.lastUsedAt;
  if (!last || now.getTime() - last.getTime() >= LAST_USED_RESOLUTION_MS) {
    try {
      // The condition is repeated in SQL so a burst of parallel requests writes once, not once each.
      await db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiKeys.id, found.key.id),
            or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS + 1))),
          ),
        );
    } catch {
      // "Last used" is a convenience for the settings page; failing to record it must not reject a valid key.
    }
  }

  return {
    actor: { type: "api", orgId: found.key.orgId, keyId: found.key.id, label: `API key "${found.key.name}"` },
    org: found.org,
  };
}
