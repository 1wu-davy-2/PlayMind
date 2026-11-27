// 静态数据：牌、道具、牌堆配方、内置 bot 人格

export const CARD_META = {
  bomb: { key: 'bomb', label: '炸弹', glyph: '爆', tone: 'danger' },
  question: { key: 'question', label: '质询', glyph: '审', tone: 'warn' },
  safe: { key: 'safe', label: '安全', glyph: '安', tone: 'calm' },
  supply: { key: 'supply', label: '补给', glyph: '补', tone: 'good' },
};

export const ITEM_META = {
  defuse: { key: 'defuse', label: '拆弹钳', glyph: '钳', desc: '抵挡一次炸弹伤害' },
  xray: { key: 'xray', label: '透视镜', glyph: '镜', desc: '窥视牌堆顶两张' },
  swap: { key: 'swap', label: '换手牌', glyph: '换', desc: '把本次抽牌转给指定玩家' },
};

export const DECK_RECIPE = { bomb: 7, question: 8, safe: 7, supply: 4 };

export const MAX_HP = 4;
export const MAX_ITEMS = 2;

// 席位不足时用来填座的内置 bot
export const SEAT_PRESETS = [
  { name: '墨菲', title: '前拆弹工程师', glyph: '◼', hue: 12, deceit: 0.25, aggression: 0.6, style: '冷峻、极简，只算概率和代价' },
  { name: '零', title: '职业赌徒', glyph: '◈', hue: 320, deceit: 0.82, aggression: 0.5, style: '浮夸、话密、爱演' },
  { name: '阿岚', title: '谈判专家', glyph: '◐', hue: 165, deceit: 0.48, aggression: 0.25, style: '温和、体面、滴水不漏' },
  { name: '灰雀', title: '退役审讯员', glyph: '◆', hue: 45, deceit: 0.6, aggression: 0.8, style: '咄咄逼人，习惯反问' },
  { name: '白鸦', title: '档案管理员', glyph: '▣', hue: 265, deceit: 0.35, aggression: 0.3, style: '冷静，喜欢引用记录' },
];

export const GLYPHS = ['◼', '◈', '◐', '◆', '▣', '●', '▲', '■'];
export const HUES = [12, 320, 165, 45, 265, 200, 95, 340];
