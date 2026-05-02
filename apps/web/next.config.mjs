/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output produces .next/standalone/ which contains a self-contained
  // server bundle plus only the runtime node_modules actually used. Required by
  // our production deploy (systemd unit runs apps/web/.next/standalone/apps/web/server.js).
  output: "standalone",
  // Keep transpilePackages so monorepo workspace deps are inlined into the build.
  transpilePackages: ["@remarka/contracts", "@remarka/db"],
  // pg uses native modules / dynamic require patterns that webpack can't statically
  // resolve (`pgpass` does `require("stream")` at the top of pg's import graph).
  // Marking it external makes Next.js leave it as a runtime require() in the
  // server bundle. Used by lib/events/listenBridge.ts for Postgres LISTEN.
  serverExternalPackages: ["pg"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
    middlewareClientMaxBodySize: "50mb",
  },
};

export default nextConfig;
