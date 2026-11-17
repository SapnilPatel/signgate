import "server-only";
import { canManage, type Viewer } from "@/lib/auth/session";
import { requireActor } from "@/lib/request";
import type { Actor } from "@/lib/services/context";

/**
 * For a settings page: the signed-in manager, or null for a member. The layout
 * explains to members why they cannot see settings; pages return nothing for
 * them so no manager-only service is called on their behalf. The services
 * check again against the stored row either way.
 */
export async function settingsContext(): Promise<{ viewer: Viewer; actor: Actor } | null> {
  const ctx = await requireActor();
  return canManage(ctx.viewer.user) ? ctx : null;
}
