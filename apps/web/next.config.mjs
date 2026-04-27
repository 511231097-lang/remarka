/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@remarka/contracts", "@remarka/db"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
    middlewareClientMaxBodySize: "50mb",
  },
};

export default nextConfig;
