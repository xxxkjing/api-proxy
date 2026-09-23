// 云端持久化：Vercel Blob Storage（私有存储）
// 无数据库、无本地存储、零 npm 依赖（直接 HTTP API，避免 SDK import 失败）
// 数据策略（覆盖写平替数据库）：
//   - 唯一数据文件：store.json（keys / 统计 / 最近日志），每次覆盖写整个文件
//   - 不产生追加型日志文件（logs/YYYY-MM-DD.json 已废弃）——避免 Blob 无限膨胀
//
// 环境变量：
//   BLOB_STORE_ID          Vercel Blob Store ID
//   BLOB_READ_WRITE_TOKEN  Vercel Blob 读写 token

const BLOB_API = "https://blob.vercel-storage.com";

let _diag = { lastWrite: { ok: false, error: "", path: "", ts: 0 } };

function getEnv() {
  return {
    storeId: process.env.BLOB_STORE_ID || "",
    token: process.env.BLOB_READ_WRITE_TOKEN || "",
  };
}

function isEnabled() {
  const e = getEnv();
  return !!(e.storeId && e.token);
}

function getLastWrite() {
  return _diag.lastWrite;
}

async function _request(method, pathname, body) {
  const env = getEnv();
  const url = `${BLOB_API}/${pathname}`;
  const headers = {
    Authorization: `Bearer ${env.token}`,
    "x-blob-store-id": env.storeId,
    "x-vercel-blob-access": "private",
    "User-Agent": "api-proxy",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, { method, headers, body });
  return resp;
}

/**
 * 读取 JSON
 */
async function readJson(pathname) {
  if (!isEnabled()) return null;
  try {
    const resp = await _request("GET", pathname);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      console.error("[blob] read", pathname, "HTTP", resp.status);
      return null;
    }
    const text = await resp.text();
    return JSON.parse(text);
  } catch (e) {
    console.error("[blob] read", pathname, "error:", e.message);
    return null;
  }
}

/**
 * 写入 JSON（覆盖写 + read-merge-write 防并发覆盖）
 */
async function writeJson(pathname, obj) {
  if (!isEnabled()) {
    _diag.lastWrite = { ok: false, error: "not enabled", path: pathname, ts: Date.now() };
    return false;
  }

  // read-merge-write：先读云端当前数据，合并本地新增项，再写回
  let merged = obj;
  if (pathname === "store.json") {
    try {
      const existing = await readJson(pathname);
      if (existing && Array.isArray(existing.clientKeys) && Array.isArray(obj.clientKeys)) {
        const localKeys = new Map(obj.clientKeys.map(k => [k.key, k]));
        for (const k of existing.clientKeys) {
          if (!localKeys.has(k.key)) localKeys.set(k.key, k);
        }
        merged = { ...obj, clientKeys: Array.from(localKeys.values()) };
      }
    } catch (e) {
      // 合并失败不致命
    }
  }

  try {
    const resp = await _request("PUT", pathname, JSON.stringify(merged));
    if (resp.ok) {
      _diag.lastWrite = { ok: true, error: "", path: pathname, ts: Date.now() };
      return true;
    }
    _diag.lastWrite = { ok: false, error: `HTTP ${resp.status}`, path: pathname, ts: Date.now() };
    console.error("[blob] write", pathname, "HTTP", resp.status);
    return false;
  } catch (e) {
    _diag.lastWrite = { ok: false, error: e.message, path: pathname, ts: Date.now() };
    console.error("[blob] write", pathname, "error:", e.message);
    return false;
  }
}

/**
 * 追加日志归档（已废弃）
 * 防止 Blob 无限膨胀：不再按天 append。日志只随 store.json 覆盖写保留最近 MAX_LOGS 条。
 * 保留空实现避免调用方崩溃（store.js 已不再调用）。
 */
async function appendLogs(dateStr, entries) {
  return false;
}

module.exports = { isEnabled, readJson, writeJson, appendLogs, getLastWrite };