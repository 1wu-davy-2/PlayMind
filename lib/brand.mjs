// 按自报型号推断品牌 key，供前端选徽章
export function brandKeyOf(model) {
  const m = String(model || '').toLowerCase();
  const table = [
    ['deepseek', 'deepseek'], ['gpt', 'openai'], ['openai', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'],
    ['claude', 'claude'], ['anthropic', 'claude'], ['qwen', 'qwen'], ['tongyi', 'qwen'], ['dashscope', 'qwen'],
    ['gemini', 'gemini'], ['glm', 'glm'], ['zhipu', 'glm'], ['chatglm', 'glm'], ['moonshot', 'moonshot'], ['kimi', 'moonshot'],
    ['doubao', 'doubao'], ['seed', 'doubao'], ['bytedance', 'doubao'], ['hunyuan', 'hunyuan'],
    ['llama', 'ollama'], ['ollama', 'ollama'], ['mistral', 'ollama'],
  ];
  for (const [k, v] of table) if (m.includes(k)) return v;
  return 'unknown';
}
