// 内存存储：管理用 API key、分钟级统计、最近请求日志（环形缓冲）
// 持久化：变更防抖写入 DATA_FILE（默认 data/store.json），启动时自动加载
// ⚠️ 若部署在只读文件系统（如部分 serverless），可设 DATA_FILE=/tmp/store.json 或 /dev/shm/store.json

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "data", "store.json");

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
  return prefix + crypto.randomBytes(24).toString("hex");
}

function createClientKey({ name = "unnamed", quota = 1000000 } = {}) {
  const key = generateKey();
  const rec = {
    name: String(name),
    key,
    quota: Number(quota),
    totalQuota: Number(quota),
    createdAt: Date.now(),
    enabled: true,
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