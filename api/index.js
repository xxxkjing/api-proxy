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
  // 防截断：Vercel serverless 中客户端断开时 res 会触发 close/error，
  // 用 AbortController 传播给上游，避免 serverless 实例在客户端已走的情况下继续拉流
  // （res/req 可能没有 on 方法——测试环境的 fake res、某些适配器——需要保护）
  const ac = new AbortController();
  req.abortSignal = ac.signal;
  const onClientClose = () => { try { ac.abort(); } catch (_) {} };
  if (res && typeof res.on === 'function') {
    res.on('close', onClientClose);
    res.on('error', onClientClose);
  }
  if (req && typeof req.on === 'function') {
    req.on('aborted', onClientClose);
  }

  const reqLike = {
    method: req.method,
    url: req.url || '/',
    headers: req.headers,
    body: readBody(req),
    abortSignal: req.abortSignal,
  };

  try {
    const result = await handler(reqLike);

    for (const [k, v] of Object.entries(result.headers || {})) {
      if (v != null) res.setHeader(k, v);
    }
    res.status(result.status);

    if (result.stream) {
      // 流式：边读边写（SSE 首 token 即到即转）
      // 防截断：任何异常都补一个 SSE [DONE] 标记再收尾，客户端不会收到"半截流"
      try {
        for await (const chunk of result.stream) {
          if (!res.writableEnded) res.write(chunk);
        }
      } catch (e) {
        console.error('Stream adapter error:', e.message);
        // 已发过 SSE 数据：补 [DONE] 让客户端正常结束（幂等：再写失败也没关系）
        try {
          if (!res.writableEnded) res.write('data: [DONE]\n\n');
        } catch (_) {}
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    res.send(result.body || '');
  } finally {
    if (res && typeof res.removeListener === 'function') {
      res.removeListener('close', onClientClose);
      res.removeListener('error', onClientClose);
    }
    if (req && typeof req.removeListener === 'function') {
      req.removeListener('aborted', onClientClose);
    }
  }
};