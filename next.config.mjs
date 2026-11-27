/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 路由与页面统一 .mjs / .js 双扩展（Next 默认不含 mjs）
  pageExtensions: ['js', 'jsx', 'mjs', 'ts', 'tsx'],
  // 隐藏 dev 左下角 Next 指示器，避免遮挡座位卡
  devIndicators: false,
};

export default nextConfig;
