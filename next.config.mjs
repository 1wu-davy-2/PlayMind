/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 路由与页面统一 .mjs / .js 双扩展（Next 默认不含 mjs）
  pageExtensions: ['js', 'jsx', 'mjs', 'ts', 'tsx'],
};

export default nextConfig;
