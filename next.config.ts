import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page here is per-tenant and authenticated or token-gated, so nothing is
  // statically cacheable; classic request-time rendering keeps that explicit.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "pdfjs-dist", "unpdf", "mammoth"],
  // Read from disk at runtime: SQL migrations (local PGlite) and the fonts embedded into PDFs.
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*", "./assets/fonts/*"] },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Signing links carry a secret in the path: never leak it in a Referer, never index it.
        source: "/sign/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
