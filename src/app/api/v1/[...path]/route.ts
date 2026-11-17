import { notFoundResponse } from "@/lib/api/http";

/*
 * Anything under /api/v1 that no route answers. Without this a mistyped path would get
 * the site's HTML "page not found", which an integration cannot parse.
 */
const handler = () => notFoundResponse();

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
