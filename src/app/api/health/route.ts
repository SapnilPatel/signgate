import { checkHealth } from "@/lib/api/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health: for uptime monitors and for checking a new deployment. Public, so it
 * answers with booleans only: nothing here names a provider, an address or a secret.
 */
export async function GET(): Promise<Response> {
  const health = await checkHealth();
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
