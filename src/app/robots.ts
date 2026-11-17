import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/*
 * Only the public pages are worth indexing. Everything else is per-company or
 * reached through a secret link: signing and intake pages, the API, the signed-in
 * product, and the one-time links for invitations, password resets and email checks.
 * Signing pages also send noindex headers (next.config.ts); this is the second lock.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/sign/",
        "/intake/",
        "/api/",
        "/files",
        "/agreements",
        "/settings",
        "/account",
        "/invite/",
        "/reset-password/",
        "/verify-email/",
      ],
    },
    host: env.appUrl,
  };
}
