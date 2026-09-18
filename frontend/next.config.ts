/** Build a standalone Node frontend, proxy API calls privately and apply browser security headers. */
import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  output: "standalone",
  turbopack: { root: path.resolve(process.cwd()) },
  poweredByHeader: false,
  devIndicators: false,
  // Breeze authentication can download its instrument master; keep the proxy deadline
  // longer than the backend's 90-second hard limit so the browser receives its safe error.
  experimental: { proxyTimeout: 100000 },
  /** Keep browser requests same-origin; only the server knows the internal API address. */
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_URL || "http://127.0.0.1:8000"}/api/:path*`,
      },
    ];
  },
  /** Deny embedding, suppress referrer leakage and disable browser capabilities the app does not use. */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
