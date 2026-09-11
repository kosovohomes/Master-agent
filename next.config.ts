import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Phase 1 M1: the sessionStorage-based admin surface was replaced by the
      // cookie-session Command Center. Bookmarks keep working via redirects.
      { source: "/admin/login", destination: "/login", permanent: false },
      { source: "/admin", destination: "/approvals", permanent: false },
    ];
  },
};

export default nextConfig;
