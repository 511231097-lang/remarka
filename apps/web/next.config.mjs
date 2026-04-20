/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@remarka/contracts", "@remarka/db"],
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
    middlewareClientMaxBodySize: "25mb",
  },
};

export default nextConfig;
