const API_KEYS = process.env.KEYS || process.env.API_KEYS ?
  (process.env.KEYS || process.env.API_KEYS).split(',').map(key => key.trim()).filter(Boolean) :
  [];
const BASE_URL = process.env.BASE_URL || 'https://api.openai.com';

// 每个 key 的状态：lastUsed 上次调用时间戳（用于冷却）、callCount 累计调用次数（用于选最没调用的）
let keyStates = API_KEYS.map(key => ({ key, lastUsed: 0, callCount: 0 }));
const COOLDOWN_MS = 5000; // 每次调用后冷却 5 秒

function pickKey({ preferLeastUsed = false } = {}) {
  const now = Date.now();
  // 默认只从未冷却的 key 里随机选；全冷却时退化为全部
  let pool = keyStates.filter(k => now - k.lastUsed >= COOLDOWN_MS);
  if (!pool.length) pool = [...keyStates];
  if (!pool.length) return null;
  // 429 场景：选「最没调用过」的（callCount 最小，并列则随机）
  if (preferLeastUsed) {
    const min = Math.min(...pool.map(k => k.callCount));
    pool = pool.filter(k => k.callCount === min);
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

async function proxyRequest(req, apiKey) {
  const url = req.url;
  let targetUrl;
  if (url.startsWith('/api')) {
    targetUrl = `${BASE_URL}${url.replace('/api', '/v1')}`;
  } else {
    targetUrl = `${BASE_URL}${url}`;
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': req.headers['content-type'] || 'application/json',
  };

  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      body = req.body.toString();
    } else if (typeof req.body === 'object') {
      body = JSON.stringify(req.body);
    }
  }

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: headers,
    body: body,
  });

  const responseText = await response.text();
  return {
    status: response.status,
    body: responseText,
    contentType: response.headers.get('content-type'),
    authorization: response.headers.get('authorization'),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!API_KEYS.length) {
    return res.status(500).json({
      error: {
        message: `"API_KEYS environment variable is not set or is empty"`,
        type: `"config_error"`,
        param: `"API_KEYS"`,
        code: `"missing_api_keys"`
      }
    });
  }

  let attempts = 0;
  const maxAttempts = Math.max(API_KEYS.length, 3);
  let hit429 = false;

  while (attempts < maxAttempts) {
    // 正常时随机选未冷却 key；遇到 429 后改选「最没调用过」的 key
    const state = pickKey({ preferLeastUsed: hit429 });
    if (!state) break;
    state.lastUsed = Date.now(); // 调用即进入冷却

    try {
      const result = await proxyRequest(req, state.key);
      state.callCount += 1;

      if (result.status === 429) {
        hit429 = true;
        attempts += 1;
        console.warn(`Key ${state.key.slice(0, 8)}... -> 429, switching to least-used key (${attempts}/${maxAttempts})`);
        continue; // 不返回，直接换 key 重试
      }

      // 非 429：转发响应给客户端
      for (const [header, value] of [
        ['content-type', result.contentType],
        ['authorization', result.authorization],
      ]) {
        if (value) res.setHeader(header, value);
      }
      res.status(result.status).send(result.body);
      return;
    } catch (error) {
      console.error('Proxy error:', error);
      state.callCount += 1;
      attempts += 1;
    }
  }

  return res.status(502).json({
    error: {
      message: `"All API keys failed"`,
      type: `"api_error"`,
      param: null,
      code: `"all_keys_failed"`
    }
  });
};