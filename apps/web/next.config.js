/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@solaudit/db", "@solaudit/engine", "@solaudit/queue", "@solaudit/storage"],
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "bullmq", "ioredis"],
  },
};
module.exports = nextConfig;
