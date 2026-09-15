// 平台无关核心：createHandler(config) → async (reqLike) => resLike
// reqLike: { method, url, headers(对象或Headers实例), body(string|null) }
// resLike: { status, headers(对象), chunks(异步迭代器|null, 流式), body(string|null, 非流式) }
// 兼容 Vercel(Node req/res) 与 EdgeOne(Service Worker fetch)
// ⚠️ 依赖必须用静态 require（Vercel 静态追踪绕过变量路径），EdgeOne 由打包脚本替换为 __requireModule

const store = require('../lib/store');
const { MODELS, lookupModel } = require('../lib/models');
const adminHtml = require('../lib/admin-page.js');

module.exports = function createHandler(config) {
  const rawKeys = config.API_KEYS || [];
  const API_KEYS = rawKeys.map(k => String(k).trim()).filter(Boolean);
  const BASE_URL = config.BASE_URL || 'https://api.openai.com';
  const ADMIN_KEY = config.ADMIN_KEY || '';

  // 每个 key 的状态：coolUntil 冷却结束时间戳、callCount 累计调用次数
  let keyStates = API_KEYS.map(key => ({ key, coolUntil: 0, callCount: 0 }));

  // 冷却时长：基于上游 RPM（默认 8 → 每 key 至少 7.5s），留 10% 余量；可用 COOLDOWN_MS 覆盖
  const RPM = Number(config.RPM) || 8;
  const COOLDOWN_MS = Number(config.COOLDOWN_MS) || Math.ceil(60000 / RPM * 1.1);
  const PENALTY_MS = COOLDOWN_MS * 2; // 429 惩罚：双倍冷却

  function getHeader(headers, name) {
    if (!headers) return undefined;
    // Web Headers 实例
    if (typeof headers.get === 'function') {
      const v = headers.get(name);
      return v == null ? undefined : v;
    }
    // Node 对象形式（大小写不敏感）
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return headers[k];
    }
    return undefined;
  }

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

  async function* proxyStream(req, targetUrl, headers, body, startTs) {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
    });
    const status = response.status;
    const contentType = response.headers.get('content-type') || '';
    let ttft = null;
    let usage = null;
    const wantsStream = (typeof body === 'string' && body.includes('"stream":true'))
      || contentType.includes('text/event-stream');

    if (status !== 429 && status < 400 && wantsStream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (ttft == null) ttft = Date.now() - startTs;
        const u = extractUsageFromChunk(chunk);
        if (u) usage = u;
        yield { type: 'chunk', chunk, streamInfo: { status, contentType, ttft, usage } };
      }
      yield { type: 'end', streamInfo: { status, contentType, ttft, usage } };
      return;
    }

    // 非流式 / 错误
    const responseText = await response.text();
    yield {
      type: 'error-or-json',
      status,
      contentType,
      authorization: response.headers.get('authorization'),
      body: responseText,
      usage: extractUsageFromBody(responseText),
      ttft: null,
      latency: Date.now() - startTs,
    };
  }

  async function proxyRequest(req, resLike, apiKey) {
    const startTs = Date.now();
    const url = req.url || '/';
    let targetUrl;
    if (url.startsWith('/api')) {
      targetUrl = `${BASE_URL}${url.replace('/api', '/v1')}`;
    } else {
      targetUrl = `${BASE_URL}${url}`;
    }

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': getHeader(req.headers, 'content-type') || 'application/json',
    };

    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = req.body;
    }

    // 解析请求里的模型名（用于统计）
    let reqModel = null;
    try {
      const parsed = JSON.parse(body || '{}');
      reqModel = parsed.model || null;
    } catch (_) {}

    const streamGen = proxyStream(req, targetUrl, headers, body, startTs);
    // 消费第一段判断走流式还是非流式
    const first = await streamGen.next();
    if (first.done) return { status: 502, headers: {}, body: JSON.stringify({ error: 'upstream empty' }), stream: null };

    const item = first.value;
    if (item.type === 'error-or-json') {
      resLike.lastResult = { status: item.status, model: reqModel, usage: item.usage, ttft: item.ttft, latency: item.latency, handled: false, body: item.body, contentType: item.contentType, authorization: item.authorization };
      return resLike.lastResult;
    }

    // 流式：把后续 chunk 挂到 resLike.stream
    resLike.streamInfo = item.streamInfo;
    resLike.lastResult = {
      status: item.streamInfo.status,
      model: reqModel,
      usage: item.streamInfo.usage,
      ttft: item.streamInfo.ttft,
      latency: null,
      handled: true,
      body: '',
      contentType: item.streamInfo.contentType,
    };
    resLike.stream = (async function* () {
      yield item.chunk;
      for (;;) {
        const n = await streamGen.next();
        if (n.done) {
          if (n.value) {
            // end 段可能还带 streamInfo
            if (n.value.type === 'end' && n.value.streamInfo && n.value.streamInfo.usage) {
              resLike.lastResult.usage = n.value.streamInfo.usage;
              resLike.lastResult.ttft = n.value.streamInfo.ttft || resLike.lastResult.ttft;
            }
          }
          return;
        }
        const it = n.value;
        if (it.type === 'chunk') {
          if (it.streamInfo.usage) resLike.lastResult.usage = it.streamInfo.usage;
          yield it.chunk;
        }
      }
    })();
    return resLike.lastResult;
  }

  function isAdminAuthorized(req) {
    if (!ADMIN_KEY) return false;
    const auth = getHeader(req.headers, 'authorization') || '';
    return auth === `Bearer ${ADMIN_KEY}`;
  }

  function authorizeClient(req) {
    const auth = getHeader(req.headers, 'authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

    if (ADMIN_KEY && token === ADMIN_KEY) return { ok: true, admin: true, token };

    const rec = store.findClientKey(token);
    if (rec) {
      if (!rec.enabled) return { ok: false, reason: 'key_disabled' };
      return { ok: true, admin: false, token, rec };
    }
    return { ok: false, reason: 'invalid_api_key' };
  }

  async function handleAdminApi(req, pathname) {
    const adminAuthed = isAdminAuthorized(req);
    const bodyText = typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : '{}');
    let parsedBody = {};
    try { parsedBody = JSON.parse(bodyText || '{}'); } catch (_) {}

    if (pathname === '/admin/api/models') {
      let upstreamModels = null;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const resp = await fetch(`${BASE_URL}/v1/models`, {
          headers: { Authorization: `Bearer ${API_KEYS[0] || ''}` },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          if (data && Array.isArray(data.data)) {
            upstreamModels = data.data.map(m => m.id || m);
          }
        }
      } catch (e) {
        console.error('[models] upstream fetch failed:', e.message);
      }

      if (upstreamModels) {
        const live = upstreamModels.map(id => {
          const price = lookupModel(id);
          return {
            id,
            provider: price ? price.provider : '—',
            input: price ? price.input : null,
            output: price ? price.output : null,
            note: price ? price.note : '（端点模型，暂无价格数据）',
          };
        });
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: live, source: 'upstream', count: live.length }), stream: null };
      }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: MODELS, source: 'builtin', count: MODELS.length }), stream: null };
    }

    if (!adminAuthed) {
      return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'Unauthorized: admin key required', code: 'unauthorized' } }), stream: null };
    }

    switch (pathname) {
      case '/admin/api/stats': {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(store.getStats()), stream: null };
      }
      case '/admin/api/keys': {
        if (req.method === 'POST') {
          const name = parsedBody.name || 'unnamed';
          const quota = Number(parsedBody.quota) || 1000000;
          // 模型白名单：可传字符串（逗号分隔）或数组
          let models = null;
          if (parsedBody.models != null) {
            models = Array.isArray(parsedBody.models)
              ? parsedBody.models
              : String(parsedBody.models).split(',').map(s => s.trim()).filter(Boolean);
            if (!models.length) models = null;
          }
          const rec = store.createClientKey({ name, quota, models });
          return { status: 201, headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec), stream: null };
        }
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: store.listClientKeys() }), stream: null };
      }
      case '/admin/api/keys/toggle': {
        if (req.method === 'POST') {
          const { key, enabled } = parsedBody;
          const ok = store.toggleClientKey(key, !!enabled);
          return ok
            ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }), stream: null }
            : { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'key not found' }), stream: null };
        }
        return { status: 405, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'method not allowed' }), stream: null };
      }
      case '/admin/api/keys/delete': {
        if (req.method === 'POST') {
          const { key } = parsedBody;
          const ok = store.deleteClientKey(key);
          return ok
            ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }), stream: null }
            : { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'key not found' }), stream: null };
        }
        return { status: 405, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'method not allowed' }), stream: null };
      }
      default:
        return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not found' }), stream: null };
    }
  }

  return async function (req) {
    const resLike = { lastResult: null, streamInfo: null, stream: null };
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') {
      return { status: 200, headers: corsHeaders, body: '', stream: null };
    }

    const url = req.url || '/';
    const pathname = url.split('?')[0];

    // ---- 管理面板 ----
    if (pathname === '/admin' || pathname === '/admin/') {
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...corsHeaders }, body: adminHtml, stream: null };
    }

    // ---- 管理 API ----
    if (pathname.startsWith('/admin/api/')) {
      const r = await handleAdminApi(req, pathname);
      r.headers = { ...r.headers, ...corsHeaders };
      return r;
    }

    // ---- 转发前鉴权 ----
    let authResult = { ok: true, admin: false, token: '', rec: null };
    if (ADMIN_KEY) {
      const auth = authorizeClient(req);
      if (!auth.ok) {
        const code = auth.reason === 'key_disabled' ? 403 : 401;
        return {
          status: code,
          headers: { 'content-type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: { message: auth.reason === 'invalid_api_key' ? 'Invalid API key' : auth.reason, code: auth.reason } }),
          stream: null,
        };
      }
      if (!auth.admin && auth.rec && auth.rec.quota <= 0) {
        return {
          status: 401,
          headers: { 'content-type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: { message: 'Insufficient quota', code: 'insufficient_quota' } }),
          stream: null,
        };
      }
      authResult = auth;
    }
    const keyName = authResult.admin ? 'admin' : (authResult.rec ? authResult.rec.name : 'unknown');

    // ---- 模型白名单校验（非 admin key 且配置了 models 白名单）----
    if (!authResult.admin && authResult.rec && Array.isArray(authResult.rec.models) && authResult.rec.models.length) {
      let reqModel = null;
      try {
        const parsedBody = JSON.parse(req.body || '{}');
        reqModel = (parsedBody.model || '').trim();
      } catch (_) {}
      if (reqModel) {
        const allowed = authResult.rec.models.some(m => {
          const a = m.toLowerCase();
          const b = reqModel.toLowerCase();
          return a === b || b.startsWith(a); // 支持前缀匹配（如 glm-5.2 允许 glm-5.2-2026）
        });
        if (!allowed) {
          return {
            status: 403,
            headers: { 'content-type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: { message: `Model '${reqModel}' not allowed for this key`, code: 'model_not_allowed' } }),
            stream: null,
          };
        }
      }
    }

    if (!API_KEYS.length) {
      return {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: { message: `"API_KEYS environment variable is not set or is empty"`, type: `"config_error"`, param: `"API_KEYS"`, code: `"missing_api_keys"` } }),
        stream: null,
      };
    }

    let attempts = 0;
    const maxAttempts = Math.max(API_KEYS.length, 3);
    let hit429 = false;
    let lastResult = null;

    while (attempts < maxAttempts) {
      const state = pickKey({ preferLeastUsed: hit429 });
      if (!state) break;

      const nowMs = Date.now();
      const allCooling = keyStates.every(k => k.coolUntil > nowMs);
      if (allCooling) {
        const earliest = keyStates.reduce((a, b) => (a.coolUntil <= b.coolUntil ? a : b));
        const waitMs = earliest.coolUntil - nowMs;
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      }

      const finalState = pickKey({ preferLeastUsed: hit429 }) || state;
      finalState.coolUntil = Date.now() + COOLDOWN_MS;

      try {
        const result = await proxyRequest(req, resLike, finalState.key);
        finalState.callCount += 1;
        lastResult = result;

        if (result.status === 429) {
          hit429 = true;
          attempts += 1;
          finalState.coolUntil = Date.now() + PENALTY_MS;
          console.warn(`Key ${finalState.key.slice(0, 8)}... -> 429, penalized ${PENALTY_MS}ms (${attempts}/${maxAttempts})`);
          continue;
        }

        const usage = result.usage || {};
        const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
        const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
        const totalTokens = inputTokens + outputTokens;
        store.recordRequest({
          ts: Date.now(),
          model: result.model,
          status: result.status,
          ttft: result.ttft,
          latency: result.latency,
          inputTokens,
          outputTokens,
          keyName,
        });

        if (!authResult.admin && authResult.token && totalTokens > 0) {
          const c = store.consumeQuota(authResult.token, totalTokens);
          if (!c.ok && c.reason === 'key_disabled') {
            return { status: 403, headers: { 'content-type': 'application/json', ...corsHeaders }, body: JSON.stringify({ error: { message: 'Key disabled', code: 'key_disabled' } }), stream: null };
          }
        }

        // 流式：已挂 chunk 流
        if (result.handled && resLike.stream) {
          return {
            status: result.status,
            headers: { 'content-type': result.contentType, ...corsHeaders },
            body: null,
            stream: resLike.stream,
          };
        }

        // 非流式 / 错误：转发响应给客户端
        const headers = { ...corsHeaders };
        if (result.contentType) headers['content-type'] = result.contentType;
        if (result.authorization) headers['authorization'] = result.authorization;
        return { status: result.status, headers, body: result.body, stream: null };
      } catch (error) {
        console.error('Proxy error:', error);
        finalState.callCount += 1;
        finalState.coolUntil = Date.now() + PENALTY_MS;
        attempts += 1;
      }
    }

    if (lastResult) {
      const usage = lastResult.usage || {};
      store.recordRequest({
        ts: Date.now(),
        model: lastResult.model,
        status: lastResult.status,
        ttft: lastResult.ttft,
        latency: lastResult.latency,
        inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
        outputTokens: usage.completion_tokens || usage.output_tokens || 0,
        keyName,
      });
    }

    return {
      status: 502,
      headers: { 'content-type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: { message: `"All API keys failed"`, type: `"api_error"`, param: null, code: `"all_keys_failed"` } }),
      stream: null,
    };
  };
};