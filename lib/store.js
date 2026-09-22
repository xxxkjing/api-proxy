// 内存存储：管理用 API key、分钟级统计、最近请求日志（环形缓冲）
// 持久化：云端 GitHub 私有仓库（lib/cloud-store.js），无数据库、无本地文件、零用户配置
// 数据分层：热数据 store.json（覆盖写）+ 日志 logs/YYYY-MM-DD.json（按天归档，只追加不删）

const crypto = require("crypto");
const fs = require("node:fs");
const path = require("node:path");
const cloud = require("./cloud-store");

// ---- 生成的客户端 key（sk-xxx，带额度）----
let clientKeys = new Map(); // key -> { name, key, quota (剩余 token), totalQuota, createdAt, enabled }

// ---- 统计 ----
// 分钟级桶：{ "yyyy-mm-ddTHH:MM" -> { requests, err429, ttftSum, ttftCount, latSum, latCount, inputTokens, outputTokens, costSum } }
let minuteBuckets = new Map();
// 模型维度：{ model -> { requests, inputTokens, outputTokens, cost } }
let modelStats = new Map();
// 最近请求日志（环形，保留 MAX_LOGS 条，仅用于面板"最近"展示；完整历史在云端归档）
const MAX_LOGS = 500;
let requestLogs = [];

// 服务启动时间（用于 uptime）
const startedAt = Date.now();

// ---- 持久化（云端 + 可选本地文件） ----
let _saveTimer = null;
let loaded = false;       // load 是否已完成（仅用于日志/诊断，不再阻塞 saveNow）

// 本地文件持久化（本地长期运行用，DATA_FILE 设置后启用；不依赖 Vercel Blob）
const LOCAL_DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : "";

function localEnabled() {
  return !!LOCAL_DATA_FILE;
}

function localSave() {
  if (!localEnabled()) return;
  try {
    fs.mkdirSync(path.dirname(LOCAL_DATA_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(buildHotPayload(), null, 2));
  } catch (e) {
    console.error("[store] local save failed:", e.message);
  }
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveNow(); localSave(); }, 300);
}

function buildHotPayload() {
  return {
    clientKeys: Array.from(clientKeys.values()),
    minuteBuckets: Array.from(minuteBuckets.entries()),
    modelStats: Array.from(modelStats.entries()),
    requestLogs,
    savedAt: Date.now(),
  };
}

// 写热数据快照到云端（fire-and-forget）
// 注意：不再依赖 loaded（Vercel serverless 多实例下 load 可能超时/未完成，
//       但 writeJson 有 sha 乐观锁 + 409 重试，直接写也安全）
function saveNow() {
  if (!cloud.isEnabled()) return;
  const payload = buildHotPayload();
  cloud.writeJson("store.json", payload).catch(e => {
    console.error("[store] cloud save failed:", e.message);
  });
}

// 当日日志归档：追加到云端 logs/YYYY-MM-DD.json（只追加不删，实现长期保存）
let _pendingLogs = [];
let _logTimer = null;
function queueArchiveLog(entry) {
  if (!cloud.isEnabled()) return;
  _pendingLogs.push(entry);
  if (_logTimer) return;
  _logTimer = setTimeout(async () => {
    _logTimer = null;
    const batch = _pendingLogs;
    _pendingLogs = [];
    if (!batch.length) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    cloud.appendLogs(dateStr, batch).catch(e => {
      console.error("[store] cloud archive failed:", e.message);
    });
  }, 5000); // 5 秒攒批，减少 GitHub API 调用频率
}

// 启动时从云端加载热数据（合并而非覆盖，避免丢失 load 期间新增的数据）
// 加超时保护：Vercel 函数环境 GitHub API 可能慢，load 卡住不应阻塞业务
async function load() {
  let payload = null;

  // 本地文件优先（本地长期运行，不依赖 Blob）
  if (localEnabled()) {
    try {
      if (fs.existsSync(LOCAL_DATA_FILE)) {
        payload = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, "utf8"));
        console.log(`[store] local loaded from ${LOCAL_DATA_FILE}`);
      }
    } catch (e) {
      console.error("[store] local load failed:", e.message);
    }
  }

  if (!payload && cloud.isEnabled()) {
    try {
      // 5 秒超时保护
      payload = await Promise.race([
        cloud.readJson("store.json"),
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
    } catch (e) {
      console.error("[store] cloud load failed:", e.message);
    }
  }

  if (payload) {
    try {
      // 合并 clientKeys：云端有、内存没有 → 加进来；内存有的保留（更新）
      if (Array.isArray(payload.clientKeys)) {
        for (const r of payload.clientKeys) {
          if (!clientKeys.has(r.key)) clientKeys.set(r.key, r);
        }
      }
      // 合并 minuteBuckets：只补云端有、内存没有的分钟桶
      if (Array.isArray(payload.minuteBuckets)) {
        for (const [k, v] of payload.minuteBuckets) {
          if (!minuteBuckets.has(k)) minuteBuckets.set(k, v);
        }
      }
      // 合并 modelStats
      if (Array.isArray(payload.modelStats)) {
        for (const [k, v] of payload.modelStats) {
          const existing = modelStats.get(k);
          if (!existing) modelStats.set(k, v);
          else Object.assign(existing, v); // 合并字段
        }
      }
      // requestLogs：只补云端有、内存没有的（按 ts 去重）
      if (Array.isArray(payload.requestLogs)) {
        const existingTs = new Set(requestLogs.map(l => l.ts));
        for (const l of payload.requestLogs) {
          if (!existingTs.has(l.ts)) requestLogs.push(l);
        }
        if (requestLogs.length > MAX_LOGS) requestLogs.splice(0, requestLogs.length - MAX_LOGS);
      }
      console.log(`[store] merged ${clientKeys.size} keys, ${minuteBuckets.size} buckets, ${requestLogs.length} logs`);
    } catch (e) {
      console.error("[store] merge failed:", e.message);
    }
  } else {
    console.log("[store] no persisted data (fresh start)");
  }
  loaded = true;
}
// 异步加载，不阻塞启动
load().catch(e => console.error("[store] init load error:", e.message));

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
  const { estimateCost } = require("./models");
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
  const logEntry = { ts, model, status, ttft, latency, inputTokens, outputTokens, keyName, cost };
  requestLogs.push(logEntry);
  if (requestLogs.length > MAX_LOGS) requestLogs.splice(0, requestLogs.length - MAX_LOGS);
  queueArchiveLog(logEntry); // 云端按天归档（只追加，长期保存）

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
    // 诊断字段
    _diag: {
      cloudEnabled: cloud.isEnabled(),
      loaded,
      pendingLogs: _pendingLogs.length,
      hasGITHUB_TOKEN: !!(process.env.GITHUB_TOKEN || process.env.GITHUB_PAT),
      githubTokenPrefix: (process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || "").slice(0, 8),
      lastWrite: cloud.getLastWrite(),
      nodeEnv: process.env.NODE_ENV || 'unknown',
    },
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