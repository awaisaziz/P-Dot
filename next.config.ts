import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // The microphone is allowed for P-Dot's own pages only (chat dictation); no embedded frame can use it.
  // The browser still asks the user before the first use.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Docker image (Dockerfile) runs the standalone server. Cloudflare builds
  // with OpenNext and keeps the default output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker must be re-checked on every visit, so updates reach installed apps.
      // On Cloudflare, static files skip these rules, so public/_headers sets the same header there.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;
