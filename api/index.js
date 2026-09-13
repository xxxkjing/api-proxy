const API_KEYS = process.env.KEYS || process.env.API_KEYS ?
  (process.env.KEYS || process.env.API_KEYS).split(',').map(key => key.trim()).filter(Boolean) :
  [];
const BASE_URL = process.env.BASE_URL || 'https://api.openai.com';
const ADMIN_KEY = process.env.YOUR_VERCEL_APP_API_KEY || process.env.ADMIN_KEY || ''; // 管理面板登录 + 管理 API 鉴权

const store = require('../lib/store');

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

// 从 SSE 数据块里提取 usage（stream_options.include_usage 时末尾会有 usage chunk）
function extractUsageFromChunk(chunk) {
  let usage = null;
  const lines = String(chunk).split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.usage && (obj.choices == null || obj.choices.length === 0)) {
        usage = obj.usage;
      }
    } catch (_) { /* 非 JSON 行跳过 */ }
  }
  return usage;
}

// 从非流式响应 json 提取 usage
function extractUsageFromBody(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && obj.usage) return obj.usage;
  } catch (_) {}
  return null;
}

async function proxyRequest(req, res, apiKey) {
  const startTs = Date.now();
  let ttft = null;

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

  // 解析请求里的模型名（用于统计）
  let reqModel = null;
  try {
    const parsed = JSON.parse(body || '{}');
    reqModel = parsed.model || null;
  } catch (_) {}

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: headers,
    body: body,
  });

  const status = response.status;
  const contentType = response.headers.get('content-type') || '';
  const authorization = response.headers.get('authorization');

  // 流式透传：SSE 且非错误状态 → 边读边写，首 token 即到即转（首字时间=上游首字时间，不再等完整响应）
  const wantsStream = (typeof body === 'string' && body.includes('"stream":true'))
    || contentType.includes('text/event-stream');
  if (status !== 429 && status < 400 && wantsStream && response.body) {
    res.status(status);
    if (contentType) res.setHeader('content-type', contentType);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let usage = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (ttft == null) ttft = Date.now() - startTs; // 首个 chunk 到达 = 首字延迟
        // 尝试提取 usage（流式末尾 usage chunk）
        const u = extractUsageFromChunk(chunk);
        if (u) usage = u;
        res.write(chunk);
      }
    } catch (e) {
      console.error('Stream error:', e);
    } finally {
      res.end();
    }
    return { status, handled: true, body: '', contentType, authorization, usage, ttft, model: reqModel };
  }

  // 非流式 / 错误响应：读完整文本
  const responseText = await response.text();
  if (status < 400) ttft = Date.now() - startTs; // 非流式：首字≈响应完成（完整返回）
  return { status, handled: false, body: responseText, contentType, authorization, usage: extractUsageFromBody(responseText), ttft, model: reqModel };
}

