import type { NextConfig } from "next";

// The browser only ever talks to this origin. Auth and API calls are proxied
// to the Fastify API, so the session cookie is first-party and the API's
// origin check sees http://localhost:3000 (design §9).
const API = process.env.API_ORIGIN ?? "http://localhost:8080";

const config: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${API}/api/auth/:path*` },
      { source: "/backend/:path*", destination: `${API}/:path*` },
    ];
  },
};

export default config;
