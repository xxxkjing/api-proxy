// Vercel 适配器：Node req/res → 平台无关核心 → 写回
const createHandler = require('../lib/core');

function resolveConfig() {
  const raw = process.env.KEYS || process.env.API_KEYS || '';
  return {
    API_KEYS: raw.split(',').map(k => k.trim()).filter(Boolean),
    BASE_URL: process.env.BASE_URL || 'https://api.openai.com',
    ADMIN_KEY: process.env.YOUR_VERCEL_APP_API_KEY || process.env.ADMIN_KEY || '',
    RPM: process.env.RPM,
    COOLDOWN_MS: process.env.COOLDOWN_MS,
    DATA_FILE: process.env.DATA_FILE,
  };
}

const handler = createHandler(resolveConfig());

// 读取请求体（Vercel 已解析 req.body；稳妥起见兼容 string/Buffer/object）
function readBody(req) {
  if (req.body == null) return null;
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString();
  return JSON.stringify(req.body);
}

module.exports = async (req, res) => {
  const reqLike = {
    method: req.method,
    url: req.url || '/',
    headers: req.headers,
    body: readBody(req),
  };

  const result = await handler(reqLike);

  for (const [k, v] of Object.entries(result.headers || {})) {
    if (v != null) res.setHeader(k, v);
  }
  res.status(result.status);

  if (result.stream) {
    // 流式：边读边写（SSE 首 token 即到即转）
    try {
      for await (const chunk of result.stream) {
        res.write(chunk);
      }
    } catch (e) {
      console.error('Stream adapter error:', e);
    } finally {
      res.end();
    }
    return;
  }

  res.send(result.body || '');
};