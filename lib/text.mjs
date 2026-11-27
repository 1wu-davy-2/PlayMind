// 外部文本统一净化，防止脏字节继续污染牌桌

export function cleanText(v, max = 600) {
  return String(v == null ? '' : v)
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

export const DEFAULT_AGENT_STYLES = [
  '谨慎稳健，说话短，不轻易下判断',
  '直觉型，爱用比喻，敢下结论',
  '搅局者，爱转移视线，故意说得模糊',
  '分析派，逐条推理，引用别人的原话',
  '沉默者，惜字如金，只给关键词',
  '老好人，附和多数，避免正面冲突',
  '怀疑论者，谁都问一遍，不轻信',
  '急性子，话多，先表态再解释',
];
