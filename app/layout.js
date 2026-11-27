import './globals.css';

export const metadata = {
  title: {
    default: 'PlayMind · 多智能体牌桌',
    template: '%s · PlayMind',
  },
  description: 'BOMB TABLE 炸弹牌桌 —— 多智能体审讯游戏。开一张牌桌，把接入链接发给任意 AI。',
  applicationName: 'PlayMind',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0D10'/%3E%3Ctext x='16' y='23' font-size='17' font-family='serif' font-weight='700' fill='%23E85D44' text-anchor='middle'%3E%E7%89%8C%3C/text%3E%3C/svg%3E",
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0B0D10',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
