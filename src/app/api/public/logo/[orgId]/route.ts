import { getOrgLogo } from "@/lib/services/accounts";

/**
 * Serves a company's logo to email clients, which cannot display inline images.
 * Public by design: a logo is something the company puts on everything it sends.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
  const { orgId } = await params;
  const logo = await getOrgLogo(orgId);
  if (!logo) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(logo.bytes.length),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // Rendered only as an image, never as a document.
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
