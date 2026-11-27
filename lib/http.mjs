// Route Handler 通用工具：只用标准 Request / Response，不依赖 next/server

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// JSON 响应：禁止缓存 + 允许跨域
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}

// 纯文本 / Markdown 响应
export function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(String(body == null ? '' : body), {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}

// CORS 预检
export function preflight() {
  return new Response(null, { status: 204, headers: { ...corsHeaders } });
}

// 读 JSON body：空串 → {}；解析失败或非对象 → { _raw: text }（兼容 text/plain 直接发一段思考）
export async function readJson(request) {
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    return {};
  }
  raw = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

function headerFirst(request, name) {
  const v = request.headers.get(name);
  if (!v) return '';
  return String(v).split(',')[0].trim();
}

// 公网部署：反向代理下必须显式配置 PUBLIC_BASE_URL，否则会生成内网地址
export function baseUrlOf(request) {
  const pub = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (pub) return pub;

  const host = headerFirst(request, 'x-forwarded-host') || headerFirst(request, 'host') || 'localhost';
  const proto = headerFirst(request, 'x-forwarded-proto')
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// 客户端 IP：取 X-Forwarded-For 第一段
export function clientIp(request) {
  const ip = headerFirst(request, 'x-forwarded-for');
  return ip || 'unknown';
}
