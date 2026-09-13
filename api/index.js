const API_KEYS = process.env.KEYS || process.env.API_KEYS ?
  (process.env.KEYS || process.env.API_KEYS).split(',').map(key => key.trim()).filter(Boolean) :
  [];
const BASE_URL = process.env.BASE_URL || 'https://api.openai.com';

// 每个 key 的状态：coolUntil 冷却结束时间戳、callCount 累计调用次数
let keyStates = API_KEYS.map(key => ({ key, coolUntil: 0, callCount: 0 }));

// 冷却时长：基于上游 RPM（默认 8 → 每 key 至少 7.5s），留 10% 余量；可用 COOLDOWN_MS 覆盖
const RPM = Number(process.env.RPM) || 8;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS) || Math.ceil(60000 / RPM * 1.1);
const PENALTY_MS = COOLDOWN_MS * 2; // 429 惩罚：双倍冷却

/**
 * 冷却感知选 key：
 * - 有已冷却的 key → 从中随机挑（负载均衡 + 零等待）
 * - 全部在冷却 → 挑「最早恢复」的 key（本次等待时间最短）
 * - preferLeastUsed：429 场景优先「累计调用最少」的已冷却 key；全冷却时同规则退化
 */
function pickKey({ preferLeastUsed = false } = {}) {
  const now = Date.now();
  let pool = keyStates.filter(k => k.coolUntil <= now);
  if (!pool.length) pool = [...keyStates];
  if (!pool.length) return null;

  if (preferLeastUsed && pool.length > 1) {
    const min = Math.min(...pool.map(k => k.callCount));
    const least = pool.filter(k => k.callCount === min);
    if (least.length) pool = least;
  }

  // 全冷却时（pool === keyStates）：选最早恢复的；否则从可用里随机
  if (pool.length === keyStates.length && keyStates.some(k => k.coolUntil > now)) {
    return pool.reduce((a, b) => (a.coolUntil <= b.coolUntil ? a : b));
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

    // 全冷却时精确等待最早恢复的 key（保证本次回答等待时间最短）
    const nowMs = Date.now();
    const allCooling = keyStates.every(k => k.coolUntil > nowMs);
    if (allCooling) {
      const earliest = keyStates.reduce((a, b) => (a.coolUntil <= b.coolUntil ? a : b));
      const waitMs = earliest.coolUntil - nowMs;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    }

    // 等待期间可能已有其他 key 恢复，重新选一次（preferLeastUsed 状态保留）
    const finalState = pickKey({ preferLeastUsed: hit429 }) || state;
    finalState.coolUntil = Date.now() + COOLDOWN_MS; // 调用后进入冷却

    try {
      const result = await proxyRequest(req, finalState.key);
      finalState.callCount += 1;

      if (result.status === 429) {
        hit429 = true;
        attempts += 1;
        finalState.coolUntil = Date.now() + PENALTY_MS; // 429 惩罚：双倍冷却，防止继续踩雷
        console.warn(`Key ${finalState.key.slice(0, 8)}... -> 429, penalized ${PENALTY_MS}ms (${attempts}/${maxAttempts})`);
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
      finalState.callCount += 1;
      finalState.coolUntil = Date.now() + PENALTY_MS; // 网络错误也惩罚，避免连续踩同一个
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