// ---- 管理 API 鉴权 ----
function isAdminAuthorized(req) {
  if (!ADMIN_KEY) return false; // 未配置管理 key → 管理 API 一律拒绝（避免裸奔）
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${ADMIN_KEY}`;
}

// 转发鉴权：管理 key 或生成的 sk-xxx；返回 { ok, reason, clientKey, admin }
function authorizeClient(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (ADMIN_KEY && token === ADMIN_KEY) return { ok: true, admin: true, token };

  const rec = store.findClientKey(token);
  if (rec) {
    if (!rec.enabled) return { ok: false, reason: 'key_disabled' };
    return { ok: true, admin: false, token, rec };
  }
  return { ok: false, reason: 'invalid_api_key' };
}

// ---- 管理 API 路由 ----
async function handleAdminApi(req, res, pathname) {
  const adminAuthed = isAdminAuthorized(req);
  const bodyText = typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : '{}');
  let parsedBody = {};
  try { parsedBody = JSON.parse(bodyText || '{}'); } catch (_) {}

  // /admin/api/models 允许无鉴权展示（价格表是公开信息）；其余管理 API 需鉴权
  if (pathname === '/admin/api/models') {
    const { MODELS } = require('../lib/models');
    return res.status(200).json({ models: MODELS });
  }

  if (!adminAuthed) {
    return res.status(401).json({ error: { message: 'Unauthorized: admin key required', code: 'unauthorized' } });
  }

  switch (pathname) {
    case '/admin/api/stats': {
      return res.status(200).json(store.getStats());
    }
    case '/admin/api/keys': {
      if (req.method === 'POST') {
        const name = parsedBody.name || 'unnamed';
        const quota = Number(parsedBody.quota) || 1000000;
        const rec = store.createClientKey({ name, quota });
        return res.status(201).json(rec);
      }
      return res.status(200).json({ keys: store.listClientKeys() });
    }
    case '/admin/api/keys/toggle': {
      if (req.method === 'POST') {
        const { key, enabled } = parsedBody;
        const ok = store.toggleClientKey(key, !!enabled);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'key not found' });
      }
      return res.status(405).json({ error: 'method not allowed' });
    }
    case '/admin/api/keys/delete': {
      if (req.method === 'POST') {
        const { key } = parsedBody;
        const ok = store.deleteClientKey(key);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'key not found' });
      }
      return res.status(405).json({ error: 'method not allowed' });
    }
    default:
      return res.status(404).json({ error: 'not found' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const url = req.url || '/';
  const pathname = url.split('?')[0];

  // ---- 管理面板 ----
  if (pathname === '/admin' || pathname === '/admin/') {
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, '..', 'public', 'admin.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(fs.readFileSync(htmlPath, 'utf8'));
    }
    return res.status(404).send('admin.html not found');
  }

  // ---- 管理 API ----
  if (pathname.startsWith('/admin/api/')) {
    return handleAdminApi(req, res, pathname);
  }

  // ---- 转发前鉴权 ----
  if (ADMIN_KEY) {
    const auth = authorizeClient(req);
    if (!auth.ok) {
      const code = auth.reason === 'key_disabled' ? 403 : 401;
      return res.status(code).json({
        error: { message: auth.reason === 'invalid_api_key' ? 'Invalid API key' : auth.reason, code: auth.reason }
      });
    }
    // 额度预检：剩余额度 <= 0 直接拒绝（避免无额度 key 继续转发）
    if (!auth.admin && auth.rec && auth.rec.quota <= 0) {
      return res.status(401).json({ error: { message: 'Insufficient quota', code: 'insufficient_quota' } });
    }
  }
  const authResult = authorizeClient(req); // 需要 rec 记录 keyName（管理 key 记 admin）
  const keyName = authResult.admin ? 'admin' : (authResult.rec ? authResult.rec.name : 'unknown');

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
  let lastResult = null;

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
      const result = await proxyRequest(req, res, finalState.key);
      finalState.callCount += 1;
      lastResult = result;

      if (result.status === 429) {
        hit429 = true;
        attempts += 1;
        finalState.coolUntil = Date.now() + PENALTY_MS; // 429 惩罚：双倍冷却，防止继续踩雷
        console.warn(`Key ${finalState.key.slice(0, 8)}... -> 429, penalized ${PENALTY_MS}ms (${attempts}/${maxAttempts})`);
        continue; // 不返回，直接换 key 重试
      }

      // 记录统计（TTFT / token / 429）
      const usage = result.usage || {};
      const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      store.recordRequest({
        ts: Date.now(),
        model: result.model,
        status: result.status,
        ttft: result.ttft,
        inputTokens,
        outputTokens,
        keyName,
      });

      // 扣减客户端额度（管理 key 不扣）
      if (!authResult.admin && authResult.token && totalTokens > 0) {
        const c = store.consumeQuota(authResult.token, totalTokens);
        if (!c.ok && c.reason === 'key_disabled') {
          return res.status(403).json({ error: { message: 'Key disabled', code: 'key_disabled' } });
        }
        // insufficient_quota 只会在 tokens>quota 时出现；已成功转发，不拦
      }

      // 流式已在 proxyRequest 内边读边写，直接完成
      if (result.handled) return;

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

  // 所有 key 失败：记录统计再返回
  if (lastResult) {
    const usage = lastResult.usage || {};
    store.recordRequest({
      ts: Date.now(),
      model: lastResult.model,
      status: lastResult.status,
      ttft: lastResult.ttft,
      inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
      outputTokens: usage.completion_tokens || usage.output_tokens || 0,
      keyName,
    });
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