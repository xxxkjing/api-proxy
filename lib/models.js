// 主流模型官方价格表（美元 / 1M tokens；输入-缓存命中按低档算）
// 参考各家官方定价页，2026-09 快照。面板展示用，可自行增删。
const MODELS = [
  // OpenAI
  { id: "gpt-4.1", provider: "OpenAI", input: 2.00, output: 8.00, note: "GPT-4.1" },
  { id: "gpt-4.1-mini", provider: "OpenAI", input: 0.40, output: 1.60, note: "GPT-4.1 mini" },
  { id: "gpt-4o", provider: "OpenAI", input: 2.50, output: 10.00, note: "GPT-4o" },
  { id: "gpt-4o-mini", provider: "OpenAI", input: 0.15, output: 0.60, note: "GPT-4o mini" },
  { id: "gpt-5", provider: "OpenAI", input: 1.25, output: 10.00, note: "GPT-5" },
  { id: "gpt-5-mini", provider: "OpenAI", input: 0.25, output: 2.00, note: "GPT-5 mini" },
  { id: "o3", provider: "OpenAI", input: 2.00, output: 8.00, note: "o3" },
  { id: "o4-mini", provider: "OpenAI", input: 1.10, output: 4.40, note: "o4-mini" },
  // Anthropic
  { id: "claude-opus-4-1", provider: "Anthropic", input: 15.00, output: 75.00, note: "Opus 4.1" },
  { id: "claude-sonnet-4-5", provider: "Anthropic", input: 3.00, output: 15.00, note: "Sonnet 4.5" },
  { id: "claude-haiku-4-5", provider: "Anthropic", input: 1.00, output: 5.00, note: "Haiku 4.5" },
  // Google
  { id: "gemini-2.5-pro", provider: "Google", input: 1.25, output: 10.00, note: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", provider: "Google", input: 0.30, output: 2.50, note: "Gemini 2.5 Flash" },
  // DeepSeek
  { id: "deepseek-chat", provider: "DeepSeek", input: 0.27, output: 1.10, note: "DeepSeek V3.2" },
  { id: "deepseek-reasoner", provider: "DeepSeek", input: 0.55, output: 2.19, note: "DeepSeek R1" },
  // Zhipu GLM
  { id: "glm-4.5", provider: "Zhipu", input: 0.80, output: 2.00, note: "GLM-4.5" },
  { id: "glm-4.5-air", provider: "Zhipu", input: 0.40, output: 1.00, note: "GLM-4.5-Air" },
  { id: "glm-5.3-flash", provider: "Zhipu", input: 0.10, output: 0.30, note: "GLM-5.3-Flash" },
  // xAI
  { id: "grok-4", provider: "xAI", input: 3.00, output: 15.00, note: "Grok 4" },
  { id: "grok-4-fast", provider: "xAI", input: 0.40, output: 2.00, note: "Grok 4 Fast" },
  // Meta
  { id: "llama-4-maverick", provider: "Meta", input: 0.20, output: 0.60, note: "Llama 4 Maverick" },
  { id: "llama-4-scout", provider: "Meta", input: 0.10, output: 0.30, note: "Llama 4 Scout" },
  // Mistral
  { id: "mistral-large-3", provider: "Mistral", input: 2.00, output: 6.00, note: "Mistral Large 3" },
];

function lookupModel(id) {
  if (!id) return null;
  const norm = String(id).toLowerCase();
  let best = null;
  for (const m of MODELS) {
    if (norm === m.id.toLowerCase()) { best = m; break; }
    // 宽松匹配：model 名包含价格表 id 前缀（如 gpt-4o-2024-11-20 → gpt-4o）
    if (!best && norm.startsWith(m.id.toLowerCase())) best = m;
  }
  return best;
}

function estimateCost(model, inputTokens, outputTokens) {
  const m = lookupModel(model);
  if (!m) return null;
  return (inputTokens / 1e6 * m.input) + (outputTokens / 1e6 * m.output);
}

module.exports = { MODELS, lookupModel, estimateCost };