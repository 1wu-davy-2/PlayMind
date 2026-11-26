/* public/brands.js — 把 AI 自报的型号映射成品牌徽章。
   普通浏览器脚本（非 ES module）：加载后在 window.BombBrands 上暴露
     brandOf(model) / modelLabel(model) / avatarHTML(player, size)
   座位卡与监听记录可直接把 avatarHTML() 的返回值塞进 innerHTML。
   零依赖：不引外部图片、不引 CSS 文件、不注入 <style>，所有样式内联在 SVG 上。 */
(function () {
  'use strict';

  /* key → 品牌定义。bg 是淡化后的浅底，供座位卡背景使用。 */
  var BRANDS = [
    { key: 'deepseek', name: 'DeepSeek', color: '#4D6BFE', bg: '#EEF1FF', keys: ['deepseek'] },
    { key: 'openai',   name: 'OpenAI',   color: '#10A37F', bg: '#E6F6F0', keys: ['gpt', 'openai', /\bo[134](?![a-z0-9])/] },
    { key: 'claude',   name: 'Claude',   color: '#D97757', bg: '#FBEEE9', keys: ['claude', 'anthropic'] },
    { key: 'qwen',     name: 'Qwen',     color: '#615CED', bg: '#EFEEFF', keys: ['qwen', 'tongyi', 'dashscope'] },
    { key: 'gemini',   name: 'Gemini',   color: '#4285F4', bg: '#EAF1FE', keys: ['gemini'] },
    { key: 'glm',      name: 'GLM',      color: '#3B5BDB', bg: '#EAF0FF', keys: ['glm', 'zhipu', 'chatglm'] },
    { key: 'moonshot', name: 'Moonshot', color: '#1A1A1A', bg: '#EFEFEF', keys: ['moonshot', 'kimi'] },
    { key: 'doubao',   name: 'Doubao',   color: '#3B82F6', bg: '#E8F1FE', keys: ['doubao', 'seed', 'bytedance'] },
    { key: 'hunyuan',  name: 'Hunyuan',  color: '#0052D9', bg: '#E6EEFC', keys: ['hunyuan'] },
    { key: 'ollama',   name: 'Ollama',   color: '#F5A623', bg: '#FEF3E0', keys: ['llama', 'ollama', 'mistral'] },
    { key: 'unknown',  name: 'AI',       color: '#6B6455', bg: '#F0EEE9', keys: [] },
  ];

  var BY_KEY = {};
  for (var i = 0; i < BRANDS.length; i += 1) BY_KEY[BRANDS[i].key] = BRANDS[i];

  var MAX_MODEL = 28;

  /** HTML / SVG 属性与文本转义 */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 去掉控制字符与替换符，避免脏文本进 DOM */
  function clean(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F\uFFFD]/g, '').trim();
  }

  function sizeNum(size) {
    var n = Number(size);
    if (!isFinite(n) || n <= 0) n = 22;
    return Math.max(8, Math.min(256, Math.round(n)));
  }

  function hit(model, keys) {
    for (var j = 0; j < keys.length; j += 1) {
      var k = keys[j];
      if (k instanceof RegExp) { if (k.test(model)) return true; }
      else if (model.indexOf(k) !== -1) return true;
    }
    return false;
  }

  /** 型号 → { key, name, color, bg }；大小写不敏感，按子串匹配。返回副本，防调用方改污染内部表。 */
  function brandOf(model) {
    var m = clean(model).toLowerCase();
    for (var i = 0; i < BRANDS.length; i += 1) {
      var b = BRANDS[i];
      if (b.keys.length && m && hit(m, b.keys)) {
        return { key: b.key, name: b.name, color: b.color, bg: b.bg };
      }
    }
    var u = BY_KEY.unknown;
    return { key: u.key, name: u.name, color: u.color, bg: u.bg };
  }

  /** "DeepSeek · deepseek-v4.1-flash"，型号过长会截断；型号为空只返回品牌名。 */
  function modelLabel(model) {
    var b = brandOf(model);
    var raw = clean(model);
    if (!raw) return b.name;
    if (raw.length > MAX_MODEL) raw = raw.slice(0, MAX_MODEL - 1) + '…';
    return b.name + ' · ' + raw;
  }

  /* 每个品牌一个可区分的简化几何符号（viewBox 0 0 40 40，中心 20,20，白色描边 / 填充）。 */
  function symbol(key) {
    switch (key) {
      case 'deepseek': // 波浪 / 鲸尾
        return '<path d="M6 26 Q10 21 14 26 T22 26 T30 26" />' +
               '<path d="M11 16 Q15 12 19 16" />' +
               '<circle cx="27" cy="15" r="1.6" fill="#fff" stroke="none" />';
      case 'openai': { // 六瓣花结：三段 8 字环各旋转 60°
        var ring = 'M20 8 C13 8 10 14 13 20 C10 26 13 32 20 32 C27 32 30 26 27 20 C30 14 27 8 20 8 Z';
        return '<path d="' + ring + '" />' +
               '<path d="' + ring + '" transform="rotate(60 20 20)" />' +
               '<path d="' + ring + '" transform="rotate(120 20 20)" />';
      }
      case 'claude': // 不对称星芒
        return '<path stroke-width="3" d="M20 7 V19 M20 21 V33 M7 13 L17 19 M23 21 L33 27 M7 27 L17 21 M23 19 L33 13" />';
      case 'qwen': // 圆环 Q
        return '<circle cx="18" cy="18" r="8.5" />' +
               '<path stroke-width="2.6" d="M23 23 L30 30" />';
      case 'gemini': // 四角星
        return '<path fill="#fff" stroke="none" d="M20 5 C21.2 14.5 25.5 18.8 35 20 C25.5 21.2 21.2 25.5 20 35 C18.8 25.5 14.5 21.2 5 20 C14.5 18.8 18.8 14.5 20 5 Z" />';
      case 'glm': // 菱形 Z
        return '<path d="M20 6 L34 20 L20 34 L6 20 Z" />' +
               '<path stroke-width="2.4" d="M14.5 15 H25.5 L14.5 25 H25.5" />';
      case 'moonshot': // 月牙 + 小星
        return '<path fill="#fff" stroke="none" d="M26 8 A12 12 0 1 0 26 32 A10 10 0 1 1 26 8 Z" />' +
               '<path fill="#fff" stroke="none" d="M28 12 l1.1 2.4 2.4 1.1 -2.4 1.1 -1.1 2.4 -1.1 -2.4 -2.4 -1.1 2.4 -1.1 z" />';
      case 'doubao': // 圆点环
        return '<circle cx="20" cy="20" r="4" fill="#fff" stroke="none" />' +
               '<g fill="#fff" stroke="none">' +
               '<circle cx="31" cy="20" r="1.7" /><circle cx="25.5" cy="29.5" r="1.7" />' +
               '<circle cx="14.5" cy="29.5" r="1.7" /><circle cx="9" cy="20" r="1.7" />' +
               '<circle cx="14.5" cy="10.5" r="1.7" /><circle cx="25.5" cy="10.5" r="1.7" />' +
               '</g>';
      case 'hunyuan': // 漩涡
        return '<path d="M20 20 C20 16 25.5 15 27.5 19 C29.5 23.5 25 29 19.5 28 C13 27 10.5 20.5 13.5 15 C16.5 9.5 24 9 29.5 12" />';
      case 'ollama': // 圆角 L
        return '<path stroke-width="4" d="M14 9 V24 Q14 30 20 30 H31" />';
      default: // unknown：AI 两字
        return '<text x="20" y="20" fill="#fff" stroke="none" text-anchor="middle" dominant-baseline="central" ' +
               'font-family="Helvetica,Arial,sans-serif" font-size="15" font-weight="700">AI</text>';
    }
  }

  /** 品牌 + 尺寸 → 内联 SVG 字符串（圆角方形底 + 品牌符号 + title）。 */
  function svgMarkup(b, n) {
    var title = esc(b.name);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n + '" ' +
      'viewBox="0 0 40 40" role="img" title="' + title + '" aria-label="' + title + '" ' +
      'style="display:block;width:' + n + 'px;height:' + n + 'px">' +
      '<title>' + title + '</title>' +
      '<rect x="1" y="1" width="38" height="38" rx="9" fill="' + esc(b.color) + '" />' +
      '<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      symbol(b.key) +
      '</g>' +
      '</svg>';
  }

  /** player: { name, model, brand, avatarUrl } → 可直接 innerHTML 的 HTML 字符串。 */
  function avatarHTML(player, size) {
    var p = player && typeof player === 'object' ? player : {};
    var n = sizeNum(size);
    var b = brandOf(p.model);
    // 型号没推断出来时，沿用服务端写进 players[].brand 的结果
    if (b.key === 'unknown' && p.brand && BY_KEY[String(p.brand)]) {
      var fb = BY_KEY[String(p.brand)];
      b = { key: fb.key, name: fb.name, color: fb.color, bg: fb.bg };
    }

    var svg = svgMarkup(b, n);
    var url = clean(p.avatarUrl);
    if (!url) return svg;

    // img 绝对定位盖在内置徽章上；加载失败则 display:none，露出底下的 SVG。
    // src / alt 全部 HTML 转义，防止 URL 或名字逃逸出属性。
    return '<span style="position:relative;display:inline-block;width:' + n + 'px;height:' + n + 'px;vertical-align:middle">' +
      svg +
      '<img src="' + esc(url) + '" alt="' + esc(p.name || b.name) + '" ' +
      'width="' + n + '" height="' + n + '" onerror="this.style.display=\'none\'" ' +
      'style="position:absolute;left:0;top:0;width:' + n + 'px;height:' + n + 'px;' +
      'border-radius:9px;object-fit:cover">' +
      '</span>';
  }

  var api = {
    brandOf: brandOf,
    modelLabel: modelLabel,
    avatarHTML: avatarHTML,
  };
  var root = typeof window !== 'undefined' ? window : globalThis;
  root.BombBrands = api;
}());
