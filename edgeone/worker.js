// EdgeOne Edge Function — api-proxy（由 scripts/build-edgeone.mjs 生成，勿手改）
// 部署：EdgeOne 控制台 → 边缘函数 → 新建/编辑 → 粘贴本文件 → 部署 → 配置触发规则 → 环境变量
// 环境变量：API_KEYS(必填), BASE_URL, YOUR_VERCEL_APP_API_KEY(或 ADMIN_KEY), RPM, COOLDOWN_MS
// 注意：EdgeOne 无文件系统，数据为纯内存（重启清零）；持久化请用 KV 或自托管

const __modules = {};
function __requireModule(id) {
  if (__modules[id]) return __modules[id].exports;
  const factory = __modules[__moduleFactories[id]];
  if (!factory) { throw new Error('module not found: ' + id); }
  const mod = { exports: {} };
  __modules[id] = mod;
  factory(mod, mod.exports);
  return mod.exports;
}
const __moduleFactories = {
  'lib/store.js': function(module, exports) {
    // 内存存储：管理用 API key、分钟级统计、最近请求日志（环形缓冲）
    // 持久化：变更防抖写入 DATA_FILE（默认 data/store.json），启动时自动加载
    // ⚠️ 若部署在只读文件系统（如部分 serverless），可设 DATA_FILE=/tmp/store.json 或 /dev/shm/store.json
    
    const crypto = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
    // 兼容无 Node fs 的边缘运行时（EdgeOne 基于 Service Worker，无 fs）
    let fs = null; // EdgeOne: 无 fs（下方 try require 会失败→纯内存）
    let path = null;
    let DATA_FILE_DEFAULT = null;
    try { throw new Error('no-fs'); fs = require("fs");
      path = require("path");
      DATA_FILE_DEFAULT = path.join(__dirname, "..", "data", "store.json");
    } catch (_) {}
    const hasFs = !!fs;
    
    const DATA_FILE = (typeof process !== 'undefined' && process.env && process.env.DATA_FILE) || DATA_FILE_DEFAULT;
    
    // ---- 生成的客户端 key（sk-xxx，带额度）----
    let clientKeys = new Map(); // key -> { name, key, quota (剩余 token), totalQuota, createdAt, enabled }
    
    // ---- 统计 ----
    // 分钟级桶：{ "yyyy-mm-ddTHH:MM" -> { requests, err429, ttftSum, ttftCount, latSum, latCount, inputTokens, outputTokens, costSum } }
    let minuteBuckets = new Map();
    // 模型维度：{ model -> { requests, inputTokens, outputTokens, cost } }
    let modelStats = new Map();
    // 最近请求日志（环形，保留 MAX_LOGS 条）
    const MAX_LOGS = 500;
    let requestLogs = [];
    
    // 服务启动时间（用于 uptime）
    const startedAt = Date.now();
    
    // ---- 持久化 ----
    let _saveTimer = null;
    function scheduleSave() {
      if (_saveTimer) return;
      _saveTimer = setTimeout(() => { _saveTimer = null; saveNow(); }, 300);
    }
    function saveNow() {
      if (!hasFs || !DATA_FILE) return; // 无 fs 环境（EdgeOne）跳过持久化，纯内存
      try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        const payload = {
          clientKeys: Array.from(clientKeys.values()),
          minuteBuckets: Array.from(minuteBuckets.entries()),
          modelStats: Array.from(modelStats.entries()),
          requestLogs,
          savedAt: Date.now(),
        };
        const tmp = DATA_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(payload));
        fs.renameSync(tmp, DATA_FILE);
      } catch (e) {
        console.error("[store] save failed:", e.message);
      }
    }
    function load() {
      if (!hasFs || !DATA_FILE) return; // 无 fs 环境：纯内存启动
      try {
        if (!fs.existsSync(DATA_FILE)) return;
        const payload = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        if (Array.isArray(payload.clientKeys)) {
          clientKeys = new Map(payload.clientKeys.map(r => [r.key, r]));
        }
        if (Array.isArray(payload.minuteBuckets)) minuteBuckets = new Map(payload.minuteBuckets);
        if (Array.isArray(payload.modelStats)) modelStats = new Map(payload.modelStats);
        if (Array.isArray(payload.requestLogs)) requestLogs = payload.requestLogs.slice(-MAX_LOGS);
        console.log(`[store] loaded ${clientKeys.size} keys, ${minuteBuckets.size} buckets, ${requestLogs.length} logs from ${DATA_FILE}`);
      } catch (e) {
        console.error("[store] load failed:", e.message);
      }
    }
    load();
    
    function nowMinuteKey(ts = Date.now()) {
      const d = new Date(ts);
      const p = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    
    // ---- client key 管理 ----
    function generateKey(prefix = "sk-") {
      // Web Crypto (getRandomValues) 跨平台；Node 下也原生支持
      const bytes = new Uint8Array(24);
      if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
      } else if (crypto && typeof crypto.randomBytes === 'function') {
        const buf = crypto.randomBytes(24);
        buf.forEach((b, i) => bytes[i] = b);
      }
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
      return prefix + hex;
    }
    
    function createClientKey({ name = "unnamed", quota = 1000000, models = null } = {}) {
      const key = generateKey();
      const rec = {
        name: String(name),
        key,
        quota: Number(quota),
        totalQuota: Number(quota),
        createdAt: Date.now(),
        enabled: true,
        // 模型白名单：null/空数组 = 不限制；否则只能访问列出的模型
        models: Array.isArray(models) ? models.map(m => String(m).trim()).filter(Boolean) : null,
      };
      clientKeys.set(key, rec);
      scheduleSave();
      return rec;
    }
    
    function findClientKey(key) {
      if (!key) return null;
      return clientKeys.get(key) || null;
    }
    
    function deleteClientKey(key) {
      const ok = clientKeys.delete(key);
      if (ok) scheduleSave();
      return ok;
    }
    
    function toggleClientKey(key, enabled) {
      const rec = clientKeys.get(key);
      if (!rec) return false;
      rec.enabled = !!enabled;
      scheduleSave();
      return true;
    }
    
    function listClientKeys() {
      return Array.from(clientKeys.values()).sort((a, b) => b.createdAt - a.createdAt);
    }
    
    // 扣减额度；返回 { ok, rec } 或 { ok:false, reason }
    // 额度不足时允许透支为负数（先服务后扣，预检在下次请求拦截），保证本次请求不被中途打断
    function consumeQuota(key, tokens) {
      const rec = clientKeys.get(key);
      if (!rec) return { ok: false, reason: "invalid_key" };
      if (!rec.enabled) return { ok: false, reason: "key_disabled" };
      if (tokens > 0) rec.quota -= tokens;
      scheduleSave();
      return { ok: true, rec };
    }
    
    // ---- 统计记录 ----
    // ttft：流式请求的首字延迟（上游首个 chunk 到达）；latency：非流式请求的总响应耗时
    function recordRequest({ ts = Date.now(), model, status, ttft, latency, inputTokens, outputTokens, keyName }) {
      // 分钟桶
      const mk = nowMinuteKey(ts);
      let bucket = minuteBuckets.get(mk);
      if (!bucket) {
        bucket = { requests: 0, err429: 0, ttftSum: 0, ttftCount: 0, latSum: 0, latCount: 0, inputTokens: 0, outputTokens: 0, costSum: 0 };
        minuteBuckets.set(mk, bucket);
      }
      bucket.requests += 1;
      if (status === 429) bucket.err429 += 1;
      if (ttft != null && ttft > 0) { bucket.ttftSum += ttft; bucket.ttftCount += 1; }
      if (latency != null && latency > 0) { bucket.latSum += latency; bucket.latCount += 1; }
      bucket.inputTokens += inputTokens || 0;
      bucket.outputTokens += outputTokens || 0;
      // 费用估算
      const { estimateCost } = __requireModule('lib/models.js').estimateCost !== undefined ? __requireModule('lib/models.js') : {};
      const cost = estimateCost(model, inputTokens || 0, outputTokens || 0);
      if (cost != null) bucket.costSum += cost;
    
      // 模型维度
      const ms = modelStats.get(model) || { model, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      ms.requests += 1;
      ms.inputTokens += inputTokens || 0;
      ms.outputTokens += outputTokens || 0;
      if (cost != null) ms.cost += cost;
      modelStats.set(model, ms);
    
      // 日志（环形）
      requestLogs.push({ ts, model, status, ttft, latency, inputTokens, outputTokens, keyName, cost });
      if (requestLogs.length > MAX_LOGS) requestLogs.splice(0, requestLogs.length - MAX_LOGS);
    
      // 防止内存无限增长：只保留最近 120 分钟桶
      const allMinKeys = Array.from(minuteBuckets.keys()).sort();
      while (allMinKeys.length > 120) {
        minuteBuckets.delete(allMinKeys.shift());
      }
    
      scheduleSave(); // 统计变更落盘（防抖）
    }
    
    // 清理过期分钟桶（按当前时间截断）
    function pruneBuckets(now = Date.now()) {
      const cutoff = now - 120 * 60 * 1000;
      for (const [k, v] of minuteBuckets) {
        const ts = new Date(k).getTime();
        if (ts < cutoff) minuteBuckets.delete(k);
      }
    }
    
    function getStats() {
      pruneBuckets();
      const minutes = Array.from(minuteBuckets.entries())
        .sort((a, b) => a[0] < b[0] ? -1 : 1)
        .map(([t, b]) => ({
          t,
          requests: b.requests,
          err429: b.err429,
          ttftAvg: b.ttftCount ? Math.round(b.ttftSum / b.ttftCount) : null,
          latencyAvg: b.latCount ? Math.round(b.latSum / b.latCount) : null,
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          totalTokens: b.inputTokens + b.outputTokens,
          cost: +(b.costSum || 0).toFixed(4),
          rpm: b.requests,
        }));
    
      // 汇总
      const totals = minutes.reduce((acc, m) => {
        acc.requests += m.requests;
        acc.err429 += m.err429;
        acc.totalTokens += m.totalTokens;
        acc.cost += m.cost;
        return acc;
      }, { requests: 0, err429: 0, totalTokens: 0, cost: 0 });
    
      const ttftVals = minutes.filter(m => m.ttftAvg != null).map(m => m.ttftAvg);
      const avgTtft = ttftVals.length ? Math.round(ttftVals.reduce((a, b) => a + b, 0) / ttftVals.length) : null;
      const latVals = minutes.filter(m => m.latencyAvg != null).map(m => m.latencyAvg);
      const avgLatency = latVals.length ? Math.round(latVals.reduce((a, b) => a + b, 0) / latVals.length) : null;
    
      return {
        startedAt,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        totals,
        avgTtft,
        avgLatency,
        minutes,
        models: Array.from(modelStats.values()).sort((a, b) => b.requests - a.requests),
        logs: requestLogs.slice(-100).reverse(), // 最近 100 条，新在前
      };
    }
    
    module.exports = {
      createClientKey,
      findClientKey,
      deleteClientKey,
      toggleClientKey,
      listClientKeys,
      consumeQuota,
      recordRequest,
      getStats,
    };
  },
  'lib/models.js': function(module, exports) {
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
      { id: "deepseek-v4-flash", provider: "DeepSeek", input: 0.22, output: 0.66, note: "DeepSeek V4 Flash（官方空闲价）" },
      { id: "deepseek-v4-pro", provider: "DeepSeek", input: 1.32, output: 3.96, note: "DeepSeek V4 Pro（官方基准价）" },
      // Zhipu GLM
      { id: "glm-4.5", provider: "Zhipu", input: 0.80, output: 2.00, note: "GLM-4.5" },
      { id: "glm-4.5-air", provider: "Zhipu", input: 0.40, output: 1.00, note: "GLM-4.5-Air" },
      { id: "glm-5.3-flash", provider: "Zhipu", input: 0.10, output: 0.30, note: "GLM-5.3-Flash" },
      { id: "glm-5.2", provider: "Zhipu", input: 1.40, output: 4.40, note: "GLM-5.2（官方基准价）" },
      // Moonshot Kimi
      { id: "kimi-k3", provider: "Moonshot", input: 3.00, output: 15.00, note: "Kimi K3（官方基准价）" },
      // SenseNova 商汤日日新（官方美元价未公开，以下为同类模型市场估算）
      { id: "sensenova-6.7-flash-lite", provider: "SenseNova", input: 0.15, output: 0.45, note: "商汤 6.7 Flash Lite（估算）" },
      { id: "sensenova-6.8-flash-lite", provider: "SenseNova", input: 0.15, output: 0.45, note: "商汤 6.8 Flash Lite（估算）" },
      { id: "sensenova-u1-fast", provider: "SenseNova", input: 2.00, output: 8.00, note: "商汤 U1 Fast（估算）" },
      { id: "sensenova-u1.5-lite", provider: "SenseNova", input: 1.00, output: 4.00, note: "商汤 U1.5 Lite（估算）" },
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
  },
  'lib/admin-page.js': function(module, exports) {
    // 内嵌管理面板 HTML（由脚本生成；EdgeOne 无文件系统，用模块方式读取）
    module.exports = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>API Proxy</title>\n<script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js\"></script>\n<style>\n  :root {\n    --bg: #ffffff;\n    --ink: #1d1d1f;\n    --ink-2: #6e6e73;\n    --ink-3: #86868b;\n    --line: #e8e8ed;\n    --accent: #0066cc;\n    --danger: #d70015;\n    --ok: #1d1d1f;\n  }\n  * { margin: 0; padding: 0; box-sizing: border-box; }\n  body {\n    font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Helvetica Neue\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif;\n    background: var(--bg); color: var(--ink);\n    -webkit-font-smoothing: antialiased;\n  }\n  .container { max-width: 1080px; margin: 0 auto; padding: 64px 32px 120px; }\n\n  /* 登录 */\n  #login-page { display: none; max-width: 340px; margin: 20vh auto 0; text-align: center; }\n  #login-page h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.5px; margin-bottom: 40px; }\n  #login-page input {\n    width: 100%; padding: 12px 16px; border: 1px solid var(--line);\n    border-radius: 12px; font-size: 15px; text-align: center; outline: none;\n    transition: border-color .2s;\n  }\n  #login-page input:focus { border-color: var(--accent); }\n  #login-btn {\n    width: 100%; margin-top: 12px; padding: 12px; border: none; border-radius: 12px;\n    background: var(--accent); color: #fff; font-size: 15px; font-weight: 500; cursor: pointer;\n  }\n  #login-btn:hover { opacity: .9; }\n  .login-err { color: var(--danger); font-size: 13px; margin-top: 10px; min-height: 18px; }\n\n  /* 顶部 */\n  #panel { display: none; }\n  .topbar {\n    display: flex; justify-content: space-between; align-items: flex-end;\n    padding-bottom: 24px; border-bottom: 1px solid var(--line); margin-bottom: 48px;\n  }\n  .topbar h1 { font-size: 32px; font-weight: 700; letter-spacing: -1px; }\n  .topbar .sub { font-size: 13px; color: var(--ink-3); margin-top: 6px; }\n  #logout-btn {\n    background: none; border: none; color: var(--ink-3); font-size: 14px;\n    cursor: pointer; padding: 6px 0;\n  }\n  #logout-btn:hover { color: var(--ink); }\n\n  /* 统计卡：极简数字排版 */\n  .cards {\n    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));\n    gap: 48px 24px; margin-bottom: 72px;\n  }\n  .card .label { font-size: 13px; color: var(--ink-3); font-weight: 400; margin-bottom: 8px; }\n  .card .value { font-size: 34px; font-weight: 600; letter-spacing: -1px; font-variant-numeric: tabular-nums; }\n  .card .unit { font-size: 14px; color: var(--ink-3); font-weight: 400; margin-left: 2px; }\n\n  /* 区块 */\n  .section { margin-bottom: 80px; }\n  .section-title { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; margin-bottom: 20px; }\n  .section-desc { font-size: 13px; color: var(--ink-3); margin: -14px 0 20px; }\n\n  /* 图表：极简网格线 */\n  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }\n  .chart-box { min-width: 0; }\n  .chart-box.wide { grid-column: 1 / -1; }\n  .chart-box h3 { font-size: 13px; color: var(--ink-3); font-weight: 500; margin-bottom: 12px; }\n\n  /* key 管理 */\n  .key-form { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }\n  .key-form input {\n    padding: 9px 14px; border: 1px solid var(--line); border-radius: 10px;\n    font-size: 14px; outline: none; font-family: inherit;\n  }\n  .key-form input:focus { border-color: var(--accent); }\n  .key-form .name { width: 180px; }\n  .key-form .quota { width: 160px; }\n  .key-form .models { width: 260px; }\n  .key-form button {\n    padding: 9px 22px; border: none; border-radius: 10px;\n    background: var(--ink); color: #fff; font-size: 14px; cursor: pointer;\n  }\n  .key-form button:hover { background: #333; }\n\n  table { width: 100%; border-collapse: collapse; font-size: 14px; }\n  th, td { text-align: left; padding: 12px 12px 12px 0; border-bottom: 1px solid var(--line); }\n  th { font-size: 12px; font-weight: 500; color: var(--ink-3); }\n  td { color: var(--ink); }\n  .key-value { font-family: \"SF Mono\", Menlo, monospace; font-size: 13px; color: var(--ink-2); }\n  .badge { font-size: 12px; }\n  .badge.on::before { content: \"● \"; color: #1d1d1f; }\n  .badge.off::before { content: \"● \"; color: #d2d2d7; }\n  .quota-num { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--ink-2); }\n  .op-link { color: var(--accent); cursor: pointer; font-size: 13px; margin-right: 14px; }\n  .op-link.danger { color: var(--danger); }\n  .op-link:hover { text-decoration: underline; }\n\n  /* 日志 */\n  .log-table { font-size: 13px; }\n  .log-table td { color: var(--ink-2); font-variant-numeric: tabular-nums; }\n  .status-ok { color: #1d1d1f; }\n  .status-err { color: var(--danger); }\n  .price-na { color: var(--ink-3); }\n  .source-tag { font-size: 12px; color: var(--ink-3); }\n  .num { font-variant-numeric: tabular-nums; }\n</style>\n</head>\n<body>\n<div class=\"container\">\n  <!-- 登录 -->\n  <div id=\"login-page\">\n    <h1>API&nbsp;Proxy</h1>\n    <input type=\"password\" id=\"login-key\" placeholder=\"管理密钥\" autocomplete=\"off\">\n    <button id=\"login-btn\">进入</button>\n    <div class=\"login-err\" id=\"login-err\"></div>\n  </div>\n\n  <!-- 主面板 -->\n  <div id=\"panel\">\n    <div class=\"topbar\">\n      <div>\n        <h1>API&nbsp;Proxy</h1>\n        <div class=\"sub\" id=\"meta-info\">—</div>\n      </div>\n      <button id=\"logout-btn\">退出</button>\n    </div>\n\n    <div class=\"cards\">\n      <div class=\"card\"><div class=\"label\">总请求</div><div class=\"value\" id=\"c-requests\">0</div></div>\n      <div class=\"card\"><div class=\"label\">总 Token</div><div class=\"value\" id=\"c-tokens\">0</div></div>\n      <div class=\"card\"><div class=\"label\">首字延迟（流式）</div><div class=\"value\" id=\"c-ttft\">—<span class=\"unit\">ms</span></div></div>\n      <div class=\"card\"><div class=\"label\">响应耗时（非流式）</div><div class=\"value\" id=\"c-lat\">—<span class=\"unit\">ms</span></div></div>\n      <div class=\"card\"><div class=\"label\">429</div><div class=\"value\" id=\"c-429\">0</div></div>\n      <div class=\"card\"><div class=\"label\">费用</div><div class=\"value\" id=\"c-cost\">$0</div></div>\n    </div>\n\n    <div class=\"section\">\n      <div class=\"charts\">\n        <div class=\"chart-box\">\n          <h3>请求量 / 分钟</h3>\n          <canvas id=\"chart-requests\"></canvas>\n        </div>\n        <div class=\"chart-box\">\n          <h3>Token / 分钟</h3>\n          <canvas id=\"chart-tokens\"></canvas>\n        </div>\n        <div class=\"chart-box wide\">\n          <h3>延迟 / 分钟 · 首字（流式）与总耗时（非流式）</h3>\n          <canvas id=\"chart-latency\"></canvas>\n        </div>\n      </div>\n    </div>\n\n    <div class=\"section\">\n      <div class=\"section-title\">API&nbsp;Key</div>\n      <div class=\"key-form\">\n        <input class=\"name\" id=\"new-key-name\" placeholder=\"名称\">\n        <input class=\"quota\" id=\"new-key-quota\" placeholder=\"额度 token（默认 1000000）\" type=\"number\">\n        <input class=\"models\" id=\"new-key-models\" placeholder=\"可选：限制模型（逗号分隔，留空不限）\">\n        <button id=\"create-key-btn\">新建</button>\n      </div>\n      <table>\n        <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>额度</th><th>剩余</th><th>模型</th><th>创建</th><th></th></tr></thead>\n        <tbody id=\"keys-tbody\"></tbody>\n      </table>\n    </div>\n\n    <div class=\"section\">\n      <div class=\"section-title\">最近请求</div>\n      <table class=\"log-table\">\n        <thead><tr><th>时间</th><th>模型</th><th>状态</th><th>TTFT</th><th>耗时</th><th>入</th><th>出</th><th>Key</th></tr></thead>\n        <tbody id=\"logs-tbody\"></tbody>\n      </table>\n    </div>\n\n    <div class=\"section\">\n      <div class=\"section-title\">模型价格 <span class=\"source-tag\" id=\"models-source\"></span></div>\n      <table>\n        <thead><tr><th>模型</th><th>提供商</th><th>输入</th><th>输出</th><th>备注</th></tr></thead>\n        <tbody id=\"models-tbody\"></tbody>\n      </table>\n    </div>\n  </div>\n</div>\n\n<script>\nconst $ = id => document.getElementById(id);\nlet adminKey = sessionStorage.getItem('apiProxyAdminKey') || '';\nconst charts = {};\n\nfunction initCharts() {\n  const grid = 'rgba(0,0,0,.06)';\n  Chart.defaults.color = '#86868b';\n  Chart.defaults.borderColor = 'transparent';\n  Chart.defaults.font.family = '-apple-system, \"Helvetica Neue\", \"PingFang SC\", sans-serif';\n  Chart.defaults.font.size = 11;\n\n  charts.requests = new Chart($('chart-requests'), {\n    type: 'bar',\n    data: { labels: [], datasets: [{ label: '请求', data: [], backgroundColor: 'rgba(0,0,0,.85)', barPercentage: .6 }] },\n    options: { responsive: true, plugins: { legend: { display: false } },\n      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid } } } }\n  });\n  charts.tokens = new Chart($('chart-tokens'), {\n    type: 'bar',\n    data: { labels: [], datasets: [\n      { label: '入', data: [], backgroundColor: 'rgba(0,0,0,.45)', barPercentage: .6 },\n      { label: '出', data: [], backgroundColor: 'rgba(0,0,0,.85)', barPercentage: .6 },\n    ]},\n    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8 } } },\n      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid } } } }\n  });\n  charts.latency = new Chart($('chart-latency'), {\n    type: 'line',\n    data: { labels: [], datasets: [\n      { label: 'TTFT', data: [], borderColor: '#1d1d1f', backgroundColor: 'rgba(0,0,0,.04)', tension: .3, pointRadius: 0 },\n      { label: '总耗时', data: [], borderColor: '#a1a1a6', backgroundColor: 'transparent', tension: .3, pointRadius: 0, borderDash: [4, 3] },\n    ]},\n    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8 } } },\n      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid } } } }\n  });\n}\n\nfunction fmtTokens(n) {\n  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';\n  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';\n  return String(n || 0);\n}\nfunction fmtTime(ts) {\n  if (!ts) return '—';\n  const d = new Date(ts);\n  const p = n => String(n).padStart(2, '0');\n  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;\n}\nfunction fmtCost(c) {\n  if (!c || c <= 0.0001) return '$0';\n  return '$' + (+c).toFixed(4);\n}\nfunction esc(s) {\n  return String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n}\n\nasync function api(path, opts = {}) {\n  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});\n  if (adminKey) headers['Authorization'] = 'Bearer ' + adminKey;\n  const resp = await fetch(path, Object.assign({ headers }, opts));\n  if (resp.status === 401) throw new Error('UNAUTHORIZED');\n  return resp.json();\n}\n\nasync function loadStats() {\n  try {\n    const d = await api('/admin/api/stats');\n    const t = d.totals || {};\n    $('c-requests').textContent = t.requests || 0;\n    $('c-tokens').textContent = fmtTokens(t.totalTokens);\n    $('c-ttft').textContent = d.avgTtft != null ? d.avgTtft : '—';\n    $('c-lat').textContent = d.avgLatency != null ? d.avgLatency : '—';\n    $('c-429').textContent = t.err429 || 0;\n    $('c-cost').textContent = fmtCost(t.cost);\n    $('meta-info').textContent = `运行 ${d.uptimeSec ? Math.round(d.uptimeSec / 60) : 0} 分钟 · ${(d.models || []).length} 个模型 · 最近 ${(d.logs || []).length} 条请求`;\n\n    const minutes = d.minutes || [];\n    const labels = minutes.map(m => m.t.slice(11));\n    charts.requests.data.labels = labels;\n    charts.requests.data.datasets[0].data = minutes.map(m => m.requests);\n    charts.requests.update('none');\n\n    charts.tokens.data.labels = labels;\n    charts.tokens.data.datasets[0].data = minutes.map(m => m.inputTokens);\n    charts.tokens.data.datasets[1].data = minutes.map(m => m.outputTokens);\n    charts.tokens.update('none');\n\n    charts.latency.data.labels = labels;\n    charts.latency.data.datasets[0].data = minutes.map(m => m.ttftAvg);\n    charts.latency.data.datasets[1].data = minutes.map(m => m.latencyAvg);\n    charts.latency.update('none');\n\n    renderLogs(d.logs || []);\n  } catch (e) {\n    if (e.message === 'UNAUTHORIZED') showLogin();\n  }\n}\n\nfunction renderLogs(logs) {\n  const tb = $('logs-tbody');\n  tb.innerHTML = logs.map(l => `\n    <tr>\n      <td>${fmtTime(l.ts)}</td>\n      <td>${esc(l.model || '—')}</td>\n      <td class=\"${l.status >= 400 ? 'status-err' : 'status-ok'}\">${l.status}</td>\n      <td class=\"num\">${l.ttft != null ? l.ttft + 'ms' : '—'}</td>\n      <td class=\"num\">${l.latency != null ? l.latency + 'ms' : '—'}</td>\n      <td class=\"num\">${fmtTokens(l.inputTokens)}</td>\n      <td class=\"num\">${fmtTokens(l.outputTokens)}</td>\n      <td>${esc(l.keyName || '—')}</td>\n    </tr>`).join('');\n}\n\nasync function loadKeys() {\n  try {\n    const d = await api('/admin/api/keys');\n    const tb = $('keys-tbody');\n    tb.innerHTML = (d.keys || []).map(k => `\n      <tr>\n        <td>${esc(k.name)}</td>\n        <td><span class=\"key-value\" title=\"点击复制\" onclick=\"copyKey('${k.key}')\">${k.key.slice(0, 18)}…</span></td>\n        <td><span class=\"badge ${k.enabled ? 'on' : 'off'}\">${k.enabled ? '启用' : '禁用'}</span></td>\n        <td class=\"num\">${fmtTokens(k.totalQuota)}</td>\n        <td class=\"num\">${fmtTokens(k.quota)}</td>\n        <td class=\"num\" style=\"max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap\">${k.models && k.models.length ? esc(k.models.join(', ')) : '<span class=\"price-na\">不限</span>'}</td>\n        <td class=\"num\">${fmtTime(k.createdAt)}</td>\n        <td style=\"text-align:right\">\n          <span class=\"op-link\" onclick=\"toggleKey('${k.key}', ${!k.enabled})\">${k.enabled ? '禁用' : '启用'}</span>\n          <span class=\"op-link danger\" onclick=\"delKey('${k.key}')\">删除</span>\n        </td>\n      </tr>`).join('');\n  } catch (e) { if (e.message === 'UNAUTHORIZED') showLogin(); }\n}\n\nasync function loadModels() {\n  try {\n    const d = await api('/admin/api/models');\n    const tb = $('models-tbody');\n    $('models-source').textContent = d.source === 'upstream' ? `· 来自端点 /v1/models（${d.count}）` : `· 内置价格表（端点不可达）`;\n    tb.innerHTML = (d.models || []).map(m => `\n      <tr>\n        <td>${esc(m.id)}</td>\n        <td>${esc(m.provider)}</td>\n        <td class=\"num\">${m.input != null ? '$' + m.input : '<span class=\"price-na\">—</span>'}</td>\n        <td class=\"num\">${m.output != null ? '$' + m.output : '<span class=\"price-na\">—</span>'}</td>\n        <td class=\"price-na\">${esc(m.note || '')}</td>\n      </tr>`).join('');\n  } catch (_) {}\n}\n\nfunction copyKey(k) { navigator.clipboard.writeText(k).then(() => alert('已复制')); }\nasync function toggleKey(key, enable) {\n  await api('/admin/api/keys/toggle', { method: 'POST', body: JSON.stringify({ key, enabled: enable }) });\n  loadKeys();\n}\nasync function delKey(key) {\n  if (!confirm('确定删除该 Key？')) return;\n  await api('/admin/api/keys/delete', { method: 'POST', body: JSON.stringify({ key }) });\n  loadKeys();\n}\n\nfunction showLogin() {\n  adminKey = ''; sessionStorage.removeItem('apiProxyAdminKey');\n  $('login-page').style.display = 'block'; $('panel').style.display = 'none';\n}\nfunction showPanel() {\n  $('login-page').style.display = 'none'; $('panel').style.display = 'block';\n  loadStats(); loadKeys(); loadModels();\n}\n\ndocument.addEventListener('DOMContentLoaded', () => {\n  initCharts();\n  $('login-btn').addEventListener('click', async () => {\n    const key = $('login-key').value.trim();\n    if (!key) return;\n    adminKey = key;\n    sessionStorage.setItem('apiProxyAdminKey', key);\n    try { await api('/admin/api/stats'); $('login-err').textContent = ''; showPanel(); }\n    catch (e) { $('login-err').textContent = '密钥无效'; }\n  });\n  $('login-key').addEventListener('keydown', e => { if (e.key === 'Enter') $('login-btn').click(); });\n  $('logout-btn').addEventListener('click', showLogin);\n  $('create-key-btn').addEventListener('click', async () => {\n    const name = $('new-key-name').value.trim();\n    const quota = parseInt($('new-key-quota').value, 10);\n    const modelsStr = $('new-key-models').value.trim();\n    if (!name) { alert('请输入名称'); return; }\n    await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({\n      name,\n      quota: quota > 0 ? quota : 1000000,\n      models: modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : null,\n    }) });\n    $('new-key-name').value = ''; $('new-key-quota').value = ''; $('new-key-models').value = '';\n    loadKeys();\n  });\n  if (adminKey) showPanel(); else showLogin();\n  setInterval(() => { if (adminKey && $('panel').style.display !== 'none') { loadStats(); loadKeys(); } }, 5000);\n});\n</script>\n</body>\n</html>\n";
    
  },
};
// core 模块立即工厂（无 require 依赖）
const __coreFactory = function() {
    // 平台无关核心：createHandler(config) → async (reqLike) => resLike
    // reqLike: { method, url, headers(对象或Headers实例), body(string|null) }
    // resLike: { status, headers(对象), chunks(异步迭代器|null, 流式), body(string|null, 非流式) }
    // 兼容 Vercel(Node req/res) 与 EdgeOne(Service Worker fetch)
    // ⚠️ 依赖必须用静态 require（Vercel 静态追踪绕过变量路径），EdgeOne 由打包脚本替换为 __requireModule
    
    const store = __requireModule('lib/store.js');
    const { MODELS, lookupModel } = __requireModule('lib/models.js');
    const adminHtml = __requireModule('lib/admin-page.js');
    
    return function createHandler(config) {
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
};

// 环境变量解析：EdgeOne 通过 event.env 或全局 env
function resolveEnv(event) {
  const e = (event && event.env) || globalThis.env || {};
  const get = (k) => {
    if (e && typeof e.get === 'function') { const v = e.get(k); if (v != null) return v; }
    return e[k] != null ? e[k] : undefined;
  };
  const raw = get('API_KEYS') || get('KEYS') || '';
  return {
    API_KEYS: String(raw).split(',').map(s => s.trim()).filter(Boolean),
    BASE_URL: get('BASE_URL') || 'https://api.openai.com',
    ADMIN_KEY: get('ADMIN_KEY') || get('YOUR_VERCEL_APP_API_KEY') || '',
    RPM: get('RPM'),
    COOLDOWN_MS: get('COOLDOWN_MS'),
  };
}

addEventListener('fetch', (event) => {
  event.respondWith(handle(event));
});

async function handle(event) {
  const request = event.request;
  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try { body = await request.text(); } catch (_) { body = null; }
  }
  const reqLike = {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
  };
  const handler = __coreFactory();
  const result = await handler(reqLike, { env: resolveEnv(event) });

  if (result.stream) {
    // 流式：包装成 ReadableStream 响应（SSE 首 token 即到即转）
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(stream, { status: result.status, headers: result.headers });
  }
  return new Response(result.body || '', { status: result.status, headers: result.headers });
}

function indent(src, n) {
  const pad = ' '.repeat(n);
  return src.split('\n').map(l => pad + l).join('\n');
}
