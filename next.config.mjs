/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // 契约路径是 /v1/*（docs/api-contract.md），实际实现在 app/api/v1/*。
  // 用 rewrite 保持前端 12 处端点路径与既有文档不变。
  // /health 是运维端点，Python 侧就在 /health，保持不变。
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      { source: "/health", destination: "/api/health" },
    ];
  },
};

export default nextConfig;
